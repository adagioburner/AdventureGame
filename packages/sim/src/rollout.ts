import type { GameConfig } from '@adventure/config';
import {
  activePlayer,
  applyAction,
  poiRuntimeAt,
  previewPath,
  shortestPath,
  unclaimedGoldUnits,
  type DiceSource,
  type GameState,
  type NodeId,
  type PathPreview,
  type PlayerId,
  type PlayerState,
  type Rng,
  type TurnAction,
} from '@adventure/core';
import { chooseWalkTarget } from './candidates.ts';

/**
 * [SOURCE §5, chat] §9's rollout policy: "choose a random target among the
 * `CLOSE_CANDIDATE_COUNT` closest POIs, using the same weighted-terrain-cost
 * random-walk code as §5.1."
 *
 * The shared part is `candidates.ts` (rank by weighted cost, pick uniformly
 * among the K closest). What a rollout does differently is advance through the
 * *real* rules: a chosen target is walked toward with `applyAction`,
 * respecting movement allowance and stamina (§7), triggering automatic POI
 * interaction and guard rolls (§8) on arrival, and taking as many turns as
 * that needs.
 *
 * [SOURCE §9, chat] "During MCTS rollout moves are simulated for all players,
 * AI and human." So every seat is driven by this one policy — there is no
 * separate opponent model, and the earlier `OpponentRolloutPolicy` seam is
 * gone. The rollout simply plays whichever seat is active, in turn order, until
 * it terminates.
 *
 * [SOURCE §9, chat] Choosing a target is a **macro-action**: "the simulated
 * player keeps moving to the chosen POI without making new decision until it's
 * reached or claimed by a different player." See `macroAdvanceToTarget`.
 *
 * The rollout has its own loop rather than `runWalk`'s (Q25, and the four
 * reasons in docs/IMPLEMENTATION_PLAN.md phase 5): a leg here can end without
 * reaching its target, costs whatever the real turns cost rather than the
 * Dijkstra estimate, and records nothing. `walk.ts` is remoteness's loop alone.
 */
export interface RolloutCursor {
  readonly state: GameState;
  /** Whose gold the backpropagated value is read from (§9). */
  readonly subject: PlayerId;
  /**
   * The POI each seat is committed to, in seat order (`targets[seat - 1]`), or
   * `null` for a seat that picks a new one on its next turn. Every seat is
   * simulated, so every seat carries its own macro-action across the turns of
   * the others.
   */
  readonly targets: readonly (NodeId | null)[];
}

/** A cursor at `state` with no seat committed to anything yet. */
export function rolloutCursor(state: GameState, subject: PlayerId): RolloutCursor {
  return { state, subject, targets: state.players.map(() => null) };
}

/**
 * When a rollout stops.
 *
 * [SOURCE §9, chat] "The rollout stops when there is no gold rewards left on
 * the map." Since §1 makes gold the only thing anyone wins with, a state with
 * none left is decided, and simulating the tail where players hoover up the
 * remaining skill and stamina POIs buys the search nothing. Note that is the
 * rule — **not** "all POIs claimed": a rollout ends with skill and stamina POIs
 * still on the map, which is the point, and saves real time against the
 * 10-second budget.
 *
 * `goldExhaustedTermination` also stops on a finished game, which the engine
 * imposes rather than the designer: §1's win condition can fire *earlier* than
 * gold exhaustion, when a leader's lead already exceeds what is left. At that
 * point the game is over and there is nothing further to simulate. Gold
 * exhaustion implies a finished game (a tie resolves once nothing remains to
 * break it, §1 chat), so in practice the first clause is the one that bites.
 *
 * Kept behind an interface because it is also the obvious lever if rollouts
 * prove too slow — a turn or depth cap is the usual mitigation, and it would
 * change what the backpropagated value means, so it is not applied
 * pre-emptively.
 *
 * `turnsTaken` counts the turns this rollout has played so far, every seat's.
 */
export interface RolloutTermination {
  isTerminal(cursor: RolloutCursor, turnsTaken: number): boolean;
}

/** The specified terminal test: no unclaimed gold left, or the game is over. */
export function goldExhaustedTermination(): RolloutTermination {
  return {
    isTerminal(cursor: RolloutCursor): boolean {
      if (cursor.state.status === 'finished') return true;
      return unclaimedGoldUnits(cursor.state) === 0;
    },
  };
}

