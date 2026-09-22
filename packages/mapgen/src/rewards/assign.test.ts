import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type RewardGroupSpec } from '@adventure/config';
import { asNodeId, createRng, type NodeId } from '@adventure/core';
import { distributeGroupUnits, distributionWeight, partitionPoisIntoGroups } from './assign.ts';
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
