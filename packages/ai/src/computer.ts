import type { GameConfig } from '@adventure/config';
import type { DiceSource, GameState, PlayerId, Rng } from '@adventure/core';
import {
  bestRouteForSpeeds,
  closestByBestRoute,
  closestBySpeeds,
  closestWinnableBySpeeds,
  goldByProgressPicker,
  goldExhaustedTermination,
  restWhenStuck,
  turnCapTermination,
  walkedRouteSteps,
  winnableBySkill,
} from '@adventure/sim';
import { planTurn, searchTree, startSearch, type SearchResult, type TurnPlan } from './mcts.ts';
import { simulatedLeadEvaluator } from './policies/evaluators.ts';
import { closestPoiRolloutPolicy } from './policies/rollout.ts';
import { closestUnclaimedPoiEnumerator, stepsReachability, uctTreePolicy } from './policies/tree.ts';
import type { MctsOptions, NodeEvaluator } from './types.ts';

/** What a computer seat needs besides the position. */
export interface ComputerSettings {
  readonly config: GameConfig;
  /** Thinking time for one move, in the clock's units (milliseconds on a real one). */
  readonly thinkingMs: number;
  /** The search's own randomness and die: never the game's. */
  readonly rng: Rng;
  readonly dice: DiceSource;
  readonly now: () => number;
  /**
   * How a searched position is valued. The game leaves it out and gets
   * `computerEvaluator()`, the lead score (Q113); the balancing harness passes
   * another to compare with it.
   */
  readonly evaluator?: NodeEvaluator;
}

/**
 * How the game's computer players value a game they imagine (Q113): Andrei's
 * lead score, (lead / (|lead| + 1) + 1) / 2, where the lead is the player's
 * gold minus the richest other player's when the imagined game ends.
 */
export function computerEvaluator(): NodeEvaluator {
  return simulatedLeadEvaluator();
}

/**
 * §9's computer player with the v1 setup: UCT with `MCTS_EXPLORATION_CONSTANT`
 * over the `CLOSE_CANDIDATE_COUNT` closest unclaimed POIs plus rest and the
 * purchases a move this turn would use up (Q190, Q280, `buyBranches`), closest
 * by the player's own speeds along the route the formula counts best for them
 * (Q112, Q210 stage 2: `closestByBestRoute`), its resting and buying checks
 * and its own walk along the route it walks, scored as End turn walks it
 * (Q308: `walkedRouteSteps`, `bestRouteForSpeeds`), the §9 rollout policy
 * ranking by the speeds along the cheapest route (`closestBySpeeds`, 822 B)
 * and walking the best route for them, counted (Q210 stage 3, 823 A), heading
 * for gold more often as the
 * sites are claimed (Q290, `goldByProgressPicker`), and the lead score (Q113,
 * `computerEvaluator`). Guarded gold it cannot win is skipped (Q295): its own
 * choices skip a guard it reaches this turn unless the skill it holds could
 * win, and any its gold could not buy the win of either, the next closest
 * taking their places (`closestUnclaimedPoiEnumerator`); the players in its
 * imagined games skip what their skill cannot win (`winnableBySkill`); with
 * nothing left either rests. The other seats' turns along its tree's edges
 * choose their sites as its imagined players do (Q307). The games it plays in
 * its head rest when stuck (Q43) and stop when the gold is gone, the game is
 * won, or `SIMULATION_TURN_CAP` turns have passed since `state` (Q44).
 */
export function computerSearchOptions(state: GameState, subject: PlayerId, settings: ComputerSettings): MctsOptions {
  const { config } = settings;
  const termination = turnCapTermination(goldExhaustedTermination(), state.turn.number, config.ai.SIMULATION_TURN_CAP);
  const restRule = restWhenStuck();
  // [Q307] The players it imagines, in the games it plays out and on the other
  // seats' turns along its tree's edges alike.
  const imaginedPlayers = {
    closest: closestBySpeeds,
    targets: winnableBySkill,
    // They find both of those in one pass.
    candidates: closestWinnableBySpeeds,
    pick: goldByProgressPicker(),
  };
  return {
    subject,
    config,
    treePolicy: uctTreePolicy(config.ai.MCTS_EXPLORATION_CONSTANT),
    actions: closestUnclaimedPoiEnumerator(config, stepsReachability(walkedRouteSteps), closestByBestRoute, bestRouteForSpeeds),
    edgeRoute: bestRouteForSpeeds,
    rollout: closestPoiRolloutPolicy({ config, termination, restRule, ...imaginedPlayers }),
    evaluator: settings.evaluator ?? computerEvaluator(),
    termination,
    restRule,
    dice: settings.dice,
    rng: settings.rng,
    timeBudgetMs: settings.thinkingMs,
    now: settings.now,
    imaginedPlayers,
  };
}

/**
 * This turn's purchase (Q190; usually none) and its move: the first turn of
 * the branch the search chose after them, `null` only when a purchase ends
 * the game (756). See `planTurn`.
 */
export interface ComputerMove extends TurnPlan {
  readonly search: SearchResult;
}

/** Think for `settings.thinkingMs` and return the move for `subject`, whose turn it must be. */
export function chooseComputerMove(state: GameState, subject: PlayerId, settings: ComputerSettings): ComputerMove {
  const options = computerSearchOptions(state, subject, settings);
  const search = searchTree(state, options);
  return { ...planTurn(state, search, options), search };
}

/** A computer seat's move, thought about a slice at a time (see `SlicedSearch`). */
export interface ComputerThinking {
  /** Think for up to `sliceMs` more; true once the thinking time is spent. */
  step(sliceMs: number): boolean;
  /** The move the thinking so far points to. */
  move(): ComputerMove;
}

/** `chooseComputerMove`, for a caller that must hand the thread back between slices. */
export function startComputerMove(state: GameState, subject: PlayerId, settings: ComputerSettings): ComputerThinking {
  const options = computerSearchOptions(state, subject, settings);
  const search = startSearch(state, options);
  return {
    step: (sliceMs) => search.step(sliceMs),
    move() {
      const result = search.result();
      return { ...planTurn(state, result, options), search: result };
    },
  };
}
