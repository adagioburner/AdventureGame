import { TERRAINS, type GameConfig, type RewardGroupSpec, type Ruleset, type Terrain } from '@adventure/config';
import type { NodeId, Rng } from '@adventure/core';
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
 *
 * Which POI lands in which group is a shuffle: §4.2 fixes how many POIs each
 * row gets, and nothing in §3 or §4 says *which* ones, so the draw is the one
 * thing that decides it. Rows are consumed in table order, so the shuffle is
 * the only source of variation.
 */
export function partitionPoisIntoGroups(
  terrain: Terrain,
  poiNodes: readonly NodeId[],
  rows: readonly RewardGroupSpec[],
  rng: Rng,
): readonly PoiAssignment[] {
  const wanted = rows.reduce((sum, row) => sum + row.poiCount, 0);
  if (wanted !== poiNodes.length) {
    throw new RangeError(
      `§4.2 gives ${terrain} ${wanted} POIs but ${poiNodes.length} were placed; the table and POI_COUNT disagree`,
    );
  }

  const pool = rng.shuffle(poiNodes);
  const assignments: PoiAssignment[] = [];
  let cursor = 0;
  for (const row of rows) {
    for (let index = 0; index < row.poiCount; index++) {
      assignments.push({
        node: pool[cursor++] as NodeId,
        terrain,
        kind: row.kind,
        guardType: row.guard,
        // §4.3 step 2's guaranteed unit; step 3 adds the rest.
        units: 1,
        guardStrength: null,
      });
    }
  }
  return assignments;
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
 * Step 2's unit is already on the assignment when it arrives here, from
 * `partitionPoisIntoGroups`.
 */
export function distributeGroupUnits(
  group: readonly PoiAssignment[],
  row: RewardGroupSpec,
  remoteness: ReadonlyMap<NodeId, number>,
  config: GameConfig,
  rng: Rng,
): void {
  if (group.length === 0) return;
  const remainder = row.totalUnits - row.poiCount;
  if (remainder < 0) {
    throw new RangeError(`§4.2 row ${row.kind}/${row.guard ?? 'unguarded'} has fewer units than POIs`);
  }

  for (let unit = 0; unit < remainder; unit++) {
    const weights = group.map((assignment) =>
      distributionWeight(assignment.units, remotenessOf(remoteness, assignment.node), config),
    );
    rng.weightedPick(group, weights).units += 1;
  }
}

/**
 * §4.3 step 4 — "Draw `REWARD_SWAP_PASSES × (POIs in the row)` pairs of POIs
 * from within the same group, and swap the two POIs' unit counts whenever the
 * larger stack is sitting on the less remote of the two."
 *
 * [SOURCE §4.3, review] Step 3 leans the right way but only weakly: over 200
 * maps the bigger of two stacks in a row was the more remote one 57.1% of the
 * time, and raising `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` saturates near 65%,
 * because step 3 is a random draw and §4.2 gives most rows barely more spare
 * units than POIs. So the correlation is repaired afterwards rather than
 * weighted harder for. Agreement by pass count, same 200 maps: 2 → 86.8%,
 * 3 → 91.8%, 5 → 96.3%, 10 → 99.3%.
 *
 * **Deliberately not a sort.** Andrei: "we don't have to do complete ordering".
 * Run to completion this would order every row by remoteness exactly, and the
 * same map would hold no surprises twice; stopped early it leaves the map its
 * variety. That is why the pass count is a constant rather than a loop on the
 * agreement it achieves.
 *
 * A swap only exchanges two stacks *inside* one group, so the row's total units
 * (§4.2), its POI count and step 2's guaranteed unit are all untouched by
 * construction — there is nothing here that can put a row out of balance.
 */
export function swapGroupTowardRemoteness(
  group: readonly PoiAssignment[],
  remoteness: ReadonlyMap<NodeId, number>,
  config: GameConfig,
  rng: Rng,
): void {
  if (group.length < 2) return;

  const scores = group.map((assignment) => remotenessOf(remoteness, assignment.node));
  const draws = config.balancing.REWARD_SWAP_PASSES * group.length;

  for (let draw = 0; draw < draws; draw++) {
    const left = rng.nextInt(group.length);
    // A second draw over the remaining indices, shifted past `left`, so the
    // pair is always two distinct POIs and no draw is spent on a POI and
    // itself.
    let right = rng.nextInt(group.length - 1);
    if (right >= left) right++;

    const first = group[left] as PoiAssignment;
    const second = group[right] as PoiAssignment;
    const byUnits = first.units - second.units;
    const byRemoteness = (scores[left] as number) - (scores[right] as number);
    // Strictly disagreeing only: equal stacks and equal remoteness are nothing
    // to repair, and swapping them would churn the map for no gain.
    if (byUnits * byRemoteness >= 0) continue;

    const units = first.units;
    first.units = second.units;
    second.units = units;
  }
}

function remotenessOf(remoteness: ReadonlyMap<NodeId, number>, node: NodeId): number {
  const score = remoteness.get(node);
  if (score === undefined) throw new RangeError(`no remoteness score for POI node ${node}`);
  return score;
}

/**
 * Run §4.3 for every terrain and every row of §4.2.
 *
 * POIs that already carry an assignment are left alone. That is how the surplus
 * leaves of §3 stay out of the table: step 7 gives them their stamina before
 * calling this, precisely because §4.2 has no row for them, and the §4.2 quota
 * is then satisfied by exactly the POIs the table accounts for.
 */
export function assignRewards(draft: MapDraft, ruleset: Ruleset, rng: Rng): void {
  const spoken = new Set(draft.assignments.map((assignment) => assignment.node));

  for (const terrain of TERRAINS) {
    const rows = ruleset.content.REWARD_TABLE[terrain];
    const nodes = draft.poiNodes.filter(
      (node) => !spoken.has(node) && draft.terrain[node] === terrain,
    );
    const groups = partitionPoisIntoGroups(terrain, nodes, rows, rng);

    let cursor = 0;
    for (const row of rows) {
      const group = groups.slice(cursor, cursor + row.poiCount);
      cursor += row.poiCount;
      distributeGroupUnits(group, row, draft.remoteness, ruleset.config, rng);
      swapGroupTowardRemoteness(group, draft.remoteness, ruleset.config, rng);
    }
    draft.assignments.push(...groups);
  }

  draft.assignments.sort((left, right) => left.node - right.node);
}
