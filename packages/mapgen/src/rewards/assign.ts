import type { GameConfig, RewardGroupSpec, Terrain } from '@adventure/config';
import { NotImplementedError, type NodeId, type Rng } from '@adventure/core';
import type { MapDraft, PoiAssignment } from '../types.ts';

/**
 * §4.3 step 3's weight, verbatim:
 *
 *   weight ∝ 1 / (current_count − (remoteness − 1) × REMOTENESS_WEIGHT_FOR_DISTRIBUTION)
 *
 * [SOURCE §1.3, chat] Since remoteness ∈ [0, 1], `(remoteness − 1) ∈ [−1, 0]`,
 * so the denominator is `current_count + (1 − remoteness) × W` — `current_count`
 * (≥ 1, from the step-2 guaranteed baseline) plus a non-negative term. It is
 * therefore **always ≥ 1** for any non-negative `W`, and needs no floor, clamp
 * or epsilon. Do not add one: the GDD works this through explicitly, and a
 * clamp would silently mask a broken `current_count` instead of failing.
 *
 * Effect, as designed: weight falls as a POI's own stack grows and rises with
 * remoteness, so spare units gravitate toward remote, lightly-stacked POIs.
 */
export function distributionWeight(currentCount: number, remoteness: number, config: GameConfig): number {
  const w = config.balancing.REMOTENESS_WEIGHT_FOR_DISTRIBUTION;
  return 1 / (currentCount - (remoteness - 1) * w);
}

/**
 * §4.3 step 1 — "Partition the terrain's POIs into groups sized by the 'POIs of
 * this kind' column."
 *
 * The groups partition the terrain's POIs exactly: no POI is left out and none
 * is in two groups, which is the structural form of §3's "a POI's reward is
 * always exactly one kind". `validateRuleset` has already checked that the
 * column sums to `POI_COUNT[terrain]`, so this cannot silently drop a POI.
 *
 * Mountain contributes two groups that share `kind: 'gold'` and differ only by
 * guard type — the sub-partition, not an extra kind.
 */
export function partitionPoisIntoGroups(
  _terrain: Terrain,
  _poiNodes: readonly NodeId[],
  _rows: readonly RewardGroupSpec[],
  _rng: Rng,
): readonly PoiAssignment[] {
  throw new NotImplementedError('partitionPoisIntoGroups', 'GDD.md §4.3 step 1');
}

/**
 * §4.3 steps 2 and 3, for one row of the §4.2 table.
 *
 *  2. Give every POI in the group 1 guaranteed unit of its assigned kind.
 *  3. Distribute the remaining `totalUnits − poiCount` units **one at a time**,
 *     each to a POI drawn from the same group with probability proportional to
 *     `distributionWeight(current_count, remoteness)`.
 *
 * One at a time and re-weighted after every unit — that is what makes the
 * self-damping term (`current_count` in the denominator) do anything at all.
 */
export function distributeGroupUnits(
  _group: readonly PoiAssignment[],
  _row: RewardGroupSpec,
  _remoteness: ReadonlyMap<NodeId, number>,
  _config: GameConfig,
  _rng: Rng,
): void {
  throw new NotImplementedError('distributeGroupUnits', 'GDD.md §4.3 steps 2-3');
}

/** Run §4.3 for every terrain and every row of §4.2. */
export function assignRewards(_draft: MapDraft, _config: GameConfig, _rng: Rng): void {
  throw new NotImplementedError('assignRewards', 'GDD.md §4.2, §4.3');
}
