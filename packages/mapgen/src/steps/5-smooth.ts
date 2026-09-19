import { NotImplementedError } from '@adventure/core';
import type { GenerationStep } from '../types.ts';

/**
 * §2.1 step 5 — "Smooth: flip isolated nodes to their majority-neighbour
 * terrain until `compactness = boundary² / area` falls below `COMPACTNESS_MAX`."
 *
 * This is the **only** place compactness is enforced. [SOURCE §1.3, chat]
 * Validate (step 8) deliberately does not re-check it, because Carve Valleys
 * (step 6) reduces compactness along the plains boundary on purpose, right
 * before validation runs — re-checking there would fail almost every map.
 *
 * Blocked on the boundary/area counting convention: see `regionMetrics` in
 * `@adventure/core` and OPEN_QUESTIONS Q4.
 */
export const smoothStep: GenerationStep = {
  id: '5-smooth',
  gdd: 'GDD.md §2.1 step 5',
  run() {
    throw new NotImplementedError('smoothStep', 'GDD.md §2.1 step 5');
  },
};
