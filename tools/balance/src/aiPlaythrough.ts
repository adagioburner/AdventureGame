import type { Ruleset } from '@adventure/config';
import {
  activePlayer,
  createDiceSource,
  createRng,
  poiAt,
  shortestPath,
  totalGoldUnits,
  type GameState,
  type NodeId,
  type PlayerId,
} from '@adventure/core';
import { chooseComputerMove, type MctsNode } from '@adventure/ai';
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

  return {
    describe: [
      `# "plan" is the computer player's choice (GDD §9): each turn it searched for ${seconds} s,`,
      '# playing games out in its head from the position on the board, and took the target it tried most.',
      '# "why" says how many games that was, and what share of the map\'s gold it ended with on',
      '# average when it went that way; "others" are the runners-up.',
    ],
    choose(state: GameState, playerId: PlayerId): TurnChoice {
      const started = settings.now();
      const { action, search: result } = chooseComputerMove(state, playerId, {
        config,
        thinkingMs: settings.thinkingMs,
        rng,
        dice,
        now: settings.now,
      });
      const took = settings.now() - started;
      const why = explain(state, result.root, result.best, result.iterations, took);

      const branch = result.best.action;
      if (branch === null) throw new Error('the search chose nothing');
      if (branch.kind === 'rest') return { action, heading: null, why };

      const target = branch.target.node;
      const player = activePlayer(state);
      const route = shortestPath(state.map.graph, player.position, target, config);
      if (route === null) throw new Error(`node ${target} is unreachable from ${player.position}`);
      return {
        action,
        heading: { target, route, reason: 'the computer’s choice' },
        why,
      };
    },
  };
}

/** The "why" and "others" lines. */
function explain(state: GameState, root: MctsNode, best: MctsNode, iterations: number, took: number): string[] {
  const gold = totalGoldUnits(state.map);
  const ranked = [...root.children].sort((a, b) => b.visits - a.visits);
  const share = (node: MctsNode): string => (node.visits === 0 ? '—' : `${Math.round((100 * node.totalValue) / node.visits)}%`);

  const lines = [
    `  why     ${iterations} games played in its head over ${(took / 1000).toFixed(1)} s. This way: ${best.visits} games,` +
      ` ending with ${share(best)} of the map's ${gold} gold on average`,
  ];
  const others = ranked.filter((node) => node !== best).slice(0, 3);
  if (others.length > 0) {
    lines.push(`  others  ${others.map((node) => `${label(state, node)} ${node.visits} games ${share(node)}`).join(' · ')}`);
  }
  return lines;
}

function label(state: GameState, node: MctsNode): string {
  const branch = node.action;
  if (branch === null) return 'root';
  if (branch.kind === 'rest') return 'rest';
  return `node ${branch.target.node} (${poiText(state, branch.target.node)})`;
}

function poiText(state: GameState, node: NodeId): string {
  const poi = poiAt(state.map, node);
  if (poi === undefined) return '?';
  const reward = `${poi.reward.kind} x${poi.reward.units}`;
  return poi.guard === null ? reward : `${reward}, ${poi.guard.type} ${poi.guard.strength}`;
}
