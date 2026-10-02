import type { Ruleset } from '@adventure/config';
import {
  activePlayer,
  createDiceSource,
  createRng,
  offeredReward,
  poiAt,
  poiRuntimeAt,
  shortestPath,
  totalGoldUnits,
  type GameState,
  type NodeId,
  type PlayerId,
} from '@adventure/core';
import { chooseComputerMove, computerEvaluator, type MctsNode, type NodeEvaluator } from '@adventure/ai';
import type { ClosestFinder, TargetFilter, TargetPicker } from '@adventure/sim';
import type { PlaythroughDriver, TurnChoice } from './playthrough.ts';

/** How the computer player thinks in a playthrough. */
export interface ComputerSettings {
  readonly ruleset: Ruleset;
  /** Per move, in the clock's units. */
  readonly thinkingMs: number;
  /** Seeds the search's own randomness and dice, never the game's. */
  readonly seed: string;
  /**
   * The clock the budget is measured on. A real one gives a real thinking
   * time; a counter gives a fixed amount of search, which is what a test or a
   * golden file needs to come out the same on every machine.
   */
  readonly now: () => number;
  /** How the search values a position; the game's own (the lead score, Q113) when absent. */
  readonly evaluator?: NodeEvaluator;
  /** Which sites a player may head for; every unclaimed one when absent, as the game plays. */
  readonly targets?: TargetFilter;
  /** Which sites count as closest; by the player's own speeds when absent, as the game plays (Q112). */
  readonly closest?: ClosestFinder;
  /** Which of the closest a player in an imagined game heads for; uniformly when absent. */
  readonly pick?: TargetPicker;
  /** Told after every move how many iterations the search ran in how long. */
  readonly onSearch?: (iterations: number, took: number) => void;
}

/**
 * §9's computer player as a playthrough driver: every seat searches for its
 * move with `chooseComputerMove`, the same v1 setup the game's computer seats
 * use.
 *
 * What it adds to the transcript is why: how many games the search played in
 * its head, how the chosen target did in them, and the runners-up — so a
 * reader can tell a considered choice from an engine bug without the code.
 */
export function computerDriver(settings: ComputerSettings): PlaythroughDriver {
  const config = settings.ruleset.config;
  const rng = createRng(`search-${settings.seed}`);
  const dice = createDiceSource(rng.fork('dice'), config);
  const seconds = settings.thinkingMs / 1000;
  const evaluator = settings.evaluator ?? computerEvaluator();

  return {
    describe: [
      `# "plan" is the computer player's choice (GDD §9): each turn it searched for ${seconds} s,`,
      '# playing games out in its head from the position on the board, and took the target it tried most.',
      ...describeWhy(evaluator),
    ],
    choose(state: GameState, playerId: PlayerId): TurnChoice {
      const started = settings.now();
      const { buy, action, branch, search: result } = chooseComputerMove(state, playerId, {
        config,
        thinkingMs: settings.thinkingMs,
        rng,
        dice,
        now: settings.now,
        ...(settings.evaluator === undefined ? {} : { evaluator: settings.evaluator }),
        ...(settings.targets === undefined ? {} : { targets: settings.targets }),
        ...(settings.closest === undefined ? {} : { closest: settings.closest }),
        ...(settings.pick === undefined ? {} : { pick: settings.pick }),
      });
      const took = settings.now() - started;
      settings.onSearch?.(result.iterations, took);
      const why = explain(state, result.root, result.best, result.iterations, took, evaluator);

      // [Q190] The move is the first turn of the first branch after the purchases.
      if (branch === null || branch.kind === 'rest') return { buy, action, heading: null, why };

      const target = branch.target.node;
      const player = activePlayer(state);
      const route = shortestPath(state.map.graph, player.position, target, config);
      if (route === null) throw new Error(`node ${target} is unreachable from ${player.position}`);
      return {
        buy,
        action,
        heading: { target, route, reason: 'the computer’s choice' },
        why,
      };
    },
  };
}

/** The header lines that say how to read "why". */
function describeWhy(evaluator: NodeEvaluator): string[] {
  if (evaluator.name === 'simulated-rollout') {
    return [
      '# "why" says how many games that was, and what share of the map\'s gold it ended with on',
      '# average when it went that way; "others" are the runners-up.',
    ];
  }
  if (evaluator.name === 'simulated-lead-soft') {
    return [
      '# "why" says how many games that was, and how it scored them on average when it went that way:',
      '# each game by its gold lead over the richest other player at the end (Q113), 50% level,',
      '# 75% one gold ahead, 25% one behind; "others" are the runners-up.',
    ];
  }
  return [
    `# "why" says how many games that was, and its score out of 100 by the ${evaluator.name}`,
    '# evaluation on average when it went that way; "others" are the runners-up.',
  ];
}

/** The "why" and "others" lines. */
function explain(
  state: GameState,
  root: MctsNode,
  best: MctsNode,
  iterations: number,
  took: number,
  evaluator: NodeEvaluator,
): string[] {
  const gold = totalGoldUnits(state.map);
  const ranked = [...root.children].sort((a, b) => b.visits - a.visits);
  const share = (node: MctsNode): string => (node.visits === 0 ? '—' : `${Math.round((100 * node.totalValue) / node.visits)}%`);

  // Only the simulated evaluation is a share of the gold; the others are a
  // score out of 100 that the transcript's header explains.
  const worth =
    evaluator.name === 'simulated-rollout'
      ? ` ending with ${share(best)} of the map's ${gold} gold on average`
      : evaluator.name === 'simulated-lead-soft'
        ? ` scoring ${share(best)} by its lead on average`
        : ` worth ${share(best)} on average by the ${evaluator.name} evaluation`;
  const lines = [
    `  why     ${games(iterations)} played in its head over ${(took / 1000).toFixed(1)} s. This way: ${games(best.visits)},` +
      worth,
  ];
  const others = ranked.filter((node) => node !== best).slice(0, 3);
  if (others.length > 0) {
    lines.push(`  others  ${others.map((node) => `${label(state, node)} ${games(node.visits)} ${share(node)}`).join(' · ')}`);
  }
  return lines;
}

function games(count: number): string {
  return `${count} game${count === 1 ? '' : 's'}`;
}

function label(state: GameState, node: MctsNode): string {
  const branch = node.action;
  if (branch === null) return 'root';
  if (branch.kind === 'rest') return 'rest';
  if (branch.kind === 'buy') return `buy ${branch.skill}`;
  return `node ${branch.target.node} (${poiText(state, branch.target.node)})`;
}

function poiText(state: GameState, node: NodeId): string {
  const poi = poiAt(state.map, node);
  if (poi === undefined) return '?';
  const offered = offeredReward(poi, poiRuntimeAt(state, node));
  const reward = `${offered.kind} x${offered.units}`;
  return poi.guard === null ? reward : `${reward}, ${poi.guard.type} ${poi.guard.strength}`;
}
