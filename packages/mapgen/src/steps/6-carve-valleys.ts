import { NotImplementedError } from '@adventure/core';
import type { GenerationStep } from '../types.ts';

/**
 * §2.1 step 6 — "Carve valleys: convert 2–4 narrow (1-node-wide) fingers of
 * 5–12 nodes from the plains boundary into neighbouring regions; these nodes
 * are exempted from the Smooth step (there is only the one Smooth pass, above —
 * Carve Valleys runs once, after it)."
 *
 * Counts and lengths come from `VALLEY_COUNT`, `VALLEY_WIDTH`, `VALLEY_LENGTH`.
 * Carved nodes are recorded in `draft.valleyNodes`; see the note on that field
 * for why the exemption is currently satisfied by ordering alone.
 */
export const carveValleysStep: GenerationStep = {
  id: '6-carve-valleys',
  gdd: 'GDD.md §2.1 step 6',
  run() {
    throw new NotImplementedError('carveValleysStep', 'GDD.md §2.1 step 6');
  },
};
