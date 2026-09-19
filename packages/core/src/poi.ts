import type { Terrain } from '@adventure/config';
import type { NodeId, PlayerId } from './ids.ts';
import type { Guard, Reward, RewardGroupKey } from './reward.ts';

/**
 * [SOURCE §1] "Some nodes are POIs. A POI has: a reward (§4), optionally a
 * guard (§4.4), and an eye-candy image of the place or — if guarded — of the
 * guardian."
 *
 * Immutable: a POI is produced once by §2.1 step 7 and never changes. What
 * changes during play (whether the reward has been claimed, §4.5) lives in
 * `PoiRuntimeState` on the game state, not here — which keeps the generated
 * map a pure function of `(seed, params)` and safe to share, cache and replay.
 */
export interface Poi {
  readonly node: NodeId;
  /** Always equal to the node's terrain; denormalised because §4.2 is keyed by it. */
  readonly terrain: Terrain;
  /** Exactly one kind, by construction. See `Reward`. */
  readonly reward: Reward;
  /** `null` when unguarded. In v1 content this is non-null iff the kind is gold. */
  readonly guard: Guard | null;
  /**
   * [SOURCE §1.2] Normalised to [0, 1] across the map's POIs. Computed by the
   * shared random-walk component (§5.1) between POI placement and reward
   * assignment, because §4.3 step 3 and §5.2 both consume it.
   */
  readonly remoteness: number;
  /** Which §4.2 row produced this POI. Kept for the balancing harness and tests. */
  readonly group: RewardGroupKey;
  /**
   * A stable index drawn from the map PRNG, so the same seed always picks the
   * same picture. The mapping from this index to an actual asset in `Art/` is
   * **out of scope** for now and owned by the client's art-binding layer — the
   * sheet/atlas layout, sizing and icon-to-reward mapping are all still to be
   * decided with the designer. Nothing in the engine reads this field.
   */
  readonly artVariant: number;
}

/** [SOURCE §2] Per-POI mutable state: a reward is consumed once claimed (§4.5). */
export interface PoiRuntimeState {
  readonly claimedBy: PlayerId | null;
  /** Turn number on which it was claimed; `null` while unclaimed. */
  readonly claimedOnTurn: number | null;
}

export function isClaimed(state: PoiRuntimeState): boolean {
  return state.claimedBy !== null;
}
