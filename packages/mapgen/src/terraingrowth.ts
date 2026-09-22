import { TERRAINS, type Terrain } from '@adventure/config';
import { asNodeId, type NodeId } from '@adventure/core';
import type { GenerationContext } from './types.ts';

/**
 * §2.1's flood-fill growth rule, in one place.
 *
 * Step 4 grows the three regions out of their seeds into *unclaimed* ground,
 * and step 6 resumes that same growth into *plains* once the valleys are cut.
 * Both are the same operation — "grow by flood fill biased toward nodes with
 * more same-terrain neighbours" — and they only differ in which nodes they are
 * allowed to take, so the rule lives here and each caller supplies its own
 * eligibility test.
 */

/** Hop distance from a set of sources to every node; `Infinity` where unreachable. */
export function hopDistances(adjacency: readonly (readonly NodeId[])[], sources: readonly NodeId[]): number[] {
  const distance = new Array<number>(adjacency.length).fill(Number.POSITIVE_INFINITY);
  const queue: NodeId[] = [];
  for (const source of sources) {
    distance[source] = 0;
    queue.push(source);
  }
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head] as NodeId;
    for (const neighbour of adjacency[node] ?? []) {
      if ((distance[neighbour] as number) !== Number.POSITIVE_INFINITY) continue;
      distance[neighbour] = (distance[node] as number) + 1;
      queue.push(neighbour);
    }
  }
  return distance;
}

/**
 * The next node a region should flood into: the eligible node with the most
 * neighbours already in the region (§2.1's stated bias), then the one
 * shallowest from the region's existing nodes, then a draw from the PRNG.
 *
 * The depth term is what stops a region running off down one branch of a graph
 * this sparse; see the note on step 4. Same-terrain neighbours dominate the
 * score outright — any depth is bounded by the node count, so the second term
 * can only separate nodes that tie on the first.
 *
 * Returns `null` when the region has no eligible neighbour left, which is the
 * signal that it can grow no further.
 */
export function bestGrowthCandidate(
  adjacency: readonly (readonly NodeId[])[],
  own: readonly NodeId[],
  isEligible: (node: NodeId) => boolean,
  rng: GenerationContext['rng'],
): NodeId | null {
  const inRegion = new Set<NodeId>(own);
  const depth = hopDistances(adjacency, own);

  let best: NodeId[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < adjacency.length; index++) {
    const node = asNodeId(index);
    if (inRegion.has(node) || !isEligible(node)) continue;

    let same = 0;
    for (const neighbour of adjacency[node] ?? []) {
      if (inRegion.has(neighbour)) same++;
    }
    if (same === 0) continue;

    const score = same * (adjacency.length + 1) - (depth[node] as number);
    if (score > bestScore) {
      bestScore = score;
      best = [node];
    } else if (score === bestScore) {
      best.push(node);
    }
  }

  return best.length === 0 ? null : rng.pick(best);
}

/**
 * §2.1's shares as whole nodes, by largest remainder, so the three sum to the
 * node count exactly. Fractional targets would leave a terrain a fraction of a
 * node under its share for ever, and `rebalanceTerrainShares` would hand nodes
 * back and forth across that fraction without ever settling.
 */
export function terrainTargets(
  nodeCount: number,
  shares: Readonly<Record<Terrain, number>>,
): Record<Terrain, number> {
  const exact = TERRAINS.map((terrain) => ({ terrain, value: shares[terrain] * nodeCount }));
  const targets: Record<Terrain, number> = { plains: 0, forest: 0, mountain: 0 };
  for (const { terrain, value } of exact) targets[terrain] = Math.floor(value);

  let left = nodeCount - TERRAINS.reduce((sum, terrain) => sum + targets[terrain], 0);
  const byRemainder = [...exact].sort((a, b) => b.value - Math.floor(b.value) - (a.value - Math.floor(a.value)));
  for (const { terrain } of byRemainder) {
    if (left <= 0) break;
    targets[terrain]++;
    left--;
  }
  return targets;
}

