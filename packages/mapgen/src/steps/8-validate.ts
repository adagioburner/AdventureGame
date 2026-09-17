import { asNodeId, isConnected, leafNodes, type MapGraph } from '@adventure/core';
import { GenerationRejected, type GenerationStep, type MapDraft } from '../types.ts';

/**
 * §2.1 step 8 — "Validate: reject and regenerate the whole map if:
 * disconnected, or leaf count outside 30–45."
 *
 * Exactly those two tests, and no third. In particular **compactness is not
 * re-checked here** — [SOURCE §1.3, chat] step 6 has just lowered it on purpose
 * and re-testing would reject nearly every map. Compactness is enforced only
 * inside step 5. Do not "tighten" this step.
 */
export const validateStep: GenerationStep = {
  id: '8-validate',
  gdd: 'GDD.md §2.1 step 8',
  run(draft: MapDraft, context) {
    const graph = draftAsGraph(draft);

    if (!isConnected(graph)) {
      throw new GenerationRejected('disconnected', '8-validate', 'graph has more than one component');
    }

    const { min, max } = context.ruleset.config.map.LEAF_COUNT;
    const leaves = leafNodes(graph).length;
    if (leaves < min || leaves > max) {
      throw new GenerationRejected('leaf_count_out_of_range', '8-validate', `${leaves} leaves, want ${min}–${max}`);
    }
  },
};

/** View of the draft as a `MapGraph`, for the shared graph predicates. */
function draftAsGraph(draft: MapDraft): MapGraph {
  return {
    nodes: draft.positions.map((position, index) => ({
      id: asNodeId(index),
      position,
      terrain: draft.terrain[index] ?? 'plains',
    })),
    edges: draft.edges,
    adjacency: draft.adjacency,
  };
}
