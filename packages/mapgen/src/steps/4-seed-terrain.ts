import { TERRAINS, type Terrain } from '@adventure/config';
import { asNodeId, degree, type NodeId } from '@adventure/core';
import { draftAsGraph } from '../graphops.ts';
import { bestGrowthCandidate, hopDistances, rebalanceTerrainShares, terrainTargets } from '../terraingrowth.ts';
import { GenerationRejected, type GenerationContext, type GenerationStep, type MapDraft } from '../types.ts';

/**
 * §2.1 step 4 — "Seed terrain regions: 1 or 2 seeds per terrain (plains,
 * forest, mountain); grow by flood fill biased toward nodes with more
 * same-terrain neighbours, until area shares are approximately 45% plains /
 * 30% forest / 25% mountain."
 *
 * The bias toward same-terrain neighbours is what produces §1's "generally
 * rounded" regions before Smooth ever runs. Targets come from
 * `TERRAIN_AREA_SHARE` and are approximate.
 *
 * Three implementation choices §2.1 leaves open, and why each is the way it is.
 * All three exist to answer the same hazard, which only shows up once you run
 * the step on a real map: **a pruned map is nearly a tree** — ~240 nodes and
 * 300 edges is a mean degree of 2.5 — so a region can be *sealed off*, with
 * every node next to it already taken, long before it has reached its share.
 * A sealed region stops growing whatever its deficit, and the terrains that are
 * still growing swallow the rest of the map.
 *
 *  1. **Whose turn it is** — the terrain furthest below its target as a
 *     *fraction* of that target, so plains' larger quota does not simply win
 *     every round and the three arrive at their shares together.
 *  2. **Where the seeds go** — farthest-point sampling over hop distance,
 *     restricted to nodes of degree 3 or more. A seed on a leaf, or down a
 *     branch, is sealed after a handful of nodes; a seed at a junction, far
 *     from the others, is not. Measured over 24 seeds this is what brings the
 *     share error down from around 9 points per terrain to around 3.
 *  3. **Which frontier node** — `bestGrowthCandidate`, shared with step 6:
 *     the one with the most neighbours already of this terrain (§2.1's own
 *     bias), then the one closest to the region's existing nodes, then a draw
 *     from the PRNG. Growing shallowest-first spreads a region evenly instead
 *     of letting it run off down one branch, which is the other half of not
 *     getting sealed.
 *
 * A region sealed off anyway simply stops, and the terrains still growing take
 * what is left — which is why the fill on its own finishes well wide of the
 * shares, overshooting on plains, the largest quota and so the last one still
 * growing. So the fill is only half the step. `rebalanceTerrainShares` then
 * moves nodes from whichever terrain is over its share to whichever is under,
 * which *cannot* be sealed off — the surplus terrain is by definition still
 * everywhere — and that is what finally satisfies the "until area shares are
 * approximately 45 / 30 / 25" the step is named for. Measured over 40 seeds,
 * the pipeline without it finished with the mountain share anywhere from 6.4%
 * to 31.0%; with it, 21.8% to 25.2%.
 *
 * None of this is a rejection: §2.1 calls the shares approximate, and §2.1
 * step 5 is the step that answers for a region's shape.
 * `terrain_share_unreachable` is kept for the one case that truly cannot
 * proceed — a graph too small to seed every terrain at all.
 */
