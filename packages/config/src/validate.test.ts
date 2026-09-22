import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET } from './index.ts';
import type { PendingValue, RewardGroupSpec, Ruleset } from './types.ts';
import { RulesetError, UnresolvedDesignError, resolvePending, validateRuleset } from './validate.ts';
import type { Terrain } from './vocabulary.ts';

/**
 * A deep, mutable copy, so a test can break exactly one invariant.
 *
 * A JSON round-trip rather than `structuredClone`, which is not in the `ES2022`
 * lib `tsconfig.base.json` pins. A Ruleset is plain JSON data — numbers,
 * strings, arrays and objects — so the round-trip is lossless here.
 */
function clone(): Ruleset {
  return JSON.parse(JSON.stringify(DEFAULT_RULESET)) as Ruleset;
}

function plainsRows(ruleset: Ruleset): RewardGroupSpec[] {
  return ruleset.content.REWARD_TABLE.plains as RewardGroupSpec[];
}

function firstPlainsRow(ruleset: Ruleset): RewardGroupSpec {
  const row = plainsRows(ruleset)[0];
  if (row === undefined) throw new Error('fixture: plains has no reward rows');
  return row;
}

describe('validateRuleset', () => {
  it('accepts the shipped v1 ruleset', () => {
    // The §4.2 table and the §11 defaults have to satisfy each other; this is
    // the test that keeps a content edit from landing half-done.
    expect(() => validateRuleset(DEFAULT_RULESET)).not.toThrow();
  });

  it('rejects reward groups that do not partition a terrain exactly', () => {
    const ruleset = clone();
    const row = firstPlainsRow(ruleset);
    plainsRows(ruleset)[0] = { ...row, poiCount: row.poiCount + 1 };
    expect(() => validateRuleset(ruleset)).toThrow(RulesetError);
    expect(() => validateRuleset(ruleset)).toThrow(/§4.2\/§3: plains reward groups cover 26 POIs/);
  });

  it('rejects a group with fewer units than POIs', () => {
    // §4.3 step 2 gives every POI in a group one guaranteed unit.
    const ruleset = clone();
    const row = firstPlainsRow(ruleset);
    plainsRows(ruleset)[0] = { ...row, totalUnits: row.poiCount - 1 };
    expect(() => validateRuleset(ruleset)).toThrow(/each POI needs one guaranteed unit/);
  });

  it('rejects a duplicated (kind, guard) key', () => {
    // The group, not the kind, is the partition unit — so a repeated key would
    // mean two partitions of the same POIs.
    const ruleset = clone();
    const rows = plainsRows(ruleset);
    const row = firstPlainsRow(ruleset);
    rows.push({ ...row, poiCount: 0, totalUnits: 0 });
    expect(() => validateRuleset(ruleset)).toThrow(/lists the reward group plains_move\/none twice/);
  });

  it('rejects terrain area shares that do not sum to 1', () => {
    const ruleset = clone();
    (ruleset.config.map.TERRAIN_AREA_SHARE as Record<Terrain, number>).plains = 0.5;
    expect(() => validateRuleset(ruleset)).toThrow(/TERRAIN_AREA_SHARE sums to/);
  });

  it('rejects more POIs than the map has nodes', () => {
    const ruleset = clone();
    (ruleset.config.map as { MAP_NODE_COUNT: number }).MAP_NODE_COUNT = 10;
    expect(() => validateRuleset(ruleset)).toThrow(/60 POIs requested but only 10 nodes/);
  });

  it('rejects an inverted MIN/MAX range', () => {
    const ruleset = clone();
    (ruleset.config.map.LEAF_COUNT as { min: number }).min = 99;
    expect(() => validateRuleset(ruleset)).toThrow(/LEAF_COUNT.min \(99\) exceeds LEAF_COUNT.max/);
  });

  it('rejects a CLOSE_CANDIDATE_COUNT below 1', () => {
    // All three callers of `closestPoiCandidates` share this K, so a zero here
    // would silently leave the walk and the MCTS tree with no branches at all.
    const ruleset = clone();
    (ruleset.config.balancing as { CLOSE_CANDIDATE_COUNT: number }).CLOSE_CANDIDATE_COUNT = 0;
    expect(() => validateRuleset(ruleset)).toThrow(/CLOSE_CANDIDATE_COUNT must be at least 1/);
  });

  it('rejects a negative REMOTENESS_WEIGHT_FOR_DISTRIBUTION', () => {
    // §4.3's denominator is `current_count + (1 − remoteness) × W`, which is
    // only guaranteed >= 1 for W >= 0.
    const ruleset = clone();
    (ruleset.config.balancing as { REMOTENESS_WEIGHT_FOR_DISTRIBUTION: number }).REMOTENESS_WEIGHT_FOR_DISTRIBUTION =
      -1;
    expect(() => validateRuleset(ruleset)).toThrow(/REMOTENESS_WEIGHT_FOR_DISTRIBUTION must be non-negative/);
  });

  it('reports every problem at once rather than the first', () => {
    const ruleset = clone();
    (ruleset.config.balancing as { CLOSE_CANDIDATE_COUNT: number }).CLOSE_CANDIDATE_COUNT = 0;
    (ruleset.config.balancing as { REMOTENESS_SIMULATION_RUNS: number }).REMOTENESS_SIMULATION_RUNS = 0;
    try {
      validateRuleset(ruleset);
      expect.unreachable('validateRuleset should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RulesetError);
      expect((error as RulesetError).message).toMatch(/CLOSE_CANDIDATE_COUNT/);
      expect((error as RulesetError).message).toMatch(/REMOTENESS_SIMULATION_RUNS/);
    }
  });
});

describe('resolvePending', () => {
  const unresolved: PendingValue<number> = {
    __pending: true,
    gdd: 'GDD.md §12.2',
    question: 'What exploration constant should the tree use?',
    value: null,
  };

  it('throws rather than substituting a plausible default', () => {
    // This is the chokepoint that keeps "undecided" from decaying into
    // "whatever the first implementer typed".
    expect(() => resolvePending(unresolved)).toThrow(UnresolvedDesignError);
  });

  it('carries the GDD reference and the question on the error', () => {
    try {
      resolvePending(unresolved);
      expect.unreachable('resolvePending should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnresolvedDesignError);
      expect((error as UnresolvedDesignError).gdd).toBe('GDD.md §12.2');
      expect((error as UnresolvedDesignError).question).toBe(unresolved.question);
      expect((error as UnresolvedDesignError).message).toMatch(/docs\/OPEN_QUESTIONS\.md/);
    }
  });

  it('returns a value once one has been supplied', () => {
    expect(resolvePending({ ...unresolved, value: 1.41 })).toBe(1.41);
  });

  it('returns a supplied falsy value rather than treating it as unresolved', () => {
    expect(resolvePending({ ...unresolved, value: 0 })).toBe(0);
  });

  it('leaves the pending block empty in the shipped ruleset', () => {
    // docs/OPEN_QUESTIONS.md reads "Outstanding: none"; this keeps the config
    // and the register from drifting apart silently.
    expect(Object.keys(DEFAULT_RULESET.engineering.pending)).toEqual([]);
  });
});
