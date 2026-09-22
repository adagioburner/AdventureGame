import Delaunator from 'delaunator';
import { asNodeId, type MapEdge } from '@adventure/core';
import { rebuildAdjacency } from '../graphops.ts';
import type { GenerationContext, GenerationStep, MapDraft } from '../types.ts';

/**
 * §2.1 step 2 — "Triangulate: Delaunay triangulation over the points (planar by
 * construction; planarity never needs re-checking)."
 *
 * Because planarity is guaranteed here, no later step and no validation ever
 * tests it — steps 3 and 6 only remove or recolour, never add edges.
 *
 * The triangulation itself comes from `delaunator`, the one runtime dependency
 * in the engine packages: a correct incremental Delaunay is a great deal of
 * subtle geometry, and this is the smallest well-tested implementation of it.
 * Its output is a deterministic function of the point list, which is what §1.3
 * needs — the edge list is then sorted into `(a, b)` order so nothing
 * downstream depends on the library's internal triangle ordering either.
 */
export const triangulateStep: GenerationStep = {
  id: '2-triangulate',
  gdd: 'GDD.md §2.1 step 2',
  run(draft: MapDraft, _context: GenerationContext): void {
    const coordinates = new Float64Array(draft.positions.length * 2);
    draft.positions.forEach((point, index) => {
      coordinates[index * 2] = point.x;
      coordinates[index * 2 + 1] = point.y;
    });

    const triangles = new Delaunator(coordinates).triangles;
    const seen = new Set<number>();
    const edges: MapEdge[] = [];
    const stride = draft.positions.length;

    for (let index = 0; index < triangles.length; index += 3) {
      const corners = [triangles[index] as number, triangles[index + 1] as number, triangles[index + 2] as number];
      for (let side = 0; side < 3; side++) {
        const from = corners[side] as number;
        const to = corners[(side + 1) % 3] as number;
        const low = Math.min(from, to);
        const high = Math.max(from, to);
        const key = low * stride + high;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ a: asNodeId(low), b: asNodeId(high) });
      }
    }

    edges.sort((left, right) => (left.a !== right.a ? left.a - right.a : left.b - right.b));
    draft.edges = edges;
    rebuildAdjacency(draft);
  },
};
