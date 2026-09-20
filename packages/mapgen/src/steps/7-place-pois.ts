import { NotImplementedError, type NodeId } from '@adventure/core';
import type { Terrain } from '@adventure/config';
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
 * [SOURCE §3, chat] "Let us prototype and choose" — so "approximately equal
 * distances" stays a strategy seam with more than one implementation, and the
 * balancing harness compares them on real maps. Two candidates to build:
 * farthest-point sampling and Poisson-disc in graph space. Both satisfy the
 * phrase and give visibly different maps.
 */
export interface PoiPlacementStrategy {
  readonly name: string;
  /** POI nodes for one terrain, excluding the leaves already forced in. */
  select(draft: MapDraft, terrain: Terrain, forced: readonly NodeId[], count: number): readonly NodeId[];
}

/**
 * Surplus leaves.
 *
 * §3 forces every leaf to be a POI, but leaf count (30–45) is not apportioned
 * across terrains in the 25/20/15 proportions, so a terrain can legally hold
 * more leaves than its quota — e.g. 17 leaves in the mountains against a quota
 * of 15.
 *
 * [SOURCE §3/§9, chat] "Fill the extra leaf nodes with stamina rewards." So the
 * §4.2 quota is satisfied exactly as written and the surplus leaves become
 * *additional* POIs outside the table, each carrying `stamina`. Two things
 * follow:
 *
 *  - a map can hold slightly more than 60 POIs, and total POI count is no
 *    longer fixed;
 *  - `stamina`, which appears in §4.1's seven kinds but in no §4.2 row, finally
 *    has a home — [SOURCE §4.2, chat] "proceed now without stamina, add later
 *    as a config edit", and this is the one place it is placed meanwhile.
 *
 * These POIs are unguarded: §4.2 is what decides guarding (v1 guards gold only),
 * and they are not in it. They are ordinary POIs otherwise — the remoteness
 * walk visits them and the AI targets them like any other.
 *
 * How many units each is not specified; see `OVERFLOW_LEAF_STAMINA_UNITS` and
 * OPEN_QUESTIONS Q9a.
 */
export function overflowLeafPois(
  _draft: MapDraft,
  _terrain: Terrain,
  _leaves: readonly NodeId[],
  _quota: number,
): readonly NodeId[] {
  throw new NotImplementedError('overflowLeafPois', 'GDD.md §3 / §4.2, chat');
}
