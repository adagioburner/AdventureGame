import { asNodeId, type MapGraph, type NodeId } from '@adventure/core';
import type { MapDraft } from './types.ts';

/**
 * `MapDraft.adjacency` is "indexed by node id; rebuilt whenever `edges`
 * changes" — this is that rebuild, in one place so no step can forget a half
 * of it. Neighbour lists come out ascending, which keeps every traversal in
 * the pipeline a function of the edge set alone.
 */
export function rebuildAdjacency(draft: MapDraft): void {
  const adjacency: NodeId[][] = draft.positions.map((): NodeId[] => []);
  for (const edge of draft.edges) {
    (adjacency[edge.a] as NodeId[]).push(edge.b);
    (adjacency[edge.b] as NodeId[]).push(edge.a);
  }
  for (const list of adjacency) list.sort((left, right) => left - right);
  draft.adjacency = adjacency;
}

/**
 * The draft seen as a `MapGraph`, so the shared predicates in `@adventure/core`
 * — connectivity, leaves, compactness — run against a work in progress exactly
 * as they run against a sealed map. Terrain defaults to plains for a draft that
 * has not reached step 4 yet, which only the connectivity and leaf predicates
 * are ever asked about.
 */
export function draftAsGraph(draft: MapDraft): MapGraph {
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
