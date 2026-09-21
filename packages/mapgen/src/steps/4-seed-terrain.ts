import { NotImplementedError } from '@adventure/core';
import type { GenerationStep } from '../types.ts';

/**
 * §2.1 step 4 — "Seed terrain regions: 1 or 2 seeds per terrain (plains,
 * forest, mountain); grow by flood fill biased toward nodes with more
 * same-terrain neighbours, until area shares are approximately 45% plains /
 * 30% forest / 25% mountain."
 *
 * The bias toward same-terrain neighbours is what produces §1's "generally
 * rounded" regions before Smooth ever runs. Targets come from
 * `TERRAIN_AREA_SHARE` and are approximate.
 */
export const seedTerrainStep: GenerationStep = {
  id: '4-seed-terrain',
  gdd: 'GDD.md §2.1 step 4',
  run() {
    throw new NotImplementedError('seedTerrainStep (flood fill)', 'GDD.md §2.1 step 4');
  },
};
