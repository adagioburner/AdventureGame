import type { GameConfig } from '@adventure/config';
import {
  activePlayer,
  applyAction,
  applyCountedTurn,
  bestRoute,
  countWalk,
  poiRuntimeAt,
  previewPath,
  routeTable,
  unclaimedGoldUnits,
  type DiceSource,
  type GameState,
  type Guard,
  type NodeId,
  type PlayerId,
  type PlayerState,
  type PlayerStats,
  type Poi,
  type PoiRuntimeState,
  type Rng,
  type TurnAction,
} from '@adventure/core';
import { chooseWalkTarget, closestPoiCandidates, type PoiCandidate } from './candidates.ts';
import type { TargetPicker } from './goldByProgress.ts';
import { siteOrderBySpeeds, type ClosestFinder } from './speeds.ts';

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
 *
 * [Q210] Stage 3 of Andrei's plan, 2026-10-02: "Switch simulated games to the
 * strategy above", a player's arrival worked out from its route rather than
 * walked out turn by turn. A player walks the best route for its speeds,
 * traced once when it picks its target (823 A), and each turn is counted
 * along it (`countWalk`) and played with `applyCountedTurn`, which fights
 * or takes an unclaimed site where a turn ends, its target or another on the
 * way, as `applyAction` does. The figure stands where the count puts it after
 * every turn, so the game is the one `applyAction` would have played along
 * that route. Which sites it picks among is as before (822 B).
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
  /**
   * [Q210, 823 A] The route each seat is walking to its target, in seat
   * order, or `null` for a seat that traces one when it next moves. A walk
   * that is not for the seat's target, or does not continue from where it
   * stands, is traced again.
   */
  readonly walks: readonly (RouteWalk | null)[];
}

/** [Q210, 823 A] A route an imagined player walks, traced once when it heads for `target`. */
export interface RouteWalk {
  readonly target: NodeId;
  /** Where the player stood when the route was traced. */
  readonly from: NodeId;
  /** The route, excluding `from`. */
  readonly route: readonly NodeId[];
  /** How many of its steps are walked. */
  readonly walked: number;
}

