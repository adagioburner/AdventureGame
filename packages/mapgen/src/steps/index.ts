import type { GenerationStep } from '../types.ts';
import { sampleStep } from './1-sample.ts';
import { triangulateStep } from './2-triangulate.ts';
import { pruneStep } from './3-prune.ts';
import { seedTerrainStep } from './4-seed-terrain.ts';
import { smoothStep } from './5-smooth.ts';
import { carveValleysStep } from './6-carve-valleys.ts';
import { placePoisStep } from './7-place-pois.ts';
import { validateStep } from './8-validate.ts';

/**
 * §2.1 — "Steps run in this exact order". The array *is* the spec; nothing may
 * reorder it, and a step may not be skipped conditionally.
 */
export const GENERATION_PIPELINE: readonly GenerationStep[] = [
  sampleStep,
  triangulateStep,
  pruneStep,
  seedTerrainStep,
  smoothStep,
  carveValleysStep,
  placePoisStep,
  validateStep,
];

export {
  sampleStep,
  triangulateStep,
  pruneStep,
  seedTerrainStep,
  smoothStep,
  carveValleysStep,
  placePoisStep,
  validateStep,
};
export type { PoiPlacementStrategy } from './7-place-pois.ts';
export { overflowLeafPois } from './7-place-pois.ts';
