import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_RULESET, rulesetForPlayers, type Ruleset } from '@adventure/config';
import type { Seed } from '@adventure/core';
import { computerDriver } from './aiPlaythrough.ts';
import { parseSeatSpec, playHeadToHead, type SeatSpec } from './headToHead.ts';
import { generateAndReport, runMapBatch } from './index.ts';
import { formatPlaythrough, playGame } from './playthrough.ts';
import { formatBatchReport, formatMapReport } from './report.ts';
import { formatSelfPlayReport, runSelfPlayBatch } from './selfplay.ts';
import { renderMapSvg } from './svg.ts';

/**
 * The way in to the balancing harness — `pnpm map <seed>` and
 * `pnpm map:batch <n>`, per `docs/IMPLEMENTATION_PLAN.md` §2.1.
 *
 * Plain `node`: every workspace package sets `"main": "src/index.ts"` and the
 * codebase uses no `enum` and no `namespace`, so Node 22's type stripping runs
 * this file directly. No `tsx`, no `ts-node`, no build step.
 */
const OUTPUT_DIR = 'out/maps';

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;

  if (command === 'map') return renderOne(rest);
  if (command === 'batch') return renderBatch(rest);
  if (command === 'game') return playOne(rest);
  if (command === 'selfplay') return selfPlay(rest);
  if (command === 'h2h') return headToHead(rest);

  process.stderr.write(
    [
      'usage:',
      '  pnpm map [<seed>] [--json] [--players=<n>]',
      '                                one map: a report, and out/maps/<seed>.svg;',
      '                                --players=4 or 5 draws the larger map (Q160)',
      '  pnpm map:batch [<n>] [--players=<n>]',
      '                                n seeds: the §11 distributions, no files',
      '  pnpm game [<seed>]            play one map to a winner: the turn-by-turn transcript',
      '  pnpm game [<seed>] --computer [--seconds=<s>]',
      '                                the same, with the computer playing both seats (10 s a move)',
      '  pnpm selfplay [<n>] [--seconds=<s>]',
      '                                n computer-against-computer games: who won, in how many turns',
      '  pnpm h2h <seed> --seats=simulated,estimated@0.3 [--seconds=<s>] [--log=<file>]',
      '                                one computer game with a node evaluation (§9), and optionally',
      '                                an exploration constant, per seat;',
      '                                prints the result as one JSON line, the transcript to --log',
      '',
    ].join('\n'),
  );
  return 2;
}

