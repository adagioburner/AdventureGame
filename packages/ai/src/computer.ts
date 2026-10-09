import type { GameConfig } from '@adventure/config';
import type { DiceSource, GameState, PlayerId, Rng } from '@adventure/core';
import {
  bestRouteForSpeeds,
  bestRouteStepsFor,
  cheapestRoute,
  closestByBestRoute,
  closestBySpeeds,
  goldByProgressPicker,
  goldExhaustedTermination,
  restWhenStuck,
  turnCapTermination,
  type ClosestFinder,
  type TargetFilter,
  type TargetPicker,
} from '@adventure/sim';
import { planTurn, searchTree, startSearch, type SearchResult, type TurnPlan } from './mcts.ts';
import { simulatedLeadEvaluator } from './policies/evaluators.ts';
import { closestPoiRolloutPolicy } from './policies/rollout.ts';
import { closestUnclaimedPoiEnumerator, previewReachability, stepsReachability, uctTreePolicy } from './policies/tree.ts';
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
  /**
   * Which sites a player may head for, in the search's choices and in the
   * games it plays in its head. The game leaves it out and gets every
   * unclaimed site; the balancing harness passes `winnablePoiNodes` to compare.
   */
  readonly targets?: TargetFilter;
  /**
   * Which sites count as closest, in the search's choices and in its imagined
   * games. The game leaves it out and gets `closestBySpeeds` (Q112); the
   * balancing harness passes `closestByTerrainCost` to compare with before.
   */
  readonly closest?: ClosestFinder;
  /**
   * Which of the closest a player in an imagined game heads for. The game
   * leaves it out and gets `goldByProgressPicker`: gold more often as the
   * sites are claimed (Q290).
   */
  readonly pick?: TargetPicker;
  /**
   * [Q210] Which routes the search's own choices count: which sites are
   * choices, whether resting and which purchases are weighed, and its own
   * walk along a choice. The game leaves it out and gets the best for the
   * player's speeds (stage 2, 820 A); the balancing harness passes
   * `'cheapest'` to compare with the search before.
   */
  readonly searchRoutes?: 'best' | 'cheapest';
  /**
   * [Q210] How the players in the games it imagines walk. The game leaves it
   * out and gets a walk counted along the best route for their speeds (stage
   * 3, 823 A); the balancing harness passes `'replayed'`, the cheapest route
   * turn by turn, to compare with the computer before.
   */
  readonly imaginedWalks?: 'counted' | 'replayed';
}

/**
 * How the game's computer players value a game they imagine (Q113): Andrei's
 * lead score, (lead / (|lead| + 1) + 1) / 2, where the lead is the player's
 * gold minus the richest other player's when the imagined game ends. It was
 * the player's own share of the map's gold (§9's simulated evaluation).
 */
export function computerEvaluator(): NodeEvaluator {
  return simulatedLeadEvaluator('soft');
}

/**
 * §9's computer player with the v1 setup: UCT with `MCTS_EXPLORATION_CONSTANT`
 * over the `CLOSE_CANDIDATE_COUNT` closest unclaimed POIs plus rest and the
 * purchases a move this turn would use up (Q190, Q280, `buyBranches`), closest
 * by the player's own speeds along the best route for them (Q112, Q210 stage
 * 2: `closestByBestRoute`), its resting and buying checks and its own walk
 * along that route too, the §9 rollout policy ranking by the speeds along the
 * cheapest route (`closestBySpeeds`, 822 B) and walking the best route for
 * them, counted (Q210 stage 3, 823 A), heading for gold more often as the
 * sites are claimed (Q290, `goldByProgressPicker`), and the lead score (Q113,
 * `computerEvaluator`). The games it plays in
 * its head rest when stuck (Q43) and stop when the gold is gone, the game is
 * won, or `SIMULATION_TURN_CAP` turns have passed since `state` (Q44).
 */
export function computerSearchOptions(state: GameState, subject: PlayerId, settings: ComputerSettings): MctsOptions {
  const { config } = settings;
  const termination = turnCapTermination(goldExhaustedTermination(), state.turn.number, config.ai.SIMULATION_TURN_CAP);
  const restRule = restWhenStuck();
  const closest = settings.closest ?? closestBySpeeds;
  const cheapest = settings.searchRoutes === 'cheapest';
  const edgeRoute = cheapest ? cheapestRoute : bestRouteForSpeeds;
  return {
    subject,
    config,
    treePolicy: uctTreePolicy(config.ai.MCTS_EXPLORATION_CONSTANT),
    actions: closestUnclaimedPoiEnumerator(
      config,
      cheapest ? previewReachability() : stepsReachability(bestRouteStepsFor),
      settings.targets,
      settings.closest ?? (cheapest ? closestBySpeeds : closestByBestRoute),
      edgeRoute,
    ),
    edgeRoute,
    rollout: closestPoiRolloutPolicy({
      config,
      termination,
      restRule,
      closest,
      ...(settings.targets === undefined ? {} : { targets: settings.targets }),
      pick: settings.pick ?? goldByProgressPicker(),
      ...(settings.imaginedWalks === undefined ? {} : { walks: settings.imaginedWalks }),
    }),
    evaluator: settings.evaluator ?? computerEvaluator(),
    termination,
    restRule,
    dice: settings.dice,
    rng: settings.rng,
    timeBudgetMs: settings.thinkingMs,
    now: settings.now,
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
