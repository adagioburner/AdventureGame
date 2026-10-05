import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '@adventure/config';
import { asNodeId, type NodeId } from '@adventure/core';

import type { PoiAssignment } from '../types.ts';
import { assignGuardStrengths, guardStrengthFor } from './guards.ts';

const config = DEFAULT_GAME_CONFIG;

function assignment(overrides: Partial<PoiAssignment> = {}): PoiAssignment {
  return {
    node: asNodeId(0),
    terrain: 'mountain',
    kind: 'gold',
    guardType: 'fighting',
    units: 1,
    guardStrength: null,
    ...overrides,
  };
}

describe('guardStrengthFor', () => {
  it('follows the designer formula', () => {
    // [SOURCE §5.2, chat] `gold × GOLD_WEIGHT − remoteness × REMOTENESS_WEIGHT`.
    const { GOLD_WEIGHT, REMOTENESS_WEIGHT } = config.balancing;
    const raw = 3 * GOLD_WEIGHT - 0.5 * REMOTENESS_WEIGHT;
    expect(guardStrengthFor(assignment({ units: 3 }), 0.5, config)).toBe(Math.ceil(raw));
  });

  it('leaves 1 gold at maximum remoteness unguarded', () => {
    // [SOURCE §5.2, chat] "1 gold with maximum remoteness is unguarded" — the
    // stated worked example, and the reason GUARD_STRENGTH.min is 0 rather
    // than §11's original 2.
    expect(guardStrengthFor(assignment({ units: 1 }), 1, config)).toBe(0);
  });

  it('rounds up', () => {
    // [SOURCE §5.2, chat] "Guard strength is rounded up." 1 × 3 − 0.4 × 4 = 1.4.
    expect(guardStrengthFor(assignment({ units: 1 }), 0.4, config)).toBe(2);
  });

  it('caps at GUARD_STRENGTH.max', () => {
    const { max } = config.pois.GUARD_STRENGTH;
    expect(guardStrengthFor(assignment({ units: 100 }), 0, config)).toBe(max);
  });

  it('never returns below GUARD_STRENGTH.min', () => {
    const { min } = config.pois.GUARD_STRENGTH;
    expect(guardStrengthFor(assignment({ units: 0 }), 1, config)).toBe(min);
  });

  it('stops discounting for remoteness once a stack is large enough to cap', () => {
    // Documented in BalancingConfig.GOLD_WEIGHT: with GOLD_WEIGHT 3 and
    // REMOTENESS_WEIGHT 4, any POI holding 5+ gold caps at 10 for every
    // remoteness value. Stated there as a tuning observation, so this test
    // pins the behaviour of today's constants rather than a design rule.
    const strengths = [0, 0.25, 0.5, 0.75, 1].map((remoteness) =>
      guardStrengthFor(assignment({ units: 5 }), remoteness, config),
    );
    expect(new Set(strengths)).toEqual(new Set([config.pois.GUARD_STRENGTH.max]));
  });

  it('ignores the reward kind', () => {
    // §4.4 requires guarding to work on any kind; "gold only" is a v1 content
    // choice expressed in the §4.2 table, not an engine constraint.
    const gold = guardStrengthFor(assignment({ kind: 'gold', units: 2 }), 0.5, config);
    const magic = guardStrengthFor(assignment({ kind: 'magic', units: 2 }), 0.5, config);
    expect(magic).toBe(gold);
  });
});

describe('assignGuardStrengths', () => {
  it('scores guarded POIs and leaves unguarded ones null', () => {
    const guarded = assignment({ node: asNodeId(1), units: 4 });
    const unguarded = assignment({ node: asNodeId(2), kind: 'fighting', guardType: null, units: 4 });
    const remoteness = new Map<NodeId, number>([
      [asNodeId(1), 0.5],
      [asNodeId(2), 0.5],
    ]);

    assignGuardStrengths([guarded, unguarded], remoteness, config);

    expect(guarded.guardStrength).toBe(guardStrengthFor(guarded, 0.5, config));
    expect(unguarded.guardStrength).toBeNull();
  });

  it('does not consult remoteness for an unguarded POI', () => {
    const unguarded = assignment({ guardType: null });
    expect(() => assignGuardStrengths([unguarded], new Map(), config)).not.toThrow();
    expect(unguarded.guardStrength).toBeNull();
  });

  it('throws when a guarded POI has no remoteness score', () => {
    // Step 7 computes remoteness before rewards, so a gap here means the
    // pipeline ran out of order — loud is right.
    const guarded = assignment({ node: asNodeId(7) });
    expect(() => assignGuardStrengths([guarded], new Map(), config)).toThrow(RangeError);
    expect(() => assignGuardStrengths([guarded], new Map(), config)).toThrow(/no remoteness score for POI node 7/);
  });

  it('can leave a guarded POI at strength 0', () => {
    // Which is what `guard: null` in the sealed map will mean — knowingly
    // breaking §4.4's "none are exempt" for low-gold, high-remoteness POIs.
    const guarded = assignment({ node: asNodeId(3), units: 1 });
    assignGuardStrengths([guarded], new Map([[asNodeId(3), 1]]), config);
    expect(guarded.guardStrength).toBe(0);
  });
});
