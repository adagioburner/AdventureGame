import { TERRAINS, type MapConfig, type Terrain } from '@adventure/config';
import { asNodeId, type MapEdge, type NodeId } from '@adventure/core';
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

/**
 * [Q245] What keeps separate areas of a terrain apart while terrain grows
 * (`KEPT_APART`): the ground the areas are measured on, which terrains, each
 * space's gap, and whether the share balancing may join two areas when
 * nothing else can reach the shares (916).
 *
 * "Apart" is measured on the ground, step 2's triangulation, not only by road:
 * two areas side by side with no road between them still read as one area on
 * the map, and that is how most areas met before this existed.
 *
 * [Q245, 917] `gaps[node]` is how many spaces a terrain must keep between two
 * of its areas when it takes `node`. Every space draws its own, so two areas
 * stop one space apart in some places and further in others, and the plains
 * between them winds; one gap for the whole map drew it as a straight line.
 */
export interface KeptApart {
  readonly ground: readonly (readonly NodeId[])[];
  readonly terrains: ReadonlySet<Terrain>;
  readonly gaps: readonly number[];
  readonly joinForShares: boolean;
}

/**
 * Each space's gap, drawn from `KEPT_APART.GAP` once per map, by step 4; empty,
 * with nothing drawn, when `KEPT_APART` names no terrain.
 */
export function drawApartGaps(map: MapConfig, nodeCount: number, rng: GenerationContext['rng']): number[] {
  const config = map.KEPT_APART;
  if (config.TERRAINS.length === 0) return [];
  return Array.from({ length: nodeCount }, () => rng.nextIntInclusive(config.GAP.min, config.GAP.max));
}

/**
 * `KEPT_APART` for a draft with this triangulation and the `gaps` step 4 drew;
 * `null` when it names no terrain, and on a draft step 4 drew no gaps for.
 */
export function keptApartOf(map: MapConfig, triangulation: readonly MapEdge[], gaps: readonly number[]): KeptApart | null {
  const config = map.KEPT_APART;
  if (config.TERRAINS.length === 0 || gaps.length === 0) return null;
  const ground: NodeId[][] = Array.from({ length: gaps.length }, () => []);
  for (const edge of triangulation) {
    (ground[edge.a] as NodeId[]).push(edge.b);
    (ground[edge.b] as NodeId[]).push(edge.a);
  }
  return { ground, terrains: new Set(config.TERRAINS), gaps, joinForShares: config.JOIN_FOR_SHARES };
}

/** Which area of the nodes `isOwn` picks each node is in, on the ground; -1 for every other node. */
export function areaLabels(ground: readonly (readonly NodeId[])[], isOwn: (node: NodeId) => boolean): Int32Array {
  const label = new Int32Array(ground.length).fill(-1);
  let next = 0;
  for (let start = 0; start < ground.length; start++) {
    if (label[start] !== -1 || !isOwn(asNodeId(start))) continue;
    const queue = [start];
    label[start] = next;
    for (let head = 0; head < queue.length; head++) {
      for (const neighbour of ground[queue[head] as number] ?? []) {
        if (label[neighbour] !== -1 || !isOwn(neighbour)) continue;
        label[neighbour] = next;
        queue.push(neighbour);
      }
    }
    next++;
  }
  return label;
}

/**
 * Whether giving `node` to the labelled terrain would bring two of its areas
 * within `gap` spaces of each other: true when the terrain's nodes within `gap`
 * ground steps of `node` belong to more than one area.
 */
export function wouldJoin(ground: readonly (readonly NodeId[])[], label: Int32Array, node: NodeId, gap: number): boolean {
  const steps = new Map<NodeId, number>([[node, 0]]);
  const queue: NodeId[] = [node];
  let area = -1;
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head] as NodeId;
    const own = at === node ? -1 : (label[at] as number);
    if (own !== -1) {
      if (area === -1) area = own;
      else if (area !== own) return true;
    }
    const step = steps.get(at) as number;
    if (step === gap) continue;
    for (const neighbour of ground[at] ?? []) {
      if (steps.has(neighbour)) continue;
      steps.set(neighbour, step + 1);
      queue.push(neighbour);
    }
  }
  return false;
}

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
 *
 * [Q245] With `apart`, a kept-apart terrain never takes a node that would bring
 * two of its areas within the gap; when that leaves nothing able to move, the
 * pass joins two areas only if `apart.joinForShares` (916), and otherwise
 * keeps the shares it has.
 */
export function rebalanceTerrainShares(
  terrain: Terrain[],
  adjacency: readonly (readonly NodeId[])[],
  targets: Readonly<Record<Terrain, number>>,
  locked: ReadonlySet<NodeId>,
  rng: GenerationContext['rng'],
  apart: KeptApart | null = null,
): void {
  const counts: Record<Terrain, number> = { plains: 0, forest: 0, mountain: 0 };
  for (const value of terrain) counts[value]++;

  let deviation = TERRAINS.reduce((sum, value) => sum + Math.abs(counts[value] - targets[value]), 0);
  while (deviation > 0) {
    if (!moveOneNode(terrain, adjacency, counts, targets, locked, rng, apart)) {
      // [Q245, 916] Keeping areas apart left nothing that can move: two areas
      // may join for the shares only where `JOIN_FOR_SHARES` allows it.
      if (apart === null || !apart.joinForShares) return;
      if (!moveOneNode(terrain, adjacency, counts, targets, locked, rng, null)) return;
    }
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
  apart: KeptApart | null,
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
    const label = apart !== null && apart.terrains.has(wanted) ? areaLabels(apart.ground, (node) => terrain[node] === wanted) : null;
    return bestGrowthCandidate(
      adjacency,
      own,
      (candidate) => {
        if (locked.has(candidate)) return false;
        if (apart !== null && label !== null && wouldJoin(apart.ground, label, candidate, apart.gaps[candidate] as number)) return false;
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
