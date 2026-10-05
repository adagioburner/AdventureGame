import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RULESET,
  LARGER_MAP_FROM_PLAYERS,
  LARGER_MAP_RULESET,
  mapSizeForPlayers,
  mapSizeOfRuleset,
  rulesetForPlayers,
} from './index.ts';
import type { Ruleset } from './types.ts';
import { validateRuleset } from './validate.ts';
import { TERRAINS } from './vocabulary.ts';

/** [Q160] Andrei, 2026-10-01: maps 40% larger for 4 and 5 players. */
const SCALE = 1.4;

describe('the larger map for 4 and 5 players (Q160)', () => {
  it('is a ruleset that validates, like the standard one', () => {
    expect(() => validateRuleset(LARGER_MAP_RULESET)).not.toThrow();
  });

  it('is played from 4 players, and the standard map up to 3', () => {
    expect(LARGER_MAP_FROM_PLAYERS).toBe(4);
    expect([2, 3, 4, 5].map(mapSizeForPlayers)).toEqual(['standard', 'standard', 'larger', 'larger']);
    expect(rulesetForPlayers(3)).toBe(DEFAULT_RULESET);
    expect(rulesetForPlayers(4)).toBe(LARGER_MAP_RULESET);
  });

  it('has 1.4 times the spaces, roads, dead ends and sites per terrain', () => {
    const today = DEFAULT_RULESET.config;
    const larger = LARGER_MAP_RULESET.config;
    expect(larger.map.MAP_NODE_COUNT).toBe(Math.round(today.map.MAP_NODE_COUNT * SCALE));
    expect(larger.map.MAP_EDGE_COUNT).toBe(Math.round(today.map.MAP_EDGE_COUNT * SCALE));
    expect(larger.map.LEAF_COUNT.min).toBe(Math.round(today.map.LEAF_COUNT.min * SCALE));
    expect(larger.map.LEAF_COUNT.max).toBe(Math.round(today.map.LEAF_COUNT.max * SCALE));
    for (const terrain of TERRAINS) {
      expect(larger.pois.POI_COUNT[terrain]).toBe(Math.round(today.pois.POI_COUNT[terrain] * SCALE));
    }
  });

  it("has 1.4 times every row's units, and its sites rounded to the nearest whole number (630)", () => {
    for (const terrain of TERRAINS) {
      const today = DEFAULT_RULESET.content.REWARD_TABLE[terrain];
      const larger = LARGER_MAP_RULESET.content.REWARD_TABLE[terrain];
      expect(larger.map(({ kind, guard }) => ({ kind, guard }))).toEqual(today.map(({ kind, guard }) => ({ kind, guard })));
      larger.forEach((row, index) => {
        const before = today[index];
        if (before === undefined) throw new Error('rows differ');
        expect(row.totalUnits).toBe(Math.round(before.totalUnits * SCALE));
        expect(row.poiCount).toBe(Math.round(before.poiCount * SCALE));
      });
    }
  });

  it('carries 67 gold, 105 speed and skill units and 11 stamina units, against 48, 75 and 8 (Q240, 902 A, Q250, Q270)', () => {
    const units = (ruleset: Ruleset, kind: 'gold' | 'stamina' | 'skills'): number =>
      TERRAINS.flatMap((terrain) => ruleset.content.REWARD_TABLE[terrain])
        .filter((row) => (kind === 'skills' ? row.kind !== 'gold' && row.kind !== 'stamina' : row.kind === kind))
        .reduce((sum, row) => sum + row.totalUnits, 0);
    const all = (ruleset: Ruleset): number[] => [units(ruleset, 'gold'), units(ruleset, 'skills'), units(ruleset, 'stamina')];
    expect(all(DEFAULT_RULESET)).toEqual([48, 75, 8]);
    expect(all(LARGER_MAP_RULESET)).toEqual([67, 105, 11]);
  });

  it('changes nothing else (633)', () => {
    const { map: largerMap, pois: largerPois, ...largerRest } = LARGER_MAP_RULESET.config;
    const { map: todayMap, pois: todayPois, ...todayRest } = DEFAULT_RULESET.config;
    expect(largerRest).toEqual(todayRest);
    const { MAP_NODE_COUNT: _n1, MAP_EDGE_COUNT: _e1, LEAF_COUNT: _l1, ...largerMapRest } = largerMap;
    const { MAP_NODE_COUNT: _n2, MAP_EDGE_COUNT: _e2, LEAF_COUNT: _l2, ...todayMapRest } = todayMap;
    expect(largerMapRest).toEqual(todayMapRest);
    expect({ ...largerPois, POI_COUNT: null }).toEqual({ ...todayPois, POI_COUNT: null });
  });

  it('is recognised from a map that came back as JSON', () => {
    const revived = JSON.parse(JSON.stringify(LARGER_MAP_RULESET)) as Ruleset;
    expect(mapSizeOfRuleset(revived)).toBe('larger');
    expect(mapSizeOfRuleset(JSON.parse(JSON.stringify(DEFAULT_RULESET)) as Ruleset)).toBe('standard');
  });
});