function renderOne(args: readonly string[]): number {
  const wantsJson = args.includes('--json');
  const given = args.find((argument) => !argument.startsWith('--'));
  const seed: Seed = given ?? randomSeed();

  // A random seed is printed *first*, before the work, so it can be reused even
  // if generation goes wrong.
  if (given === undefined) process.stdout.write(`seed ${seed} (generated; pass it back to reproduce this map)\n\n`);

  const ruleset = playersRuleset(args);
  if (ruleset === null) return 2;
  const { map, report } = generateAndReport(seed, ruleset);
  process.stdout.write(`${formatMapReport(report, ruleset)}\n\n`);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const svgPath = resolve(OUTPUT_DIR, `${fileSafe(seed)}.svg`);
  writeFileSync(svgPath, renderMapSvg(map, { valleyNodes: report.valleyNodes }), 'utf8');

  if (wantsJson) {
    const jsonPath = resolve(OUTPUT_DIR, `${fileSafe(seed)}.json`);
    // `poiByNode` is a Map and does not survive JSON; `reviveGameMap` rebuilds
    // it on the way back in, which is the round trip Q15 needs anyway.
    writeFileSync(jsonPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    process.stdout.write(`${jsonPath}\n`);
  }

  // Last line, so it can be pasted straight into a browser.
  process.stdout.write(`${svgPath}\n`);
  return 0;
}

/**
 * One whole game, headless, through `applyAction` — the rules engine (§7, §8)
 * doing what the map generator's `pnpm map` does for §2.1. By default the
 * driver is the deliberately dumb one in `playthrough.ts`; with `--computer`
 * it is §9's computer player in both seats, thinking on the real clock, so the
 * same seed plays differently from one run or machine to the next.
 */
function playOne(args: readonly string[]): number {
  const given = args.find((argument) => !argument.startsWith('--'));
  const seed: Seed = given ?? randomSeed();
  if (given === undefined) process.stdout.write(`seed ${seed} (generated; pass it back to reproduce this game)\n\n`);

  const seconds = secondsOption(args);
  if (seconds === null) return 2;
  const driver = args.includes('--computer')
    ? computerDriver({ ruleset: DEFAULT_RULESET, thinkingMs: seconds * 1000, seed, now: () => performance.now() })
    : undefined;
  const run = playGame({ seed, diceSeed: `dice-${seed}`, playerCount: 2, maxTurns: 2000 }, DEFAULT_RULESET, driver);
  process.stdout.write(formatPlaythrough(run));
  return run.endedBy === 'victory' ? 0 : 1;
}

/**
 * Computer-against-computer games on `selfplay-0` … `selfplay-<n−1>`, for the
 * balancing pass (docs/IMPLEMENTATION_PLAN.md phase 5).
 */
function selfPlay(args: readonly string[]): number {
  const given = args.find((argument) => !argument.startsWith('--'));
  const count = Number.parseInt(given ?? '10', 10);
  if (!Number.isFinite(count) || count < 1) {
    process.stderr.write(`selfplay needs a positive count, got ${String(given)}\n`);
    return 2;
  }
  const seconds = secondsOption(args);
  if (seconds === null) return 2;

  const report = runSelfPlayBatch({
    ruleset: DEFAULT_RULESET,
    seeds: Array.from({ length: count }, (_, index) => `selfplay-${index}`),
    playerCount: 2,
    maxTurns: 2000,
    computer: { thinkingMs: seconds * 1000, now: () => performance.now() },
  });
  process.stdout.write(formatSelfPlayReport(report));
  return 0;
}

/**
 * One game between computer seats that value positions differently (§9's
 * simulated, estimated and hybrid evaluations), for comparing them on the same
 * maps. A JSON line on stdout, so a batch of these can be run in parallel and
 * gathered.
 */
function headToHead(args: readonly string[]): number {
  const seed = args.find((argument) => !argument.startsWith('--'));
  const seatsOption = args.find((argument) => argument.startsWith('--seats='));
  const seats = (seatsOption?.slice('--seats='.length).split(',') ?? []).map(parseSeatSpec);
  if (seed === undefined || seats.length < 2 || seats.some((spec) => spec === null)) {
    process.stderr.write('h2h needs a seed and --seats= with two or more of simulated, estimated, hybrid, estimated-max, hybrid-max, lead, lead-win, lead-win-margin, lead-soft, each optionally with +winnable, +gold-later, +speeds, +fixed, +cheapest-search, +replayed-walks and @<exploration>\n');
    return 2;
  }
  const seconds = secondsOption(args);
  if (seconds === null) return 2;

  const { game, run } = playHeadToHead({
    ruleset: DEFAULT_RULESET,
    seed,
    seats: seats.filter((spec): spec is SeatSpec => spec !== null),
    thinkingMs: seconds * 1000,
    now: () => performance.now(),
    maxTurns: 2000,
  });
  const log = args.find((argument) => argument.startsWith('--log='))?.slice('--log='.length);
  if (log !== undefined) writeFileSync(log, formatPlaythrough(run), 'utf8');
  process.stdout.write(`${JSON.stringify(game)}\n`);
  return 0;
}

/** `--seconds=<s>`, the computer's thinking time per move; §11's 10 when absent. */
function secondsOption(args: readonly string[]): number | null {
  const option = args.find((argument) => argument.startsWith('--seconds='));
  if (option === undefined) return DEFAULT_RULESET.config.ai.MCTS_TIME_BUDGET_PER_MOVE_MS / 1000;
  const seconds = Number(option.slice('--seconds='.length));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    process.stderr.write(`--seconds needs a positive number, got ${option}\n`);
    return null;
  }
  return seconds;
}

/** The map for `--players=<n>`: today's up to 3, the larger one from 4 (Q160); today's without it. */
function playersRuleset(args: readonly string[]): Ruleset | null {
  const option = args.find((argument) => argument.startsWith('--players='));
  if (option === undefined) return DEFAULT_RULESET;
  const players = Number(option.slice('--players='.length));
  const { min, max } = DEFAULT_RULESET.config.players.PLAYER_COUNT;
  if (!Number.isInteger(players) || players < min || players > max) {
    process.stderr.write(`--players needs ${min} to ${max}, got ${option}\n`);
    return null;
  }
  return rulesetForPlayers(players);
}

function renderBatch(args: readonly string[]): number {
  const given = args.find((argument) => !argument.startsWith('--'));
  const count = Number.parseInt(given ?? '50', 10);
  if (!Number.isFinite(count) || count < 1) {
    process.stderr.write(`map:batch needs a positive count, got ${String(given)}\n`);
    return 2;
  }

  const ruleset = playersRuleset(args);
  if (ruleset === null) return 2;
  const seeds: Seed[] = Array.from({ length: count }, (_, index) => `batch-${index}`);
  const started = Date.now();
  const reports = runMapBatch({ ruleset, seeds });
  process.stdout.write(`${formatBatchReport(reports, ruleset)}\n`);
  process.stdout.write(`\n${count} maps in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  return 0;
}

/** Readable seeds, because a seed is something a reviewer types back in. */
function randomSeed(): Seed {
  const words = ['amber', 'birch', 'cairn', 'delta', 'ember', 'fjord', 'grove', 'heath', 'inlet', 'kestrel'];
  const word = words[Math.floor(Math.random() * words.length)] ?? 'amber';
  return `${word}-${Math.floor(Math.random() * 10000)}`;
}

function fileSafe(seed: Seed): string {
  return seed.replace(/[^a-zA-Z0-9._-]/g, '_');
}

process.exitCode = main(process.argv.slice(2));
