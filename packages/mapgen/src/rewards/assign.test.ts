import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type RewardGroupSpec } from '@adventure/config';
import { asNodeId, createRng, type NodeId } from '@adventure/core';
import {
  distributeGroupUnits,
  distributionWeight,
  partitionPoisIntoGroups,
  swapGroupTowardRemoteness,
} from './assign.ts';
import type { PoiAssignment } from '../types.ts';

const config = DEFAULT_GAME_CONFIG;
const nodes = (count: number): NodeId[] => Array.from({ length: count }, (_, index) => asNodeId(index));

describe('distributionWeight', () => {
  it('falls as a POI’s own stack grows', () => {
    expect(distributionWeight(1, 0.5, config)).toBeGreaterThan(distributionWeight(5, 0.5, config));
  });

  it('rises with remoteness, so spare units gravitate to remote POIs', () => {
    expect(distributionWeight(1, 1, config)).toBeGreaterThan(distributionWeight(1, 0, config));
  });

  it('needs no clamp: the denominator is at least 1 for every legal input', () => {
    // §4.3: remoteness ∈ [0, 1] and current_count ≥ 1 from the step-2 baseline.
    for (let count = 1; count <= 20; count++) {
      for (let step = 0; step <= 10; step++) {
        const weight = distributionWeight(count, step / 10, config);
        expect(weight).toBeGreaterThan(0);
        expect(weight).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('partitionPoisIntoGroups', () => {
  const rows: RewardGroupSpec[] = [
    { kind: 'gold', guard: 'fighting', totalUnits: 20, poiCount: 3 },
    { kind: 'gold', guard: 'magic', totalUnits: 10, poiCount: 2 },
  ];

  it('partitions exactly: every POI once, in one group', () => {
    const assignments = partitionPoisIntoGroups('mountain', nodes(5), rows, createRng('p'));
    expect(assignments).toHaveLength(5);
    expect(new Set(assignments.map((a) => a.node)).size).toBe(5);
    expect(assignments.filter((a) => a.guardType === 'fighting')).toHaveLength(3);
    expect(assignments.filter((a) => a.guardType === 'magic')).toHaveLength(2);
  });

  it('keeps mountain’s two gold rows distinct without an eighth reward kind', () => {
    const assignments = partitionPoisIntoGroups('mountain', nodes(5), rows, createRng('p'));
    for (const assignment of assignments) expect(assignment.kind).toBe('gold');
  });

  it('gives every POI §4.3 step 2’s one guaranteed unit', () => {
    for (const assignment of partitionPoisIntoGroups('mountain', nodes(5), rows, createRng('p'))) {
      expect(assignment.units).toBe(1);
    }
  });

  it('throws rather than silently dropping a POI when the table and the count disagree', () => {
    expect(() => partitionPoisIntoGroups('mountain', nodes(4), rows, createRng('p'))).toThrow(/disagree/);
  });

  it('draws which POI lands in which group from the PRNG', () => {
    const first = partitionPoisIntoGroups('mountain', nodes(5), rows, createRng('a')).map((a) => a.node);
    const second = partitionPoisIntoGroups('mountain', nodes(5), rows, createRng('b')).map((a) => a.node);
    expect(first).not.toEqual(second);
  });
});

describe('distributeGroupUnits', () => {
  const row: RewardGroupSpec = { kind: 'gold', guard: 'fighting', totalUnits: 20, poiCount: 4 };

  function group(): PoiAssignment[] {
    return nodes(4).map((node) => ({
      node,
      terrain: 'mountain' as const,
      kind: 'gold' as const,
      guardType: 'fighting' as const,
      units: 1,
      guardStrength: null,
    }));
  }

  const remoteness = new Map<NodeId, number>(nodes(4).map((node, index) => [node, index / 3]));

  it('hands out exactly the row’s remaining units', () => {
    const assignments = group();
    distributeGroupUnits(assignments, row, remoteness, config, createRng('d'));
    expect(assignments.reduce((sum, a) => sum + a.units, 0)).toBe(row.totalUnits);
  });

  it('leaves every POI with at least its guaranteed unit', () => {
    const assignments = group();
    distributeGroupUnits(assignments, row, remoteness, config, createRng('d'));
    for (const assignment of assignments) expect(assignment.units).toBeGreaterThanOrEqual(1);
  });

  it('sends more units to remote POIs than to near ones, over many draws', () => {
    let remote = 0;
    let near = 0;
    for (let run = 0; run < 200; run++) {
      const assignments = group();
      distributeGroupUnits(assignments, row, remoteness, config, createRng(`run-${run}`));
      near += assignments[0]?.units ?? 0;
      remote += assignments[3]?.units ?? 0;
    }
    expect(remote).toBeGreaterThan(near);
  });

  it('is a no-op for a row whose units equal its POI count', () => {
    const assignments = group();
    distributeGroupUnits(assignments, { ...row, totalUnits: 4 }, remoteness, config, createRng('d'));
    expect(assignments.map((a) => a.units)).toEqual([1, 1, 1, 1]);
  });

  it('throws on a row with fewer units than POIs, which validateRuleset also refuses', () => {
    expect(() => distributeGroupUnits(group(), { ...row, totalUnits: 2 }, remoteness, config, createRng('d'))).toThrow(
      /fewer units than POIs/,
    );
  });
});

describe('swapGroupTowardRemoteness', () => {
  /** A group of `count` POIs, node `i` carrying remoteness `i / (count - 1)`. */
  function group(units: readonly number[]): PoiAssignment[] {
    return units.map((value, index) => ({
      node: asNodeId(index),
      terrain: 'mountain' as const,
      kind: 'gold' as const,
      guardType: 'fighting' as const,
      units: value,
      guardStrength: null,
    }));
  }

  const spread = (count: number): Map<NodeId, number> =>
    new Map(nodes(count).map((node, index) => [node, index / (count - 1)]));

  function withPasses(passes: number): typeof config {
    return { ...config, balancing: { ...config.balancing, REWARD_SWAP_PASSES: passes } };
  }

  it('keeps the row\u2019s total units, which is what \u00a74.2 fixes', () => {
    const assignments = group([7, 1, 4, 2, 6, 1, 3, 5]);
    const total = assignments.reduce((sum, a) => sum + a.units, 0);
    swapGroupTowardRemoteness(assignments, spread(8), config, createRng('swap'));
    expect(assignments.reduce((sum, a) => sum + a.units, 0)).toBe(total);
  });

  it('is a permutation of the stacks, so no POI loses step 2\u2019s guaranteed unit', () => {
    const assignments = group([7, 1, 4, 2, 6, 1, 3, 5]);
    const before = assignments.map((a) => a.units).sort((left, right) => left - right);
    swapGroupTowardRemoteness(assignments, spread(8), config, createRng('swap'));
    expect(assignments.map((a) => a.units).sort((left, right) => left - right)).toEqual(before);
  });

  it('puts the bigger stacks on the more remote POIs', () => {
    // Deliberately backwards to start with, so every pair disagrees — a harder
    // start than any real map, where step 3 already leaves 57% of pairs
    // agreeing. Pooled over 200 streams because one group of 8 holds only 28
    // pairs and a single run swings either side of the mean; at the default 5
    // passes this measures 92.0%, and every stream here is seeded, so the
    // number is exact rather than sampled.
    let agree = 0;
    let pairs = 0;
    for (let run = 0; run < 200; run++) {
      const assignments = group([8, 7, 6, 5, 4, 3, 2, 1]);
      swapGroupTowardRemoteness(assignments, spread(8), config, createRng(`run-${run}`));
      const counted = pairsAgreeing(assignments, spread(8));
      agree += counted.agree;
      pairs += counted.pairs;
    }
    expect(agree / pairs).toBeGreaterThan(0.9);
  });

  it('stops short of a full ordering, which is the point of a pass count', () => {
    // \u00a74.3 step 4 is a repair, not a sort: two runs from different streams on
    // the same starting stacks must not both land on the sorted answer.
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8];
    const results = ['a', 'b', 'c', 'd'].map((label) => {
      const assignments = group([8, 7, 6, 5, 4, 3, 2, 1]);
      swapGroupTowardRemoteness(assignments, spread(8), config, createRng(label));
      return assignments.map((a) => a.units);
    });
    expect(results.some((units) => units.join() !== sorted.join())).toBe(true);
  });

  it('leaves a group alone when no pair disagrees', () => {
    const assignments = group([1, 2, 3, 4, 5, 6, 7, 8]);
    swapGroupTowardRemoteness(assignments, spread(8), config, createRng('swap'));
    expect(assignments.map((a) => a.units)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('does nothing at all when the pass count is zero', () => {
    const assignments = group([8, 7, 6, 5, 4, 3, 2, 1]);
    swapGroupTowardRemoteness(assignments, spread(8), withPasses(0), createRng('swap'));
    expect(assignments.map((a) => a.units)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('raises agreement monotonically as the pass count rises', () => {
    const measured = [0, 1, 3, 5].map((passes) => {
      let agree = 0;
      let pairs = 0;
      for (let run = 0; run < 60; run++) {
        const assignments = group([1, 1, 2, 3, 1, 5, 2, 1, 4, 2]);
        swapGroupTowardRemoteness(assignments, spread(10), withPasses(passes), createRng(`run-${run}`));
        const counted = pairsAgreeing(assignments, spread(10));
        agree += counted.agree;
        pairs += counted.pairs;
      }
      return agree / pairs;
    });
    for (let index = 1; index < measured.length; index++) {
      expect(measured[index] as number).toBeGreaterThan(measured[index - 1] as number);
    }
  });

  it('is an exact function of its inputs', () => {
    const first = group([8, 7, 6, 5, 4, 3, 2, 1]);
    const second = group([8, 7, 6, 5, 4, 3, 2, 1]);
    swapGroupTowardRemoteness(first, spread(8), config, createRng('same'));
    swapGroupTowardRemoteness(second, spread(8), config, createRng('same'));
    expect(first.map((a) => a.units)).toEqual(second.map((a) => a.units));
  });

  it('has nothing to do on a group of one', () => {
    const assignments = group([3]);
    swapGroupTowardRemoteness(assignments, new Map([[asNodeId(0), 0.5]]), config, createRng('swap'));
    expect(assignments[0]?.units).toBe(3);
  });
});

/** Pairs whose stacks differ, and how many of those agree with remoteness. */
function pairsAgreeing(
  group: readonly PoiAssignment[],
  remoteness: ReadonlyMap<NodeId, number>,
): { agree: number; pairs: number } {
  let agree = 0;
  let pairs = 0;
  for (let left = 0; left < group.length; left++) {
    for (let right = left + 1; right < group.length; right++) {
      const first = group[left] as PoiAssignment;
      const second = group[right] as PoiAssignment;
      if (first.units === second.units) continue;
      pairs++;
      const byRemoteness = (remoteness.get(first.node) as number) - (remoteness.get(second.node) as number);
      if ((first.units - second.units) * byRemoteness > 0) agree++;
    }
  }
  return { agree, pairs };
}
