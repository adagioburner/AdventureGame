import { isConnected, type MapEdge } from '@adventure/core';
import { draftAsGraph, rebuildAdjacency } from '../graphops.ts';
import type { GenerationContext, GenerationStep, MapDraft } from '../types.ts';

/**
 * §2.1 step 3 — "Prune to budget: remove edges longest-first, with jitter, down
 * to 300 edges; reject any removal that disconnects the graph or pushes leaf
 * count outside 30–45."
 *
 * Two notes for the reader:
 *  - The rejection here is *per removal* — a bad removal is skipped and the
 *    pruning continues; it does not abort the attempt. (Step 8's rejection,
 *    which does abort, is a different test on the finished map.)
 *  - [SOURCE §2.1 step 3, chat] The jitter: "we can choose randomly from the
 *    longest EDGE_PRUNE_JITTER = 10 edges". So each removal draws uniformly
 *    among the 10 longest edges still present, rather than taking the single
 *    longest. `EDGE_PRUNE_JITTER = 1` would be strict longest-first.
 *
 * **Only the upper leaf bound can bite here, and a skipped edge is skipped for
 * good.** Both follow from one fact: among removals that keep the graph
 * connected, both endpoints had degree ≥ 2, so no node ever *stops* being a
 * leaf and the count only climbs. It starts at 0 — a Delaunay triangulation has
 * no degree-1 node — so no removal can push it below `LEAF_COUNT.min`; that end
 * of the range is step 8's test on the finished map. And a removal refused now
 * is refused for ever, because a bridge stays a bridge and a leaf count that is
 * already too high only grows. That is what lets a refused edge leave the
 * candidate pool rather than being drawn over and over.
 */
export const pruneStep: GenerationStep = {
  id: '3-prune',
  gdd: 'GDD.md §2.1 step 3',
  run(draft: MapDraft, context: GenerationContext): void {
    const { MAP_EDGE_COUNT, EDGE_PRUNE_JITTER, LEAF_COUNT } = context.ruleset.config.map;

    // The triangulation's edge list is the frame of reference for the whole
    // step: `order`, `removed` and `skipped` all index into it, and the draft's
    // own list is rebuilt from it whenever the graph actually changes.
    const all: readonly MapEdge[] = draft.edges;
    const length = all.map((edge) => edgeLength(draft, edge));

    // Longest first. The `(a, b)` tie-break keeps two equal lengths in a fixed
    // order, so the candidate window is a function of the edge set alone.
    const order = all
      .map((_, index) => index)
      .sort((left, right) => {
        const byLength = (length[right] as number) - (length[left] as number);
        if (byLength !== 0) return byLength;
        const a = all[left] as MapEdge;
        const b = all[right] as MapEdge;
        return a.a !== b.a ? a.a - b.a : a.b - b.b;
      });

    const removed = new Array<boolean>(all.length).fill(false);
    const skipped = new Array<boolean>(all.length).fill(false);
    const degree = new Array<number>(draft.positions.length).fill(0);
    for (const edge of all) {
      degree[edge.a] = (degree[edge.a] as number) + 1;
      degree[edge.b] = (degree[edge.b] as number) + 1;
    }

    const surviving = (extra: number | null): MapEdge[] =>
      all.filter((_, index) => !removed[index] && index !== extra);

    let live = all.length;
    let leaves = degree.filter((value) => value === 1).length;
    let cursor = 0;

    while (live > MAP_EDGE_COUNT) {
      while (cursor < order.length && settled(order[cursor] as number)) cursor++;
      const window: number[] = [];
      for (let scan = cursor; scan < order.length && window.length < EDGE_PRUNE_JITTER; scan++) {
        const candidate = order[scan] as number;
        if (!settled(candidate)) window.push(candidate);
      }
      if (window.length === 0) break;

      const choice = context.rng.pick(window);
      const edge = all[choice] as MapEdge;
      const leavesAfter = leaves + (degree[edge.a] === 2 ? 1 : 0) + (degree[edge.b] === 2 ? 1 : 0);

      if (leavesAfter > LEAF_COUNT.max || !staysConnected(draft, surviving(choice))) {
        skipped[choice] = true;
        continue;
      }

      removed[choice] = true;
      live--;
      leaves = leavesAfter;
      degree[edge.a] = (degree[edge.a] as number) - 1;
      degree[edge.b] = (degree[edge.b] as number) - 1;
    }

    draft.edges = surviving(null);
    rebuildAdjacency(draft);

    function settled(index: number): boolean {
      return (removed[index] ?? false) || (skipped[index] ?? false);
    }
  },
};

function edgeLength(draft: MapDraft, edge: MapEdge): number {
  const from = draft.positions[edge.a];
  const to = draft.positions[edge.b];
  if (from === undefined || to === undefined) throw new RangeError('edge references a node with no position');
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function staysConnected(draft: MapDraft, edges: MapEdge[]): boolean {
  const trial: MapDraft = { ...draft, edges, adjacency: [] };
  rebuildAdjacency(trial);
  return isConnected(draftAsGraph(trial));
}
