import { SKILL_KINDS, type Ruleset } from '@adventure/config';
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
 * [Q226] Deep in the plains, on a map whose ruleset has `start`: drawn from
 * `deepPlainsSpaces`, the same spaces the map's remoteness walks started from
 * (859). A game started before keeps its map and the start it began on (861).
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
  const start = map.ruleset.config.start;
  return rng.pick(start === undefined ? candidates : deepPlainsSpaces(map.graph, map.poiByNode, start.MIN_SPACES));
}

/**
 * [Q226] The plains spaces deepest in the plains, which the start is drawn
 * from (859) and every remoteness walk starts from (858, §5.1): of the plains
 * spaces that are not sites, those at least as many road steps from every
 * forest and mountain space as the most steps that still leaves `minSpaces`
 * of them (856). A step is a road, whatever the terrain (857). So there are
 * `minSpaces` or a few more where several are equally deep, and never none
 * while the map has a plains space that is not a site.
 *
 * In node id order, so a pick means the same space wherever the map is made.
 */
export function deepPlainsSpaces(
  graph: MapGraph,
  sites: { has(node: NodeId): boolean },
  minSpaces: number,
): NodeId[] {
  // Road steps to the nearest forest or mountain space, from all of them at once.
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

  const spaces = graph.nodes.filter((node) => node.terrain === 'plains' && !sites.has(node.id)).map((node) => node.id);
  if (spaces.length === 0) return [];
  const deepestFirst = spaces.map((node) => steps[node] as number).sort((a, b) => b - a);
  const enough = deepestFirst[Math.min(minSpaces, deepestFirst.length) - 1] as number;
  return spaces.filter((node) => (steps[node] as number) >= enough).sort((a, b) => a - b);
}

/**
 * The node every game on this map starts from: `chooseStartingNode` with an
 * `Rng` forked from the map's own seed, so it replays with the map. Hot seat
 * and online games share it, so a seed starts in the same place either way.
 */
export function startingNodeFor(map: GameMap): NodeId {
  return chooseStartingNode(map, createRng(map.seed).fork('starting-node'));
}