export const seedTerrainStep: GenerationStep = {
  id: '4-seed-terrain',
  gdd: 'GDD.md §2.1 step 4',
  run(draft: MapDraft, context: GenerationContext): void {
    const { rng } = context;
    const { TERRAIN_AREA_SHARE } = context.ruleset.config.map;
    const nodeCount = draft.positions.length;

    const assigned = new Array<Terrain | null>(nodeCount).fill(null);
    const counts: Record<Terrain, number> = { plains: 0, forest: 0, mountain: 0 };
    const targets: Record<Terrain, number> = {
      plains: TERRAIN_AREA_SHARE.plains * nodeCount,
      forest: TERRAIN_AREA_SHARE.forest * nodeCount,
      mountain: TERRAIN_AREA_SHARE.mountain * nodeCount,
    };

    const plan: Terrain[] = [];
    for (const terrain of TERRAINS) {
      for (let count = rng.nextIntInclusive(1, 2); count > 0; count--) plan.push(terrain);
    }
    if (nodeCount < plan.length) {
      throw new GenerationRejected(
        'terrain_share_unreachable',
        '4-seed-terrain',
        `${nodeCount} nodes cannot hold ${plan.length} terrain seeds`,
      );
    }

    const graph = draftAsGraph(draft);
    const junctions = new Set<NodeId>();
    for (const node of graph.nodes) if (degree(graph, node.id) >= 3) junctions.add(node.id);

    const seeds: NodeId[] = [];
    for (const terrain of plan) {
      const free = allNodes(nodeCount).filter((node) => assigned[node] === null);
      const preferred = free.filter((node) => junctions.has(node));
      const pool = preferred.length > 0 ? preferred : free;
      const node = seeds.length === 0 ? rng.pick(pool) : farthestFrom(draft, seeds, pool, rng);
      assigned[node] = terrain;
      counts[terrain]++;
      seeds.push(node);
    }

    for (let remaining = nodeCount - plan.length; remaining > 0; remaining--) {
      const terrain = neediestGrowableTerrain(draft, assigned, counts, targets);
      if (terrain === null) break;
      const node = bestFrontierNode(draft, assigned, terrain, rng);
      if (node === null) break;
      assigned[node] = terrain;
      counts[terrain]++;
    }

    // Anything the flood fill could not reach at all — only possible on a graph
    // step 8 would reject as disconnected — falls to plains, §2.1's majority
    // terrain.
    draft.terrain = assigned.map((terrain) => terrain ?? 'plains');

    // Nothing to protect yet: the valleys do not exist until step 6.
    rebalanceTerrainShares(
      draft.terrain,
      draft.adjacency,
      terrainTargets(nodeCount, TERRAIN_AREA_SHARE),
      new Set(),
      rng,
    );
  },
};

function allNodes(count: number): NodeId[] {
  return Array.from({ length: count }, (_, index) => asNodeId(index));
}

/** The candidate furthest (in hops) from every seed placed so far; ties drawn from the PRNG. */
function farthestFrom(
  draft: MapDraft,
  seeds: readonly NodeId[],
  pool: readonly NodeId[],
  rng: GenerationContext['rng'],
): NodeId {
  const distance = hopDistances(draft.adjacency, seeds);
  let best: NodeId[] = [];
  let bestDistance = -1;
  for (const candidate of pool) {
    const value = distance[candidate] as number;
    if (value > bestDistance) {
      bestDistance = value;
      best = [candidate];
    } else if (value === bestDistance) {
      best.push(candidate);
    }
  }
  return rng.pick(best.length > 0 ? best : pool);
}

/**
 * The terrain furthest below its target share that still has somewhere to grow.
 * Deficit is measured as a fraction of the target so that plains, with the
 * largest quota, does not simply win every round.
 */
function neediestGrowableTerrain(
  draft: MapDraft,
  assigned: readonly (Terrain | null)[],
  counts: Record<Terrain, number>,
  targets: Record<Terrain, number>,
): Terrain | null {
  let best: Terrain | null = null;
  let bestDeficit = Number.NEGATIVE_INFINITY;
  let fallback: Terrain | null = null;

  for (const terrain of TERRAINS) {
    if (!hasFrontier(draft, assigned, terrain)) continue;
    fallback ??= terrain;
    const deficit = ((targets[terrain] as number) - (counts[terrain] as number)) / (targets[terrain] as number);
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      best = terrain;
    }
  }

  // Every terrain has met its target but nodes are still unassigned: hand them
  // to whichever terrain can take them rather than leaving holes in the map.
  return bestDeficit > 0 ? best : fallback;
}

function hasFrontier(draft: MapDraft, assigned: readonly (Terrain | null)[], terrain: Terrain): boolean {
  for (let node = 0; node < assigned.length; node++) {
    if (assigned[node] !== terrain) continue;
    for (const neighbour of draft.adjacency[node] ?? []) {
      if (assigned[neighbour] === null) return true;
    }
  }
  return false;
}

/**
 * The next node to flood into: most neighbours already of this terrain (§2.1's
 * bias), then shallowest from the region's existing nodes, then a draw from the
 * PRNG. See the note on the step for why the depth term is there.
 */
function bestFrontierNode(
  draft: MapDraft,
  assigned: readonly (Terrain | null)[],
  terrain: Terrain,
  rng: GenerationContext['rng'],
): NodeId | null {
  const own: NodeId[] = [];
  for (let index = 0; index < assigned.length; index++) {
    if (assigned[index] === terrain) own.push(asNodeId(index));
  }
  return bestGrowthCandidate(draft.adjacency, own, (node) => assigned[node] === null, rng);
}