/** A cursor at `state` with no seat committed to anything yet. */
export function rolloutCursor(state: GameState, subject: PlayerId): RolloutCursor {
  return { state, subject, targets: state.players.map(() => null), walks: state.players.map(() => null) };
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
  // Asked after every imagined turn, and the sites change only when one is
  // claimed (`poiRuntime` is replaced then and never altered), so the answer
  // is kept until they do.
  let sites: GameState['poiRuntime'] | null = null;
  let map: GameState['map'] | null = null;
  let exhausted = false;
  return {
    isTerminal(cursor: RolloutCursor): boolean {
      const state = cursor.state;
      if (state.status === 'finished') return true;
      if (state.poiRuntime !== sites || state.map !== map) {
        sites = state.poiRuntime;
        map = state.map;
        exhausted = unclaimedGoldUnits(state) === 0;
      }
      return exhausted;
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
 * walking. Given how many steps of its route this turn would walk.
 *
 * §9 says a simulated player keeps moving to its POI, and nothing about when
 * it rests; stamina runs out often, so the rollout needs a rule. Injected so
 * tests can fix one; `restWhenStuck()` is the designer's.
 */
export interface RestRule {
  readonly name: string;
  restsInstead(state: GameState, player: PlayerState, steps: number): boolean;
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
    restsInstead: (_state, _player, steps) => steps === 0,
  };
}

export interface RolloutOptions {
  readonly config: GameConfig;
  readonly termination: RolloutTermination;
  readonly restRule: RestRule;
  readonly dice: DiceSource;
  readonly rng: Rng;
  /** Which POIs a player may head for; every unclaimed one when absent. The game's computer passes `winnableBySkill` (Q295). */
  readonly targets?: TargetFilter;
  /** Which of those count as closest; by weighted terrain cost when absent (the computer player passes `closestBySpeeds`, Q112). */
  readonly closest?: ClosestFinder;
  /**
   * `targets` and `closest` as one pass, when given, in place of both: the
   * game's computer passes `closestWinnableBySpeeds`, which finds what
   * `winnableBySkill` and `closestBySpeeds` find without listing every site
   * first. A player it finds no site for rests.
   */
  readonly candidates?: CandidateFinder;
  /** Which of the closest a player heads for; uniformly at random when absent. The game's computer passes `goldByProgressPicker` (Q290). */
  readonly pick?: TargetPicker;
  /**
   * [Q210] How a player walks to its target: counted along its route, as the
   * game plays since stage 3, when absent; `replayed` walks the cheapest
   * route turn by turn through `applyAction`, as before it, for comparison.
   */
  readonly walks?: 'counted' | 'replayed';
  /** The route a counted walk follows; the best for the player's speeds when absent, as the game plays. */
  readonly walkRoute?: RouteChoice;
}

/** Which POIs `player` may head for in `state`. */
export type TargetFilter = (state: GameState, player: PlayerState) => ReadonlySet<NodeId>;

/** The `count` closest of the POIs `player` may head for in `state`, nearest first: a `TargetFilter` and a `ClosestFinder` in one. */
export type CandidateFinder = (state: GameState, player: PlayerState, count: number) => readonly PoiCandidate[];

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
 * [Q295] Whether `player` could beat `guard` on some roll with `units` more of
 * its skill: the die's best roll plus the skill and the units is above the
 * guard's strength (§8: the roll plus the skill must be above the guard). An
 * unguarded site is always won.
 */
export function winsOnSomeRoll(state: GameState, player: PlayerState, guard: Guard | null, units = 0): boolean {
  return winsWithRoll(bestRoll(state), player.stats, guard, units);
}

/** The die's best roll (§8's `GUARD_DIE`): every pip on every die. */
function bestRoll(state: GameState): number {
  const { count, sides } = state.map.ruleset.config.combat.GUARD_DIE;
  return count * sides;
}

/** `winsOnSomeRoll` with the best roll in hand: the roll plus the skill and the units is above the guard's strength (§8), or there is no guard. */
function winsWithRoll(roll: number, stats: PlayerStats, guard: Guard | null, units: number): boolean {
  return guard === null || roll + stats[guard.type] + units > guard.strength;
}

/** [Q295] Unclaimed POIs `player` could win on some roll with `units` more of the guard's skill (`winsOnSomeRoll`). */
export function winnablePoiNodesWith(state: GameState, player: PlayerState, units: number): ReadonlySet<NodeId> {
  const nodes = new Set<NodeId>();
  for (let index = 0; index < state.map.pois.length; index++) {
    const poi = state.map.pois[index];
    if (poi === undefined || state.poiRuntime[index]?.claimedBy !== null) continue;
    if (winsOnSomeRoll(state, player, poi.guard, units)) nodes.add(poi.node);
  }
  return nodes;
}

/**
 * [Q295] Which sites the players in the computer's imagined games head for:
 * those they could win with the skill they hold, since they never buy (Q280,
 * 984). With none left they rest (`playRolloutTurn`).
 *
 * [SOURCE §9, chat] Andrei, 2026-10-09: "if skipping in imagined games
 * actually speeds them up, let us use it in all games, computer's and
 * imagined", with the skill alone, and rest when nothing is left to win.
 */
export const winnableBySkill: TargetFilter = (state, player) => winnablePoiNodesWith(state, player, 0);

/**
 * `closestBySpeeds` over `winnableBySkill`'s sites, in one pass over the
 * map's sites: exactly the candidates those two find, the same sites in the
 * same order, without the set of every winnable site built first. The
 * players in the games the computer imagines pick a site tens of thousands
 * of times a move, so the game's computer passes it as `candidates`.
 */
export const closestWinnableBySpeeds: CandidateFinder = (state, player, count) => {
  if (count <= 0) return [];
  const map = state.map;
  const pois = map.pois;
  const sites = state.poiRuntime;
  const stats = player.stats;
  const roll = bestRoll(state);
  const { order, start, end } = siteOrderBySpeeds(map, player.position, stats);
  const costs = routeTable(map.graph, map.ruleset.config).from(player.position).costs;
  const found: PoiCandidate[] = [];
  for (let at = start; at < end && found.length < count; at++) {
    const index = order[at] as number;
    if ((sites[index] as PoiRuntimeState).claimedBy !== null) continue;
    const poi = pois[index] as Poi;
    if (winsWithRoll(roll, stats, poi.guard, 0)) found.push({ node: poi.node, cost: costs[poi.node] as number });
  }
  return found;
};

/**
 * Unclaimed POIs `player` could win now: every unguarded one, and guarded gold
 * whose guard the die's best roll plus the player's skill beats (§8: roll +
 * skill > strength). When that leaves nothing, every unclaimed POI, so a
 * player never runs out of somewhere to go while gold is left.
 *
 * For comparison only (detail 419, Andrei 2026-09-30: leave gold nobody can win
 * yet out of the computer's choices, tested on its own). The game's computer
 * players skip such gold by Q295's rules instead: `winnableBySkill` in the
 * games they imagine, and `closestUnclaimedPoiEnumerator`'s in their own choices.
 */
export function winnablePoiNodes(state: GameState, player: PlayerState): ReadonlySet<NodeId> {
  const nodes = winnablePoiNodesWith(state, player, 0);
  return nodes.size > 0 ? nodes : unclaimedPoiNodes(state);
}

/** Which route a player takes to a target: the whole route, excluding where they stand. */
export type RouteChoice = (state: GameState, player: PlayerState, target: NodeId) => readonly NodeId[] | null;

/** The cheapest route by weighted terrain cost (the one metric, §5.1), the one `shortestPath` gives. */
export const cheapestRoute: RouteChoice = (state, player, target) =>
  routeTable(state.map.graph, state.map.ruleset.config).path(player.position, target);

/** [Q210] The best route for the player's speeds (`bestRoute`). */
export const bestRouteForSpeeds: RouteChoice = (state, player, target) =>
  bestRoute(state.map.graph, player.position, target, player.stats, state.map.ruleset.config);

/**
 * The active player's turn toward `target`: the whole route `routeOf` picks,
 * which §7 walks as far as this turn affords. Standing on the target already
 * is the empty path, which §8 makes another roll at its guard. Otherwise
 * `restRule` may turn the turn into a rest.
 *
 * The computer's real move, once the search has chosen a target, walks the
 * best route for its speeds (Q210, stage 1: `bestRouteForSpeeds`), and so
 * does its own walk along a tree edge (stage 2). The games it imagines count
 * their walks instead (stage 3, `playRolloutTurn`).
 */
export function turnTowards(state: GameState, target: NodeId, restRule: RestRule, routeOf: RouteChoice = cheapestRoute): TurnAction {
  const player = activePlayer(state);
  const config = state.map.ruleset.config;
  const route = routeOf(state, player, target);
  if (route === null) throw new RangeError(`no route from ${player.position} to ${target}`);
  if (route.length === 0) return { kind: 'move', player: player.id, path: route, waypoint: null };

  const preview = previewPath(state.map.graph, player.position, route, state.turn.allowance, player.stats.stamina, config);
  if (restRule.restsInstead(state, player, preview.reachableStepCount)) return { kind: 'rest', player: player.id };
  return { kind: 'move', player: player.id, path: route, waypoint: null };
}

/** Why a macro-action stopped. */
export type MacroAdvanceOutcome =
  | 'arrived'
  | 'target_claimed_by_other'
  | 'terminal';

/** `chooseWalkTarget` with the balancing harness's `closest` and `pick` in place of its two steps. */
function comparedTarget(
  state: GameState,
  player: PlayerState,
  eligible: ReadonlySet<NodeId>,
  count: number,
  options: RolloutOptions,
): PoiCandidate | null {
  const candidates =
    options.closest === undefined
      ? closestPoiCandidates(state.map.graph, player.position, eligible, count, options.config, routeTable(state.map.graph, options.config))
      : options.closest(state, player, eligible, count);
  if (candidates.length === 0) return null;
  return pickAmong(state, player, candidates, options);
}

/** Which of `candidates` the player heads for: `pick`'s choice, or one uniformly at random. */
function pickAmong(state: GameState, player: PlayerState, candidates: readonly PoiCandidate[], options: RolloutOptions): PoiCandidate {
  return options.pick === undefined ? options.rng.pick(candidates) : options.pick(state, player, candidates, options.rng);
}

/**
 * Play the active seat's turn under the rollout policy, and return the cursor
 * after it.
 *
 * A seat with no commitment picks one uniformly among the K closest unclaimed
 * POIs (`chooseWalkTarget`, shared with §5.1), or as `pick` picks among them;
 * the game's computer favours gold as the game goes on (Q290,
 * `goldByProgressPicker`). With `targets`, it picks among those, and rests
 * when they leave it none: the game's computer leaves out the guards its skill
 * cannot beat (Q295, `winnableBySkill`). After the turn, a commitment
 * lapses for whoever has arrived at theirs and for anyone whose target someone
 * has just claimed; everyone else keeps theirs.
 *
 * [Q210] The seat walks the best route for its speeds, counted (stage 3,
 * 823 A); with `walks: 'replayed'` it walks the cheapest route through
 * `applyAction`, as before.
 */
export function playRolloutTurn(cursor: RolloutCursor, options: RolloutOptions): RolloutCursor {
  if (options.walks === 'replayed') return playWalkedTurn(cursor, options, cheapestRoute);
  const player = activePlayer(cursor.state);
  const target = committedTarget(cursor, player, options);
  if (target === null) return restedTurn(cursor, player.seat - 1, applyCountedTurn(cursor.state, { kind: 'rest' }, options.dice));
  return playCountedTurn(cursor, options, player.seat - 1, target);
}

/**
 * The active seat's target: the one it is committed to, or one it picks now;
 * `null` when `options.targets` leaves it nowhere to go (Q295), and it rests.
 */
function committedTarget(cursor: RolloutCursor, player: PlayerState, options: RolloutOptions): NodeId | null {
  const committed = cursor.targets[player.seat - 1] ?? null;
  if (committed !== null) return committed;

  const state = cursor.state;
  const count = options.config.balancing.CLOSE_CANDIDATE_COUNT;
  if (options.candidates !== undefined) {
    const candidates = options.candidates(state, player, count);
    return candidates.length === 0 ? null : pickAmong(state, player, candidates, options).node;
  }
  const eligible = options.targets === undefined ? unclaimedPoiNodes(state) : options.targets(state, player);
  if (eligible.size === 0) return null;
  const choice =
    options.closest === undefined && options.pick === undefined
      ? chooseWalkTarget(
          state.map.graph,
          player.position,
          eligible,
          count,
          options.config,
          options.rng,
          routeTable(state.map.graph, options.config),
        )
      : comparedTarget(state, player, eligible, count, options);
  // Some POI is eligible, and every one is on the map's one connected graph;
  // reaching here is a caller bug, not a position.
  if (choice === null) throw new RangeError('a rollout turn with no eligible POI to head for');
  return choice.node;
}

/** [Q295] The cursor after a seat with nowhere to go rested: nothing was claimed, so every other seat keeps its target. */
function restedTurn(cursor: RolloutCursor, index: number, next: GameState): RolloutCursor {
  return { state: next, subject: cursor.subject, targets: cursor.targets, walks: cursor.walks.map((walk, at) => (at === index ? null : walk)) };
}

/**
 * The active seat's turn walked through `applyAction` along the route
 * `routeOf` picks from where it stands: every imagined turn before stage 3,
 * and the search's own walk along a tree edge.
 */
function playWalkedTurn(cursor: RolloutCursor, options: RolloutOptions, routeOf: RouteChoice): RolloutCursor {
  const state = cursor.state;
  const player = activePlayer(state);
  const index = player.seat - 1;
  const target = committedTarget(cursor, player, options);
  if (target === null) return restedTurn(cursor, index, applyAction(state, { kind: 'rest', player: player.id }, options.dice).state);

  const action = turnTowards(state, target, options.restRule, routeOf);
  const next = applyAction(state, action, options.dice).state;
  const arrived = action.kind === 'move' && next.players[index]?.position === target;
  const walks = cursor.walks.map((walk, at) => (at === index ? null : walk));
  return afterClaims(cursor, next, index, target, arrived, walks);
}

/**
 * [Q210, 823 A] The active seat's turn counted along its route. The route is
 * traced when the seat starts for its target, and each turn walks on along it
 * as far as §7 pays for (`countWalk`), or rests by `restRule`, and is played
 * with `applyCountedTurn`. Standing on its target already, the seat walks no
 * steps, which §8 makes another roll at the guard there, as the empty move.
 */
function playCountedTurn(cursor: RolloutCursor, options: RolloutOptions, index: number, target: NodeId): RolloutCursor {
  const state = cursor.state;
  const player = activePlayer(state);
  let walk = cursor.walks[index] ?? null;
  if (walk === null || walk.target !== target || standsOn(walk) !== player.position) {
    const route = (options.walkRoute ?? bestRouteForSpeeds)(state, player, target);
    if (route === null) throw new RangeError(`no route from ${player.position} to ${target}`);
    walk = { target, from: player.position, route, walked: 0 };
  }

  const route = walk.route;
  let walked = walk.walked;
  let next: GameState;
  let moved = true;
  let claims = false;
  const turn = countWalk(state.map.graph, route, walked, state.turn.allowance, player.stats.stamina, options.config);
  if (walked < route.length && options.restRule.restsInstead(state, player, turn.steps)) {
    next = applyCountedTurn(state, { kind: 'rest' }, options.dice);
    moved = false;
  } else {
    walked += turn.steps;
    const to = walked === 0 ? walk.from : (route[walked - 1] as NodeId);
    claims = unclaimedSiteAt(state, to);
    next = applyCountedTurn(state, { kind: 'walk', to, staminaSpent: turn.staminaSpent }, options.dice);
  }

  const arrived = moved && walked === route.length;
  const walks = cursor.walks.map((kept, at) => (at !== index ? kept : arrived ? null : { ...(walk as RouteWalk), walked }));
  if (claims) return afterClaims(cursor, next, index, target, arrived, walks);
  // Nothing was claimed, so every other seat keeps its target.
  const targets = cursor.targets[index] === target ? cursor.targets : cursor.targets.map((committed, at) => (at === index ? target : committed));
  return { state: next, subject: cursor.subject, targets, walks };
}

/** Where a walk has brought its player. */
function standsOn(walk: RouteWalk): NodeId {
  return walk.walked === 0 ? walk.from : (walk.route[walk.walked - 1] as NodeId);
}

/** Whether an unclaimed site stands on `node`, which a turn ending there fights or takes (§8). */
function unclaimedSiteAt(state: GameState, node: NodeId): boolean {
  return poiRuntimeAt(state, node)?.claimedBy === null;
}

/**
 * The cursor after a turn that may have claimed a site: the mover's
 * commitment lapses on arrival, and anyone's lapses once someone has claimed
 * their target, their walk with it.
 */
function afterClaims(
  cursor: RolloutCursor,
  next: GameState,
  index: number,
  target: NodeId,
  arrived: boolean,
  walks: readonly (RouteWalk | null)[],
): RolloutCursor {
  const targets = cursor.targets.map((committed, at) => {
    const current = at === index ? target : committed;
    if (current === null) return null;
    if (at === index && arrived) return null;
    return poiRuntimeAt(next, current)?.claimedBy === null ? current : null;
  });
  return { state: next, subject: cursor.subject, targets, walks: walks.map((walk, at) => (targets[at] === null ? null : walk)) };
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
 *
 * The mover walks the route `moverRoute` picks, the cheapest when absent,
 * turn by turn through `applyAction` (Q210, 820 A: the search's own walk is
 * the best route for its speeds); the other seats play the rollout's turns,
 * counted along theirs since stage 3.
 */
export function macroAdvanceToTarget(
  cursor: RolloutCursor,
  target: NodeId,
  options: RolloutOptions,
  moverRoute: RouteChoice = cheapestRoute,
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
    current = moving ? playWalkedTurn(current, options, moverRoute) : playRolloutTurn(current, options);
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
