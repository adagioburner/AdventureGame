import type { GameConfig } from '@adventure/config';
import type { DiceSource, GameState, PlayerId, Rng, TurnAction } from '@adventure/core';
import { goldExhaustedTermination, restWhenStuck, turnCapTermination } from '@adventure/sim';
import { searchTree, firstTurnOf, type SearchResult } from './mcts.ts';
import { simulatedRolloutEvaluator } from './policies/evaluators.ts';
import { closestPoiRolloutPolicy } from './policies/rollout.ts';
import { closestUnclaimedPoiEnumerator, previewReachability, uctTreePolicy } from './policies/tree.ts';
import type { MctsOptions } from './types.ts';

/** What a computer seat needs besides the position. */
export interface ComputerSettings {
  readonly config: GameConfig;
  /** Thinking time for one move, in the clock's units (milliseconds on a real one). */
  readonly thinkingMs: number;
  /** The search's own randomness and die: never the game's. */
  readonly rng: Rng;
  readonly dice: DiceSource;
  readonly now: () => number;
}

/**
 * §9's computer player with the v1 setup: UCT with `MCTS_EXPLORATION_CONSTANT`
 * over the `CLOSE_CANDIDATE_COUNT` closest unclaimed POIs plus rest, the §9
 * rollout policy, and the simulated evaluation (Q18: v1 uses it; estimated
 * and hybrid are there to experiment with). The games it plays in its head
 * rest when stuck (Q43) and stop when the gold is gone, the game is won, or
 * `SIMULATION_TURN_CAP` turns have passed since `state` (Q44).
 */
export function computerSearchOptions(state: GameState, subject: PlayerId, settings: ComputerSettings): MctsOptions {
  const { config } = settings;
  const termination = turnCapTermination(goldExhaustedTermination(), state.turn.number, config.ai.SIMULATION_TURN_CAP);
  const restRule = restWhenStuck();
  return {
    subject,
    config,
    treePolicy: uctTreePolicy(config.ai.MCTS_EXPLORATION_CONSTANT),
    actions: closestUnclaimedPoiEnumerator(config, previewReachability()),
    rollout: closestPoiRolloutPolicy({ config, termination, restRule }),
    evaluator: simulatedRolloutEvaluator(),
    termination,
    restRule,
    dice: settings.dice,
    rng: settings.rng,
    timeBudgetMs: settings.thinkingMs,
    now: settings.now,
  };
}

export interface ComputerMove {
  /** This turn's move: the first turn of the branch the search chose. */
  readonly action: TurnAction;
  readonly search: SearchResult;
}

/** Think for `settings.thinkingMs` and return the move for `subject`, whose turn it must be. */
export function chooseComputerMove(state: GameState, subject: PlayerId, settings: ComputerSettings): ComputerMove {
  const options = computerSearchOptions(state, subject, settings);
  const search = searchTree(state, options);
  return { action: firstTurnOf(state, search.best.action, options), search };
}
