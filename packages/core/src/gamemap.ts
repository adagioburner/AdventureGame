import { SKILL_KINDS, type Ruleset } from '@adventure/config';
import type { NodeId } from './ids.ts';
import type { MapGraph } from './graph.ts';
import type { Poi } from './poi.ts';
import type { Rng, Seed } from './rng.ts';

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
 * [SOURCE §9, PR #5 review] The denominator of Q18's skill term: "sum of
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
  return rng.pick(candidates);
}
