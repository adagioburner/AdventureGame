import { NotImplementedError, type NodeId } from '@adventure/core';
import type { GenerationStep, MapDraft } from '../types.ts';

/**
 * §2.1 step 7 — "Place POIs: node selection and reward assignment; see §3 and §4."
 *
 * This is the one composite step. Its internal order is forced by the data
 * dependencies [INFERRED §1.3/§4.3]:
 *
 *   7a. Select POI nodes (§3).
 *   7b. Compute remoteness over those nodes (§5.1) — depends only on POI
 *       *positions*, never on their rewards, which is why it can run here.
 *   7c. Assign kinds and distribute units (§4.3), which consumes remoteness.
 *   7d. Assign guard strengths (§5.2), which consumes both remoteness and the
 *       final gold amounts from 7c.
 */
export const placePoisStep: GenerationStep = {
  id: '7-place-pois',
  gdd: 'GDD.md §2.1 step 7, §3, §4, §5',
  run() {
    throw new NotImplementedError('placePoisStep', 'GDD.md §2.1 step 7');
  },
};

/**
 * §3 — "POI placement: distributed randomly at approximately equal distances
 * from each other; every leaf node of the graph must be a POI (no dead ends);
 * leaf nodes are assigned POI status first, remaining POIs distributed randomly
 * among the rest." Counts per terrain come from `POI_COUNT` (25/20/15).
 *
 * Two things the next session needs from the designer before this is finished:
 *
 *  - "approximately equal distances" names a goal, not a procedure. Farthest-
 *    point sampling and graph-space Poisson-disc both satisfy the phrase and
 *    give visibly different maps. Left as a strategy seam. OPEN_QUESTIONS Q8.
 *  - Leaf count is 30–45 and leaves must all be POIs, but leaves are not
 *    distributed across terrains in the 25/20/15 proportions — a map can
 *    perfectly legally put 17 leaves in the mountains, which already exceeds
 *    the mountain quota of 15. GDD.md does not say which rule yields.
 *    OPEN_QUESTIONS Q9. Until answered, this throws
 *    `GenerationRejected('poi_quota_unsatisfiable')` so the map regenerates —
 *    the only option that breaks neither stated rule, but note that §2.1 step 8
 *    lists only two rejection reasons, so this is an addition, not the spec.
 */
export interface PoiPlacementStrategy {
  readonly name: string;
  select(draft: MapDraft): readonly NodeId[];
}