/**
 * Move nodes from the terrains that are over their share to the ones that are
 * under it, until the shares hold or nothing can move.
 *
 * This is §2.1 step 4's own sentence — "grow ... until area shares are
 * approximately 45% plains / 30% forest / 25% mountain" — finished. The flood
 * fill alone cannot get there on a graph this sparse, because a region is
 * routinely *sealed off* with every neighbouring node already claimed while it
 * is still far short; whatever is still growing then takes the rest of the map.
 * Growing into another terrain's ground instead of into unclaimed ground cannot
 * be sealed, because the surplus terrain is by definition still everywhere.
 *
 * Every move takes one node from a terrain strictly above its target and gives
 * it to one strictly below, so the total deviation falls by two each time and
 * the loop cannot cycle. A terrain that cannot reach a surplus node yields to
 * the next neediest rather than ending the pass, so one walled-in region does
 * not strand the others; when none of them can reach one, the map keeps the
 * shares it has, which is what §2.1's "approximately" allows for.
 *
 * `locked` names nodes that may not change hands — step 6 uses it to protect a
 * valley it has just carved.
 */
export function rebalanceTerrainShares(
  terrain: Terrain[],
  adjacency: readonly (readonly NodeId[])[],
  targets: Readonly<Record<Terrain, number>>,
  locked: ReadonlySet<NodeId>,
  rng: GenerationContext['rng'],
): void {
  const counts: Record<Terrain, number> = { plains: 0, forest: 0, mountain: 0 };
  for (const value of terrain) counts[value]++;

  let deviation = TERRAINS.reduce((sum, value) => sum + Math.abs(counts[value] - targets[value]), 0);
  while (deviation > 0) {
    if (!moveOneNode(terrain, adjacency, counts, targets, locked, rng)) return;
    deviation -= 2;
  }
}

function moveOneNode(
  terrain: Terrain[],
  adjacency: readonly (readonly NodeId[])[],
  counts: Record<Terrain, number>,
  targets: Readonly<Record<Terrain, number>>,
  locked: ReadonlySet<NodeId>,
  rng: GenerationContext['rng'],
): boolean {
  // Neediest first, as a fraction of the target so the largest quota does not
  // simply win every round; `sort` is stable, so equal deficits keep TERRAINS
  // order and the pass stays reproducible.
  const needy = TERRAINS.filter((value) => counts[value] < targets[value]).sort(
    (left, right) =>
      (targets[right] - counts[right]) / targets[right] - (targets[left] - counts[left]) / targets[left],
  );

  const take = (wanted: Terrain, from: (terrain: Terrain) => boolean): NodeId | null => {
    const own: NodeId[] = [];
    for (let index = 0; index < terrain.length; index++) {
      if (terrain[index] === wanted) own.push(asNodeId(index));
    }
    return bestGrowthCandidate(
      adjacency,
      own,
      (candidate) => {
        if (locked.has(candidate)) return false;
        const owner = terrain[candidate];
        return owner !== undefined && owner !== wanted && from(owner);
      },
      rng,
    );
  };
  const give = (node: NodeId, to: Terrain): void => {
    counts[terrain[node] as Terrain]--;
    terrain[node] = to;
    counts[to]++;
  };
  const surplus = (value: Terrain): boolean => counts[value] > targets[value];

  for (const wanted of needy) {
    const node = take(wanted, surplus);
    if (node !== null) {
      give(node, wanted);
      return true;
    }
  }

  // Nobody can reach a surplus terrain directly. On a graph this sparse a
  // region is routinely walled in by a terrain that is *already* at its target
  // and so has nothing to spare — which, before this existed, left the shares
  // stuck as much as ten points out on the odd map. So trade instead: the
  // neighbour hands one node over and immediately takes one back from a
  // terrain that does have a surplus. It nets out at one node off the surplus
  // and one onto the terrain that was short, exactly as a direct move does, so
  // the total deviation still falls by two and the pass still cannot cycle.
  for (const wanted of needy) {
    for (const through of TERRAINS) {
      if (through === wanted || surplus(through)) continue;

      const node = take(wanted, (owner) => owner === through);
      if (node === null) continue;
      const was = terrain[node] as Terrain;
      give(node, wanted);

      const replacement = take(through, surplus);
      if (replacement !== null) {
        give(replacement, through);
        return true;
      }
      give(node, was);
    }
  }

  return false;
}
