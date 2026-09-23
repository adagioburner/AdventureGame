import { DEFAULT_RULESET } from '@adventure/config';
import type { GameMap, Seed } from '@adventure/core';
import { generateMap } from '@adventure/mapgen';
import { defaultRemotenessScorer } from '@adventure/sim';

/**
 * The map for a seed. Generation is client-side by §12.1, so the page needs no
 * server and no file: the seed is the whole input.
 */
export function mapFor(seed: Seed): GameMap {
  return generateMap({ seed, ruleset: DEFAULT_RULESET, remotenessScorer: defaultRemotenessScorer });
}

/** A shareable random seed, for `?seed=` with no value. */
export function randomSeed(): Seed {
  const words = ['amber', 'birch', 'cairn', 'delta', 'ember', 'fjord', 'glade', 'heath', 'islet', 'juniper'];
  const pick = (): string => words[Math.floor(Math.random() * words.length)] ?? 'amber';
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 1000)}`;
}

export function initialSeed(): Seed {
  try {
    const given = new URLSearchParams(window.location.search).get('seed');
    if (given !== null && given.trim().length > 0) return given.trim();
  } catch {
    // No readable address (an embedded preview): fall through to a random seed.
  }
  return randomSeed();
}

export function writeSeed(seed: Seed): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', seed);
    window.history.replaceState(null, '', url);
  } catch {
    // Some embedded frames refuse history changes; the seed box still shows it.
  }
}
