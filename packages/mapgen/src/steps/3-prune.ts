import { NotImplementedError } from '@adventure/core';
import type { GenerationStep } from '../types.ts';

/**
 * §2.1 step 3 — "Prune to budget: remove edges longest-first, with jitter, down
 * to 300 edges; reject any removal that disconnects the graph or pushes leaf
 * count outside 30–45."
 *
 * Two notes for the implementer:
 *  - The rejection here is *per removal* — a bad removal is skipped and the
 *    pruning continues; it does not abort the attempt. (Step 8's rejection,
 *    which does abort, is a different test on the finished map.)
 *  - The jitter magnitude is not specified anywhere in GDD.md. It is read from
 *    `engineering.pending.EDGE_PRUNE_JITTER`, which throws until the designer
 *    supplies one. See OPEN_QUESTIONS Q7.
 */
export const pruneStep: GenerationStep = {
  id: '3-prune',
  gdd: 'GDD.md §2.1 step 3',
  run() {
    throw new NotImplementedError('pruneStep (edge budget)', 'GDD.md §2.1 step 3');
  },
};
