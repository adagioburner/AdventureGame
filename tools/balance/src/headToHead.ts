import type { Ruleset } from '@adventure/config';
import type { PlayerStats, Seed } from '@adventure/core';
import {
  estimatedGoldAndSkillsEvaluator,
  hybridGoldAndSkillsEvaluator,
  simulatedLeadEvaluator,
  simulatedRolloutEvaluator,
  type NodeEvaluator,
} from '@adventure/ai';
import { closestBySpeeds, closestByTerrainCost, goldByProgressPicker, winnablePoiNodes } from '@adventure/sim';
import { computerDriver } from './aiPlaythrough.ts';
import { playGame, type Playthrough, type PlaythroughDriver, type PlaythroughEnd } from './playthrough.ts';

/**
 * Computer against computer with a different node evaluation per seat (§9's
 * three: simulated, estimated, hybrid), so they can be compared on the same
 * maps with the seats swapped. Nothing here changes how the game's own
 * computer players think; they use the lead score (Q113), which is the
 * `lead-soft` seat here, while `simulated` is §9's own-gold evaluation.
 */
export const EVALUATORS = {
  simulated: simulatedRolloutEvaluator,
  estimated: () => estimatedGoldAndSkillsEvaluator('units-claimed'),
  hybrid: () => hybridGoldAndSkillsEvaluator('units-claimed'),
  // Progress as the larger of the gold and the skill shares claimed.
  'estimated-max': () => estimatedGoldAndSkillsEvaluator('larger-share'),
  'hybrid-max': () => hybridGoldAndSkillsEvaluator('larger-share'),
  // Today's imagined games, scored by the gold lead over the richest opponent (detail 417).
  lead: () => simulatedLeadEvaluator('margin'),
  'lead-win': () => simulatedLeadEvaluator('win'),
  'lead-win-margin': () => simulatedLeadEvaluator('win-and-margin'),
  // Andrei's form, 2026-09-30 11:43; the game's own since Q113.
  'lead-soft': () => simulatedLeadEvaluator('soft'),
} as const satisfies Record<string, () => NodeEvaluator>;

export type EvaluatorName = keyof typeof EVALUATORS;

export function isEvaluatorName(name: string): name is EvaluatorName {
  return Object.hasOwn(EVALUATORS, name);
}

/**
 * What a seat may change about where it goes, each for comparison only:
 *  - `winnable`: only sites it could win now are choices (detail 419).
 *  - `gold-later`: its imagined players head for gold more often as the
 *    rewards are claimed (idea 1, 421 A).
 *  - `speeds`: closest by its own speeds, Q65's effective distance over the
 *    steps per terrain of the cheapest route (idea 2, 422-424 A). The game's
 *    own ranking since Q112, so this changes nothing; kept so earlier runs'
 *    commands still read the same.
 *  - `fixed`: closest by weighted terrain cost alone, the computer player's
 *    ranking before Q112.
 */
export const SEAT_FLAGS = ['winnable', 'gold-later', 'speeds', 'fixed'] as const;
export type SeatFlag = (typeof SEAT_FLAGS)[number];

/**
 * One seat's way of thinking: an evaluation, any `SEAT_FLAGS`, and optionally
 * its own UCT exploration constant in place of §11's
 * `MCTS_EXPLORATION_CONSTANT`. Written `hybrid`, `simulated+speeds`,
 * `hybrid@0.3` or `simulated+winnable+gold-later@0.3`.
 */
export interface SeatSpec {
  readonly evaluator: EvaluatorName;
  readonly flags: readonly SeatFlag[];
  readonly exploration: number | null;
}

function isSeatFlag(text: string): text is SeatFlag {
  return SEAT_FLAGS.some((flag) => flag === text);
}

export function parseSeatSpec(text: string): SeatSpec | null {
  const [head, constant] = text.split('@');
  const [name, ...rest] = (head ?? '').split('+');
  if (name === undefined || !isEvaluatorName(name)) return null;
  if (!rest.every(isSeatFlag)) return null;
  const flags = rest.filter(isSeatFlag);
  if (constant === undefined) return { evaluator: name, flags, exploration: null };
  const exploration = Number(constant);
  return Number.isFinite(exploration) && exploration >= 0 ? { evaluator: name, flags, exploration } : null;
}

export function seatLabel(spec: SeatSpec): string {
  const name = [spec.evaluator, ...spec.flags].join('+');
  return spec.exploration === null ? name : `${name}@${spec.exploration}`;
}

function withExploration(ruleset: Ruleset, exploration: number | null): Ruleset {
  if (exploration === null) return ruleset;
  const config = ruleset.config;
  return { ...ruleset, config: { ...config, ai: { ...config.ai, MCTS_EXPLORATION_CONSTANT: exploration } } };
}

export interface HeadToHeadOptions {
  readonly ruleset: Ruleset;
  readonly seed: Seed;
  /** One way of thinking per seat, seat 1 first; its length is the player count. */
  readonly seats: readonly SeatSpec[];
  readonly thinkingMs: number;
  readonly now: () => number;
  readonly maxTurns: number;
}

