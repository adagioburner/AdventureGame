import type { Ruleset } from '@adventure/config';
import type { NodeId } from './ids.ts';
import type { MapGraph } from './graph.ts';
import type { Poi } from './poi.ts';
import type { Seed } from './rng.ts';

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
