import { NotImplementedError } from '@adventure/core';
import type { GenerationStep } from '../types.ts';

/**
 * §2.1 step 1 — "Sample positions: Poisson-disc sampling over the map
 * rectangle, ~240 points."
 *
 * `MAP_NODE_COUNT` is a target, not an exact count; the disc radius is derived
 * from it and `MAP_COORDINATE_SPACE` via `POISSON_RADIUS_FACTOR`, which is an
 * engineering knob, not a design value.
 */
export const sampleStep: GenerationStep = {
  id: '1-sample',
  gdd: 'GDD.md §2.1 step 1',
  run() {
    throw new NotImplementedError('sampleStep (Poisson-disc)', 'GDD.md §2.1 step 1');
  },
};
