import type { GameConfig } from '@adventure/config';
import {
  NotImplementedError,
  type DiceSource,
  type GameState,
  type NodeId,
  type PlayerId,
  type Rng,
} from '@adventure/core';
import type { PoiCandidate } from './candidates.ts';
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
 * turns as that needs. So a rollout leg is a sequence of real turns, not a
 * teleport.
 */
export interface RolloutCursor {
  readonly state: GameState;
  /** Whose gold the backpropagated value is read from (§9). */
  readonly subject: PlayerId;
}

/**
 * When a rollout stops.
 *
 * **Unspecified in GDD.md.** §9 fixes the rollout policy and the backpropagated
 * value ("the simulated player's gold amount after rollout") but never says
 * after *what* — a fixed turn horizon, all POIs claimed, the §1 win condition
 * firing, or something else. The choice changes both what MCTS optimises and
 * how expensive a rollout is against the 10-second budget, so it is injected
 * with no default. See OPEN_QUESTIONS Q6.
 */
export interface RolloutTermination {
  isTerminal(cursor: RolloutCursor, legsTaken: number): boolean;
}

/**
 * Also unspecified: §9 describes the rollout policy for "the simulated player",
 * and does not say how the other seats behave during a rollout. Injected for
 * the same reason. See OPEN_QUESTIONS Q6.
 */
export interface OpponentRolloutPolicy {
  chooseTarget(cursor: RolloutCursor, seat: number, rng: Rng): PoiCandidate | null;
}

export interface RolloutOptions {
  readonly config: GameConfig;
  readonly termination: RolloutTermination;
  readonly opponents: OpponentRolloutPolicy;
  readonly dice: DiceSource;
  readonly rng: Rng;
}

/** Which POIs a rollout may target: those whose reward is still unclaimed (§4.5). */
export function unclaimedPoiNodes(_state: GameState): ReadonlySet<NodeId> {
  throw new NotImplementedError('unclaimedPoiNodes', 'GDD.md §4.5 / §9');
}

/** The `WalkDriver` that plugs the real rules into the shared walk loop. */
export function rolloutDriver(_options: RolloutOptions): WalkDriver<RolloutCursor> {
  throw new NotImplementedError('rolloutDriver', 'GDD.md §9 / docs/OPEN_QUESTIONS.md Q6');
}

/**
 * Run one rollout and return the value to backpropagate.
 *
 * [SOURCE §5, chat] "Backpropagated value: the simulated player's gold amount
 * after rollout, by default." The "by default" is why this is a plain function
 * returning the state — the *evaluation* of that state is a separate, swappable
 * concern; see `NodeEvaluator` in `@adventure/ai`.
 */
export function runRollout(_start: RolloutCursor, _options: RolloutOptions): RolloutCursor {
  throw new NotImplementedError('runRollout', 'GDD.md §9');
}
