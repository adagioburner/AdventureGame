import { NotImplementedError } from '@adventure/core';
import type { GenerationStep } from '../types.ts';

/**
 * §2.1 step 2 — "Triangulate: Delaunay triangulation over the points (planar by
 * construction; planarity never needs re-checking)."
 *
 * Because planarity is guaranteed here, no later step and no validation ever
 * tests it — steps 3 and 6 only remove or recolour, never add edges.
 */
export const triangulateStep: GenerationStep = {
  id: '2-triangulate',
  gdd: 'GDD.md §2.1 step 2',
  run() {
    throw new NotImplementedError('triangulateStep (Delaunay)', 'GDD.md §2.1 step 2');
  },
};
