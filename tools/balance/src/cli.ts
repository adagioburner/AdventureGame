import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_RULESET } from '@adventure/config';
import type { Seed } from '@adventure/core';
import { generateAndReport, runMapBatch } from './index.ts';
import { formatBatchReport, formatMapReport } from './report.ts';
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

  process.stderr.write(
    [
      'usage:',
      '  pnpm map [<seed>] [--json]    one map: a report, and out/maps/<seed>.svg',
      '  pnpm map:batch [<n>]          n seeds: the §11 distributions, no files',
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

  const { map, report } = generateAndReport(seed, DEFAULT_RULESET);
  process.stdout.write(`${formatMapReport(report, DEFAULT_RULESET)}\n\n`);

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

function renderBatch(args: readonly string[]): number {
  const given = args.find((argument) => !argument.startsWith('--'));
  const count = Number.parseInt(given ?? '50', 10);
  if (!Number.isFinite(count) || count < 1) {
    process.stderr.write(`map:batch needs a positive count, got ${String(given)}\n`);
    return 2;
  }

  const seeds: Seed[] = Array.from({ length: count }, (_, index) => `batch-${index}`);
  const started = Date.now();
  const reports = runMapBatch({ ruleset: DEFAULT_RULESET, seeds });
  process.stdout.write(`${formatBatchReport(reports, DEFAULT_RULESET)}\n`);
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
