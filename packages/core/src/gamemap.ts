import { SKILL_KINDS, type Ruleset, type StartConfig } from '@adventure/config';
import type { NodeId } from './ids.ts';
import { neighbours, type MapGraph } from './graph.ts';
import type { Poi } from './poi.ts';
import { createRng, type Rng, type Seed } from './rng.ts';

/**
 * The generated world: everything §2.1 produces, and nothing that changes
 * during play.
 *
 * [SOURCE §1.3] Fully reproducible from `(seed, params)`. `seed` and the
 * ruleset used are stored alongside the result so a map can be regenerated for
 * debugging, replays and the balancing harness without shipping the geometry.
 */
export interface GameMap {
  readonly seed: Seed;
  /** The exact ruleset the generator ran with. */
  readonly ruleset: Ruleset;
  readonly graph: MapGraph;
  /** Indexed by POI node id order of generation; see `poiByNode` for lookup. */
  readonly pois: readonly Poi[];
  /** Sparse lookup: node id → index into `pois`, or `undefined` for a plain node. */
  readonly poiByNode: ReadonlyMap<NodeId, number>;
  /** How many attempts §2.1's regenerate-on-failure loop needed. Diagnostics only. */
  readonly attempts: number;
}

export function poiAt(map: GameMap, node: NodeId): Poi | undefined {
  const index = map.poiByNode.get(node);
  return index === undefined ? undefined : map.pois[index];
}

/** [SOURCE §2] Total gold units placed on the map. Used by the win check (§1). */
export function totalGoldUnits(map: GameMap): number {
  return map.pois.reduce((sum, poi) => sum + (poi.reward.kind === 'gold' ? poi.reward.units : 0), 0);
}

/**
 * Total skill units placed on the map, summed over the five `SKILL_KINDS`.
 *
 * [SOURCE §9, review] The denominator of Q18's skill term: "sum of
 * player's skill levels / total skills available". Read as the skill units the
 * map actually holds, the exact parallel of `totalGoldUnits`, so the term
 * reaches 1 when one player has claimed every skill POI.
 */
export function totalSkillUnits(map: GameMap): number {
  return map.pois.reduce(
    (sum, poi) => sum + (SKILL_KINDS.some((kind) => kind === poi.reward.kind) ? poi.reward.units : 0),
    0,
  );
}

/**
 * [SOURCE §6, chat] "the players start at a random spot of the plains that is
 * not a POI. All players start from the same spot."
 *
 * [Q227] Not at random: the deepest plains space whose remoteness is below
 * `MAX_REMOTENESS` (see `StartConfig`), the least remote of equally deep ones
 * (873), and with none below it the least remote space (874); the lowest node
 * id where those are equal too. A map with no site within `NEARBY_STEPS` of
 * any of its spaces, which no generated map has, draws one at random.
 *
 * One node for every player, so `PlayerState.position` is identical for all
 * seats at turn 1. Multiple players sharing a node is already unrestricted
 * (§8), so nothing special is needed to let them all stand there.
 *
 * Call this with an `Rng` derived from `map.seed` (`createRng(map.seed).fork(...)`)
 * rather than an ambient one, so the starting node is reproducible from
 * `(seed, params)` along with the rest of the map — §1.3 wants replays to
 * reconstruct from the seed alone.
 */
export function chooseStartingNode(map: GameMap, rng: Rng): NodeId {
  const candidates = map.graph.nodes
    .filter((node) => node.terrain === 'plains' && !map.poiByNode.has(node.id))
    .map((node) => node.id);
  if (candidates.length === 0) {
    throw new RangeError('no non-POI plains node available as a starting position');
  }
  return deepestNotRemote(map, candidates, map.ruleset.config.start) ?? rng.pick(candidates);
}

/** [Q227] `chooseStartingNode`'s pick among `candidates`, in node id order; null when none has a remoteness. */
function deepestNotRemote(map: GameMap, candidates: readonly NodeId[], start: StartConfig): NodeId | null {
  const depth = stepsFromForestAndMountains(map.graph);
  let deepest: { readonly node: NodeId; readonly depth: number; readonly remoteness: number } | null = null;
  let leastRemote: { readonly node: NodeId; readonly remoteness: number } | null = null;
  for (const node of candidates) {
    const remoteness = spaceRemoteness(map, node, start.NEARBY_STEPS);
    if (remoteness === null) continue;
    if (leastRemote === null || remoteness < leastRemote.remoteness) leastRemote = { node, remoteness };
    if (remoteness >= start.MAX_REMOTENESS) continue;
    const steps = depth[node] as number;
    if (deepest === null || steps > deepest.depth || (steps === deepest.depth && remoteness < deepest.remoteness)) {
      deepest = { node, depth: steps, remoteness };
    }
  }
  return deepest?.node ?? leastRemote?.node ?? null;
}

/**
 * [Q227, 878] How deep each space is in the plains: the road steps from it to
 * the nearest forest or mountain space, one per road whatever the terrain.
 * Indexed by node id; 0 on forest and mountain spaces, and infinite on plains
 * with no road to either.
 */
export function stepsFromForestAndMountains(graph: MapGraph): number[] {
  const steps = new Array<number>(graph.nodes.length).fill(Number.POSITIVE_INFINITY);
  const queue: NodeId[] = [];
  for (const node of graph.nodes) {
    if (node.terrain === 'plains') continue;
    steps[node.id] = 0;
    queue.push(node.id);
  }
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head] as NodeId;
    for (const next of neighbours(graph, at)) {
      if (steps[next] !== Number.POSITIVE_INFINITY) continue;
      steps[next] = (steps[at] as number) + 1;
      queue.push(next);
    }
  }
  return steps;
}

/**
 * [Q227, 876] A space's remoteness: the average remoteness of the sites of
 * every terrain within `steps` road steps of `node` (878), the site on `node`
 * itself included if it has one. Null when there is none.
 */
export function spaceRemoteness(map: GameMap, node: NodeId, steps: number): number | null {
  const reached = new Map<NodeId, number>([[node, 0]]);
  const queue: NodeId[] = [node];
  let sum = 0;
  let count = 0;
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head] as NodeId;
    const site = map.poiByNode.get(at);
    if (site !== undefined) {
      sum += (map.pois[site] as Poi).remoteness;
      count += 1;
    }
    const away = reached.get(at) as number;
    if (away === steps) continue;
    for (const next of neighbours(map.graph, at)) {
      if (reached.has(next)) continue;
      reached.set(next, away + 1);
      queue.push(next);
    }
  }
  return count === 0 ? null : sum / count;
}

/**
 * The node every game on this map starts from: `chooseStartingNode` with an
 * `Rng` forked from the map's own seed, so it replays with the map. Hot seat
 * and online games share it, so a seed starts in the same place either way.
 */
export function startingNodeFor(map: GameMap): NodeId {
  return chooseStartingNode(map, createRng(map.seed).fork('starting-node'));
}