export interface SeatResult {
  readonly seat: number;
  /** `seatLabel` of the seat's spec. */
  readonly evaluator: string;
  readonly won: boolean;
  readonly stats: PlayerStats;
  readonly moves: number;
  /** Search iterations per move, on average: games played in its head, or positions valued. */
  readonly iterationsPerMove: number;
}

export interface HeadToHeadGame {
  readonly seed: Seed;
  readonly thinkingMs: number;
  readonly endedBy: PlaythroughEnd;
  readonly turns: number;
  readonly seats: readonly SeatResult[];
  readonly seconds: number;
}

export function playHeadToHead(options: HeadToHeadOptions): { readonly game: HeadToHeadGame; readonly run: Playthrough } {
  const counters = options.seats.map(() => ({ moves: 0, iterations: 0 }));
  const drivers = options.seats.map((spec, index) =>
    computerDriver({
      // Only the search reads this copy; the game itself keeps `options.ruleset`.
      ruleset: withExploration(options.ruleset, spec.exploration),
      thinkingMs: options.thinkingMs,
      // Each seat searches with its own randomness, so two seats with the same
      // evaluation are still two players.
      seed: `${options.seed}-seat${index + 1}`,
      now: options.now,
      evaluator: EVALUATORS[spec.evaluator](),
      ...(spec.flags.includes('winnable') ? { targets: winnablePoiNodes } : {}),
      ...(spec.flags.includes('gold-later') ? { pick: goldByProgressPicker() } : {}),
      ...(spec.flags.includes('speeds') ? { closest: closestBySpeeds } : {}),
      ...(spec.flags.includes('fixed') ? { closest: closestByTerrainCost } : {}),
      onSearch: (iterations) => {
        const counter = counters[index];
        if (counter === undefined) return;
        counter.moves += 1;
        counter.iterations += iterations;
      },
    }),
  );
  const bySeat: PlaythroughDriver = {
    describe: [
      `# Seats by node evaluation (GDD §9): ${options.seats.map((spec, index) => `seat ${index + 1} ${seatLabel(spec)}`).join(', ')}.`,
      '# A number after @ is that seat\'s own exploration constant; the others use MCTS_EXPLORATION_CONSTANT.',
      '# simulated = share of the gold it ends with in a random game played to the end;',
      '# estimated = gold and skills it holds at the searched position, weighted by the gold claimed so far, no game played;',
      '# hybrid = the average of the two. -max: the progress weighing them is the larger of the gold',
      '# share and the skill share claimed, instead of all skill and gold units claimed.',
      '# lead = today\'s imagined games, scored by the gold lead over the richest other player:',
      '# (lead / total gold + 1) / 2; lead-win: 1 ahead, 0.5 level, 0 behind; lead-win-margin: their average;',
      '# lead-soft: (lead / (|lead| + 1) + 1) / 2 with the lead in gold.',
      '# +winnable: only sites it could win now are choices, for itself and for everyone in its imagined',
      '# games (gold whose guard a 6 plus the skill does not beat is left out, unless nothing else is left).',
      '# +gold-later: in its imagined games a player heads for a gold site among its 10 closest with chance',
      '# p = share of the gold and skill units claimed, otherwise for any of the 10 as today.',
      '# Every seat ranks its 10 closest, for itself and in its imagined games, by the least over n turns of',
      '# 5n + the stamina still needed after n turns of free steps, from the steps per terrain of the cheapest route',
      '# (Q112; +speeds says so explicitly). +fixed: ranked by weighted terrain cost alone, as before Q112.',
      ...(drivers[0]?.describe ?? []),
    ],
    choose(state, playerId) {
      const seat = state.players.find((player) => player.id === playerId)?.seat;
      const driver = seat === undefined ? undefined : drivers[seat - 1];
      if (driver === undefined) throw new Error(`no driver for ${playerId}`);
      return driver.choose(state, playerId);
    },
  };

  const started = Date.now();
  const run = playGame(
    { seed: options.seed, diceSeed: `dice-${options.seed}`, playerCount: options.seats.length, maxTurns: options.maxTurns },
    options.ruleset,
    bySeat,
  );
  const winners = new Set(run.finalState.winners);
  const game: HeadToHeadGame = {
    seed: options.seed,
    thinkingMs: options.thinkingMs,
    endedBy: run.endedBy,
    turns: run.turns.length,
    seats: run.finalState.players.map((player, index) => {
      const counter = counters[index] ?? { moves: 0, iterations: 0 };
      return {
        seat: player.seat,
        evaluator: seatLabel(options.seats[index] as SeatSpec),
        won: winners.has(player.id),
        stats: player.stats,
        moves: counter.moves,
        iterationsPerMove: counter.moves === 0 ? 0 : Math.round(counter.iterations / counter.moves),
      };
    }),
    seconds: (Date.now() - started) / 1000,
  };
  return { game, run };
}
