import { TERRAINS, type Terrain } from '@adventure/config';
import { meetsCompactnessTarget, type NodeId } from '@adventure/core';
import { draftAsGraph } from '../graphops.ts';
import type { GenerationContext, GenerationStep, MapDraft } from '../types.ts';

/**
 * §2.1 step 5 — "Smooth: flip isolated nodes to their majority-neighbour
 * terrain until `compactness = boundary² / area` falls below `COMPACTNESS_MAX`."
 *
 * This is the **only** place compactness is enforced. [SOURCE §1.3, chat]
 * Validate (step 8) deliberately does not re-check it, because Carve Valleys
 * (step 6) reduces compactness along the plains boundary on purpose, right
 * before validation runs — re-checking there would fail almost every map.
 *
 * [SOURCE §2.1 step 5, chat] Both halves of the measurement are settled: area
 * and boundary count **nodes**, and compactness is measured **per connected
 * component**. `meetsCompactnessTarget()` in `@adventure/core` is the loop's
 * exit test — every component of every terrain below `COMPACTNESS_MAX`.
 *
 * "Isolated" is read as *outvoted*: a node whose own terrain holds fewer of its
 * neighbours than some other terrain does. Flips are applied in node order
 * within a pass and each pass sees the previous pass's result, which converges
 * faster than a simultaneous update and is just as deterministic — no PRNG is
 * drawn here at all, so this step does not move the stream the later steps
 * read from.
 *
 * The loop stops on the §2.1 condition, or when a pass changes nothing. That
 * second exit is not a failure: a map whose regions are already as blocky as
 * flipping outvoted nodes can make them goes forward as it is, and the
 * balancing harness reports the compactness it reached. Nothing here throws,
 * because §2.1 gives step 5 no rejection to throw.
 */
export const smoothStep: GenerationStep = {
  id: '5-smooth',
  gdd: 'GDD.md §2.1 step 5',
  run(draft: MapDraft, context: GenerationContext): void {
    const maximum = context.ruleset.config.map.COMPACTNESS_MAX;

    // One pass can flip at most every node, so the node count bounds the useful
    // passes; it is a safety valve on a pathological graph, not a design value.
    for (let pass = 0; pass < draft.positions.length; pass++) {
      if (meetsCompactness(draft, maximum)) return;
      if (!smoothOnce(draft)) return;
    }
  },
};

export function meetsCompactness(draft: MapDraft, maximum: number): boolean {
  const graph = draftAsGraph(draft);
  return TERRAINS.every((terrain) => meetsCompactnessTarget(graph, terrain, maximum));
}

/** One pass of outvoted-node flips. Returns whether anything changed. */
function smoothOnce(draft: MapDraft): boolean {
  let changed = false;
  for (let index = 0; index < draft.terrain.length; index++) {
    const winner = majorityTerrain(draft, index);
    if (winner === null || winner === draft.terrain[index]) continue;
    draft.terrain[index] = winner;
    changed = true;
  }
  return changed;
}

/**
 * The terrain holding strictly more of a node's neighbours than the node's own
 * terrain does, or `null` when nothing outvotes it. A tie between two *other*
 * terrains resolves by `TERRAINS` order, so the choice never depends on
 * adjacency ordering.
 */
function majorityTerrain(draft: MapDraft, index: number): Terrain | null {
  const own = draft.terrain[index];
  if (own === undefined) return null;

  const tally: Record<Terrain, number> = { plains: 0, forest: 0, mountain: 0 };
  const neighbours: readonly NodeId[] = draft.adjacency[index] ?? [];
  for (const neighbour of neighbours) {
    const terrain = draft.terrain[neighbour];
    if (terrain !== undefined) tally[terrain]++;
  }

  let winner: Terrain | null = null;
  for (const terrain of TERRAINS) {
    if (terrain === own) continue;
    if ((tally[terrain] as number) <= (tally[own] as number)) continue;
    if (winner === null || (tally[terrain] as number) > (tally[winner] as number)) winner = terrain;
  }
  return winner;
}
