import type { GameConfig } from '@adventure/config';
import {
  NotImplementedError,
  unclaimedGoldUnits,
  type DiceSource,
  type GameState,
  type NodeId,
  type PlayerId,
  type Rng,
} from '@adventure/core';
import type { WalkDriver } from './walk.ts';

/**
 * [SOURCE §5, chat] §9's rollout policy: "choose a random target among the
 * `CLOSE_CANDIDATE_COUNT` closest POIs, using the same weighted-terrain-cost
 * random-walk code as §5.1."
 *
 * The shared part is `candidates.ts` (rank by weighted cost, pick uniformly
 * among the K closest) and the `runWalk` loop. What a rollout does differently
 * is advance through the *real* rules: a chosen target is walked toward with
 * `applyAction`, respecting movement allowance and stamina (§7), triggering
 * automatic POI interaction and guard rolls (§8) on arrival, and taking as many
 * turns as that needs.
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
 */
export interface RolloutCursor {
  readonly state: GameState;
  /** Whose gold the backpropagated value is read from (§9). */
  readonly subject: PlayerId;
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
 */
export interface RolloutTermination {
  isTerminal(cursor: RolloutCursor, legsTaken: number): boolean;
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

export interface RolloutOptions {
  readonly config: GameConfig;
  readonly termination: RolloutTermination;
  readonly dice: DiceSource;
  readonly rng: Rng;
}

/** Which POIs a rollout may target: those whose reward is still unclaimed (§4.5). */
export function unclaimedPoiNodes(_state: GameState): ReadonlySet<NodeId> {
  throw new NotImplementedError('unclaimedPoiNodes', 'GDD.md §4.5 / §9');
}

/**
 * The `WalkDriver` that plugs the real rules into the shared walk loop.
 *
 * Note it advances *the active seat*, not `cursor.subject` — every player is
 * simulated, and `subject` only says whose gold is read at the end.
 */
export function rolloutDriver(_options: RolloutOptions): WalkDriver<RolloutCursor> {
  throw new NotImplementedError('rolloutDriver', 'GDD.md §9');
}

/**
 * Run one rollout and return the terminal cursor.
 *
 * [SOURCE §5, chat] "Backpropagated value: the simulated player's gold amount
 * after rollout, by default." The "by default" is why this returns the state
 * rather than a number — evaluating it is a separate, swappable concern; see
 * `NodeEvaluator` in `@adventure/ai`.
 */
export function runRollout(_start: RolloutCursor, _options: RolloutOptions): RolloutCursor {
  throw new NotImplementedError('runRollout', 'GDD.md §9');
}

/** Why a macro-action stopped. */
export type MacroAdvanceOutcome =
  | 'arrived'
  | 'target_claimed_by_other'
  | 'terminal';

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
 * other seats take their own turns in between, since all players are simulated.
 *
 * This is one macro-action = one tree edge, which is why the tree stays shallow
 * enough to be searched in ten seconds: a node is a real decision point rather
 * than a single step.
 */
export function macroAdvanceToTarget(
  _cursor: RolloutCursor,
  _target: NodeId,
  _options: RolloutOptions,
): { readonly cursor: RolloutCursor; readonly outcome: MacroAdvanceOutcome } {
  throw new NotImplementedError('macroAdvanceToTarget', 'GDD.md §9, chat');
}
