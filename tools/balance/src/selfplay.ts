import os from 'node:os';
import type { Ruleset } from '@adventure/config';
import type { PlayerStats, Seed } from '@adventure/core';
import { computerDriver, type ComputerSettings } from './aiPlaythrough.ts';
import { playGame, type PlaythroughEnd } from './playthrough.ts';

/**
 * Computer-against-computer games, for the balancing pass
 * (docs/IMPLEMENTATION_PLAN.md phase 5, item 7).
 *
 * Every seat is §9's computer player, thinking for the same time. Because that
 * time is wall-clock seconds (Q21), a result is only comparable with another
 * run on the same machine, so the report records the machine beside the
 * numbers. A counter for a clock gives a fixed amount of search instead, which
 * is what a test needs.
 */
export interface SelfPlayOptions {
  readonly ruleset: Ruleset;
  readonly seeds: readonly Seed[];
  readonly playerCount: number;
  /** A game that has not ended by here is reported rather than run for ever. */
  readonly maxTurns: number;
  readonly computer: Omit<ComputerSettings, 'ruleset' | 'seed'>;
}

export interface SelfPlayGame {
  readonly seed: Seed;
  readonly endedBy: PlaythroughEnd;
  readonly turns: number;
  /** 1-based seats, more than one on a shared win, none if the game did not end. */
  readonly winningSeats: readonly number[];
  /** Final stats in seat order. */
  readonly finalStats: readonly PlayerStats[];
  readonly seconds: number;
}

export interface SelfPlayReport {
  readonly machine: string;
  readonly thinkingMs: number;
  readonly playerCount: number;
  readonly games: readonly SelfPlayGame[];
}

/** Play one computer-only game per seed. */
export function runSelfPlayBatch(options: SelfPlayOptions): SelfPlayReport {
  const games = options.seeds.map((seed): SelfPlayGame => {
    const started = Date.now();
    const run = playGame(
      { seed, diceSeed: `dice-${seed}`, playerCount: options.playerCount, maxTurns: options.maxTurns },
      options.ruleset,
      computerDriver({ ...options.computer, ruleset: options.ruleset, seed }),
    );
    const players = run.finalState.players;
    return {
      seed,
      endedBy: run.endedBy,
      turns: run.turns.length,
      winningSeats: players.filter((player) => run.finalState.winners.includes(player.id)).map((player) => player.seat),
      finalStats: players.map((player) => player.stats),
      seconds: (Date.now() - started) / 1000,
    };
  });
  return {
    machine: machine(),
    thinkingMs: options.computer.thinkingMs,
    playerCount: options.playerCount,
    games,
  };
}

/** The report as text: one line per game, then the totals. */
export function formatSelfPlayReport(report: SelfPlayReport): string {
  const lines = [
    `computer against computer, ${report.playerCount} seats, ${report.thinkingMs / 1000} s per move`,
    `machine ${report.machine}`,
    '',
    'seed                 ended      turns  winner  gold by seat        seconds',
  ];
  for (const game of report.games) {
    lines.push(
      `${game.seed.padEnd(20)} ${game.endedBy.padEnd(10)} ${String(game.turns).padStart(5)}  ` +
        `${(game.winningSeats.length === 0 ? '-' : game.winningSeats.join('+')).padEnd(6)}  ` +
        `${game.finalStats.map((stats) => String(stats.gold).padStart(3)).join(' ').padEnd(18)}  ` +
        `${game.seconds.toFixed(0).padStart(7)}`,
    );
  }

  const finished = report.games.filter((game) => game.endedBy === 'victory');
  lines.push('');
  lines.push(`${finished.length} of ${report.games.length} games reached a winner`);
  for (let seat = 1; seat <= report.playerCount; seat++) {
    const wins = finished.filter((game) => game.winningSeats.includes(seat)).length;
    lines.push(`seat ${seat} won ${wins}${finished.length === 0 ? '' : ` (${Math.round((100 * wins) / finished.length)}%)`}`);
  }
  if (finished.length > 0) {
    const turns = finished.map((game) => game.turns).sort((a, b) => a - b);
    lines.push(`turns: fewest ${turns[0]}, median ${turns[Math.floor(turns.length / 2)]}, most ${turns[turns.length - 1]}`);
  }
  return `${lines.join('\n')}\n`;
}

function machine(): string {
  const cpu = os.cpus()[0]?.model.trim() ?? 'unknown CPU';
  return `${cpu}, ${os.cpus().length} cores, Node ${process.versions.node}`;
}