/**
 * A turn cap on top of another termination, counted from the position the
 * search is thinking about: `startTurn` is that position's turn number.
 *
 * [SOURCE §9, review] Andrei, 2026-09-24 (Q44): "we can end the simulation
 * after 250 turns and give the victory to whatever player has more gold." It
 * exists for Q30's position, where the gold left is behind guards nobody can
 * beat and nothing else would ever stop a simulated game. A capped game is
 * scored like any other — the simulated evaluation reads the subject's gold —
 * so whoever holds more gold at the cap comes out ahead.
 */
export function turnCapTermination(inner: RolloutTermination, startTurn: number, cap: number): RolloutTermination {
  return {
    isTerminal(cursor: RolloutCursor, turnsTaken: number): boolean {
      return cursor.state.turn.number - startTurn >= cap || inner.isTerminal(cursor, turnsTaken);
    },
  };
}

/**
 * Whether a player heading for a target spends this turn resting instead of
 * walking. Given the route to the target and this turn's preview of it.
 *
 * §9 says a simulated player keeps moving to its POI, and nothing about when
 * it rests; stamina runs out often, so the rollout needs a rule. Injected so
 * tests can fix one; `restWhenStuck()` is the designer's.
 */
export interface RestRule {
  readonly name: string;
  restsInstead(state: GameState, player: PlayerState, route: readonly NodeId[], preview: PathPreview): boolean;
}

/**
 * [SOURCE §9, review] Andrei, 2026-09-24 (Q43): a player heading for a target
 * "rests on any turn it cannot take a single step towards its target, then
 * carries on to the same target". Otherwise it walks as far as the turn
 * affords. The computer's real move follows the same rule.
 */
export function restWhenStuck(): RestRule {
  return {
    name: 'rest-when-stuck',
    restsInstead: (_state, _player, _route, preview) => preview.reachableStepCount === 0,
  };
}

export interface RolloutOptions {
  readonly config: GameConfig;
  readonly termination: RolloutTermination;
  readonly restRule: RestRule;
  readonly dice: DiceSource;
  readonly rng: Rng;
}

/** Which POIs a rollout may target: those whose reward is still unclaimed (§4.5). */
export function unclaimedPoiNodes(state: GameState): ReadonlySet<NodeId> {
  const nodes = new Set<NodeId>();
  for (let index = 0; index < state.map.pois.length; index++) {
    const poi = state.map.pois[index];
    if (poi === undefined) continue;
    if (state.poiRuntime[index]?.claimedBy === null) nodes.add(poi.node);
  }
  return nodes;
}

/**
 * The active player's turn toward `target`: the whole cheapest route (the one
 * metric, §5.1), which §7 walks as far as this turn affords. Standing on the
 * target already is the empty path, which §8 makes another roll at its guard.
 * Otherwise `restRule` may turn the turn into a rest.
 *
 * This is also the computer's real move once the search has chosen a target,
 * so the tree and the rollout take a step the same way.
 */
export function turnTowards(state: GameState, target: NodeId, restRule: RestRule): TurnAction {
  const player = activePlayer(state);
  const config = state.map.ruleset.config;
  const route = shortestPath(state.map.graph, player.position, target, config);
  if (route === null) throw new RangeError(`no route from ${player.position} to ${target}`);
  if (route.length === 0) return { kind: 'move', player: player.id, path: route, waypoint: null };

  const preview = previewPath(state.map.graph, player.position, route, state.turn.allowance, player.stats.stamina, config);
  if (restRule.restsInstead(state, player, route, preview)) return { kind: 'rest', player: player.id };
  return { kind: 'move', player: player.id, path: route, waypoint: null };
}

/** Why a macro-action stopped. */
export type MacroAdvanceOutcome =
  | 'arrived'
  | 'target_claimed_by_other'
  | 'terminal';

/**
 * Play the active seat's turn under the rollout policy, and return the cursor
 * after it.
 *
 * A seat with no commitment picks one uniformly among the K closest unclaimed
 * POIs (`chooseWalkTarget`, shared with §5.1). After the turn, a commitment
 * lapses for whoever has arrived at theirs and for anyone whose target someone
 * has just claimed; everyone else keeps theirs.
 */
export function playRolloutTurn(cursor: RolloutCursor, options: RolloutOptions): RolloutCursor {
  const state = cursor.state;
  const player = activePlayer(state);
  const index = player.seat - 1;

  let target = cursor.targets[index] ?? null;
  if (target === null) {
    const choice = chooseWalkTarget(state.map.graph, player.position, unclaimedPoiNodes(state), options.config, options.rng);
    // No unclaimed POI means no unclaimed gold, which every termination stops
    // on first; reaching here is a caller bug, not a position.
    if (choice === null) throw new RangeError('a rollout turn with no unclaimed POI left to head for');
    target = choice.node;
  }

  const action = turnTowards(state, target, options.restRule);
  const next = applyAction(state, action, options.dice).state;
  const arrived = action.kind === 'move' && next.players[index]?.position === target;

  const targets = cursor.targets.map((committed, at) => {
    const current = at === index ? target : committed;
    if (current === null) return null;
    if (at === index && arrived) return null;
    return poiRuntimeAt(next, current)?.claimedBy === null ? current : null;
  });
  return { state: next, subject: cursor.subject, targets };
}

/**
 * Walk the active player toward `target` across as many turns as it takes,
 * making no new decision on the way.
 *
 * [SOURCE §9, chat] "The simulated player keeps moving to the chosen POI
 * without making new decision until it's reached or claimed by a different
 * player." So it ends on exactly three conditions:
 *
 *   `arrived`                 — the player reached the POI (and §8's automatic
 *                               interaction has resolved);
 *   `target_claimed_by_other` — another player claimed it first, so the
 *                               commitment lapses and the caller picks again;
 *   `terminal`                — the game finished mid-journey.
 *
 * Every turn in between goes through `applyAction`, so allowance, stamina,
 * guard rolls and turn order all apply exactly as in a real game — and the
 * other seats take their own turns in between, under the rollout policy, since
 * all players are simulated.
 *
 * This is one macro-action = one tree edge, which is why the tree stays shallow
 * enough to be searched in ten seconds: a node is a real decision point rather
 * than a single step. The returned cursor is the one right after the turn that
 * ended it.
 */
export function macroAdvanceToTarget(
  cursor: RolloutCursor,
  target: NodeId,
  options: RolloutOptions,
): { readonly cursor: RolloutCursor; readonly outcome: MacroAdvanceOutcome } {
  const mover = activePlayer(cursor.state);
  const index = mover.seat - 1;
  let current: RolloutCursor = {
    ...cursor,
    targets: cursor.targets.map((committed, at) => (at === index ? target : committed)),
  };

  for (let turns = 0; ; turns++) {
    if (options.termination.isTerminal(current, turns)) return { cursor: current, outcome: 'terminal' };
    const moving = activePlayer(current.state).id === mover.id;
    current = playRolloutTurn(current, options);
    if (current.targets[index] !== null) continue;
    const claimedBy = poiRuntimeAt(current.state, target)?.claimedBy ?? null;
    if (claimedBy !== null && claimedBy !== mover.id) return { cursor: current, outcome: 'target_claimed_by_other' };
    if (moving) return { cursor: current, outcome: 'arrived' };
  }
}

/**
 * Play other seats' rollout turns until it is `player`'s turn again, or the
 * rollout is over. A tree node is a decision point of its subject, so after a
 * macro-action the tree hands the move round to the subject this way.
 */
export function playUntilTurnOf(cursor: RolloutCursor, player: PlayerId, options: RolloutOptions): RolloutCursor {
  let current = cursor;
  for (let turns = 0; ; turns++) {
    if (options.termination.isTerminal(current, turns)) return current;
    if (activePlayer(current.state).id === player) return current;
    current = playRolloutTurn(current, options);
  }
}

/**
 * Run one rollout and return the terminal cursor.
 *
 * [SOURCE §5, chat] "Backpropagated value: the simulated player's gold amount
 * after rollout, by default." The "by default" is why this returns the state
 * rather than a number — evaluating it is a separate, swappable concern; see
 * `NodeEvaluator` in `@adventure/ai`.
 */
export function runRollout(start: RolloutCursor, options: RolloutOptions): RolloutCursor {
  let current = start;
  for (let turns = 0; !options.termination.isTerminal(current, turns); turns++) {
    current = playRolloutTurn(current, options);
  }
  return current;
}
