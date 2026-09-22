import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET, REWARD_KINDS, SKILL_KINDS, TERRAINS, type Ruleset, type Terrain } from '@adventure/config';
import {
  isLeaf,
  leafNodes,
  poiAt,
  rewardGroupKeyOf,
  totalGoldUnits,
  totalSkillUnits,
  type GameMap,
  type NodeId,
} from '@adventure/core';
import { defaultRemotenessScorer } from '@adventure/sim';
import { generateMap, reviveGameMap } from './pipeline.ts';

/**
 * Generation is an exact function of `(seed, ruleset)`, so a map is worth
 * generating once and sharing across the assertions below — it is around
 * 200ms a map and this file makes a great many statements about the same four.
 */
const cache = new Map<string, GameMap>();

function mapOf(seed: string, ruleset: Ruleset = DEFAULT_RULESET): GameMap {
  if (ruleset !== DEFAULT_RULESET) return generateMap({ seed, ruleset, remotenessScorer: defaultRemotenessScorer });
  const held = cache.get(seed);
  if (held !== undefined) return held;
  const map = generateMap({ seed, ruleset, remotenessScorer: defaultRemotenessScorer });
  cache.set(seed, map);
  return map;
}

/** Bypasses the cache, for the assertions that are *about* regeneration. */
function generateFresh(seed: string): GameMap {
  return generateMap({ seed, ruleset: DEFAULT_RULESET, remotenessScorer: defaultRemotenessScorer });
}

const SEEDS = ['adventure', 'alpha', 'beta', 'gamma'];

describe('generateMap', () => {
  it('produces a map for every seed with no unexplained rejections', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      expect(map.attempts).toBeGreaterThanOrEqual(1);
      expect(map.attempts).toBeLessThanOrEqual(DEFAULT_RULESET.engineering.MAX_GENERATION_ATTEMPTS);
    }
  }, 30000);

  it('gives the identical map for the same seed twice', () => {
    expect(JSON.stringify(generateFresh('adventure'))).toBe(JSON.stringify(generateFresh('adventure')));
  }, 30000);

  it('gives a different map for a different seed', () => {
    expect(JSON.stringify(generateFresh('adventure'))).not.toBe(JSON.stringify(generateFresh('alpha')));
  }, 30000);

  it('stores the seed and the ruleset it ran with, so the map can be regenerated', () => {
    const map = mapOf('adventure');
    expect(map.seed).toBe('adventure');
    expect(map.ruleset).toBe(DEFAULT_RULESET);
  }, 30000);

  it('lands inside the §2 and §11 targets', () => {
    const { MAP_NODE_COUNT, MAP_EDGE_COUNT, LEAF_COUNT } = DEFAULT_RULESET.config.map;
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      expect(map.graph.nodes.length).toBeGreaterThan(MAP_NODE_COUNT * 0.9);
      expect(map.graph.nodes.length).toBeLessThan(MAP_NODE_COUNT * 1.1);
      expect(map.graph.edges.length).toBe(MAP_EDGE_COUNT);
      const leaves = leafNodes(map.graph).length;
      expect(leaves).toBeGreaterThanOrEqual(LEAF_COUNT.min);
      expect(leaves).toBeLessThanOrEqual(LEAF_COUNT.max);
    }
  }, 30000);

  it('survives the JSON round trip Q15 sends it through', () => {
    // Q15 settled that the finished map is *sent* to every client rather than
    // regenerated per client, so nothing in it may be a Set, a class instance
    // or a function. `poiByNode` is the one Map, and `reviveGameMap` is the
    // other half of the trip.
    const map = mapOf('adventure');
    const revived = reviveGameMap(JSON.parse(JSON.stringify(map)) as GameMap);

    expect(revived.graph).toEqual(map.graph);
    expect(revived.pois).toEqual(map.pois);
    expect(revived.attempts).toBe(map.attempts);
    expect([...revived.poiByNode.entries()].sort()).toEqual([...map.poiByNode.entries()].sort());
    for (const poi of map.pois) expect(poiAt(revived, poi.node)).toEqual(poi);
  }, 30000);
});

describe('§3 — POI placement', () => {
  it('makes every leaf a POI', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      for (const leaf of leafNodes(map.graph)) expect(poiAt(map, leaf)).toBeDefined();
    }
  }, 30000);

  it('gives every POI exactly one reward kind, of the seven in §4.1', () => {
    for (const poi of mapOf('adventure').pois) {
      expect(REWARD_KINDS).toContain(poi.reward.kind);
      expect(poi.reward.units).toBeGreaterThanOrEqual(1);
    }
  }, 30000);

  it('denormalises each POI onto its own node and terrain', () => {
    const map = mapOf('adventure');
    for (const poi of map.pois) {
      expect(map.graph.nodes[poi.node]?.terrain).toBe(poi.terrain);
      expect(poiAt(map, poi.node)).toBe(poi);
    }
  }, 30000);

  it('lists no node twice', () => {
    const map = mapOf('adventure');
    expect(new Set(map.pois.map((poi) => poi.node)).size).toBe(map.pois.length);
  }, 30000);
});

describe('§4.2 — the reward table reconciles exactly', () => {
  it('matches every row on both POI count and unit total', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      for (const terrain of TERRAINS) {
        for (const row of DEFAULT_RULESET.content.REWARD_TABLE[terrain]) {
          const group = map.pois.filter(
            (poi) =>
              poi.terrain === terrain &&
              rewardGroupKeyOf(poi.group) === rewardGroupKeyOf({ kind: row.kind, guard: row.guard }),
          );
          expect(group).toHaveLength(row.poiCount);
          expect(group.reduce((sum, poi) => sum + poi.reward.units, 0)).toBe(row.totalUnits);
        }
      }
    }
  }, 30000);

  it('accounts for every POI: table rows plus surplus-leaf stamina, nothing else', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const tabled = TERRAINS.reduce(
        (sum, terrain) =>
          sum + DEFAULT_RULESET.content.REWARD_TABLE[terrain].reduce((rows, row) => rows + row.poiCount, 0),
        0,
      );
      const stamina = map.pois.filter((poi) => poi.reward.kind === 'stamina');
      expect(map.pois.length).toBe(tabled + stamina.length);

      // §3/§9, chat: surplus leaves, one stamina unit each, always unguarded.
      for (const poi of stamina) {
        expect(isLeaf(map.graph, poi.node)).toBe(true);
        expect(poi.reward.units).toBe(DEFAULT_RULESET.config.pois.OVERFLOW_LEAF_STAMINA_UNITS);
        expect(poi.guard).toBeNull();
        expect(poi.group).toEqual({ kind: 'stamina', guard: null });
      }
    }
  }, 30000);

  it('puts the same gold and skill totals on every map, because §4.2 fixes them', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      expect(totalGoldUnits(map)).toBe(45);
      expect(totalSkillUnits(map)).toBe(75);
      expect(SKILL_KINDS.length).toBe(5);
    }
  }, 30000);
});

describe('§5.1 — remoteness', () => {
  it('scores every POI inside [0, 1] with both ends attained', () => {
    for (const seed of SEEDS) {
      const scores = mapOf(seed).pois.map((poi) => poi.remoteness);
      for (const score of scores) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
      // Min-max normalisation, so the extremes are exactly 0 and 1.
      expect(Math.min(...scores)).toBe(0);
      expect(Math.max(...scores)).toBe(1);
    }
  }, 30000);
});

describe('§5.2 — guard strengths', () => {
  it('guards gold and nothing else, this being v1 content rather than an engine rule', () => {
    for (const seed of SEEDS) {
      for (const poi of mapOf(seed).pois) {
        if (poi.guard !== null) expect(poi.reward.kind).toBe('gold');
        if (poi.reward.kind !== 'gold') expect(poi.group.guard).toBeNull();
      }
    }
  }, 30000);

  it('keeps every strength a whole number inside GUARD_STRENGTH', () => {
    const { min, max } = DEFAULT_RULESET.config.pois.GUARD_STRENGTH;
    for (const seed of SEEDS) {
      for (const poi of mapOf(seed).pois) {
        if (poi.guard === null) continue;
        expect(Number.isInteger(poi.guard.strength)).toBe(true);
        expect(poi.guard.strength).toBeGreaterThan(min);
        expect(poi.guard.strength).toBeLessThanOrEqual(max);
      }
    }
  }, 30000);

  it('seals a gold POI the formula caps at 0 as unguarded, keeping its §4.2 row', () => {
    // [SOURCE §5.2, chat] "1 gold with maximum remoteness is unguarded":
    // 1 × GOLD_WEIGHT − 1 × REMOTENESS_WEIGHT = −1, capped to 0. Such a POI
    // still belongs to a guarded row, which is how §4.2 keeps reconciling.
    const unguardedGold = SEEDS.flatMap((seed) =>
      mapOf(seed).pois.filter((poi) => poi.reward.kind === 'gold' && poi.guard === null),
    );
    expect(unguardedGold.length).toBeGreaterThan(0);
    for (const poi of unguardedGold) {
      expect(poi.group.guard).not.toBeNull();
      const raw =
        poi.reward.units * DEFAULT_RULESET.config.balancing.GOLD_WEIGHT -
        poi.remoteness * DEFAULT_RULESET.config.balancing.REMOTENESS_WEIGHT;
      expect(Math.ceil(raw)).toBeLessThanOrEqual(0);
    }
  }, 30000);
});

describe('§6 — starting position', () => {
  it('always has a non-POI plains node to start the players on', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const candidates = map.graph.nodes.filter(
        (node) => node.terrain === 'plains' && !map.poiByNode.has(node.id as NodeId),
      );
      expect(candidates.length).toBeGreaterThan(0);
    }
  }, 30000);
});

describe('terrain', () => {
  it('puts all three terrains on every map', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const present = new Set<Terrain>(map.graph.nodes.map((node) => node.terrain));
      for (const terrain of TERRAINS) expect(present.has(terrain)).toBe(true);
    }
  }, 30000);

  // [SOURCE §2.1, chat] The shares are a statement about the map a player is
  // handed, so they are measured here on the sealed map — after step 6 has cut
  // its valleys, not on the draft step 4 leaves behind. Before step 6 paid the
  // valleys back, `adventure` finished 65 / 26 / 9 against 45 / 30 / 25.
  it('holds §2.1 step 4 area shares in the finished map, valleys and all', () => {
    const { TERRAIN_AREA_SHARE } = DEFAULT_RULESET.config.map;
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const total = map.graph.nodes.length;
      for (const terrain of TERRAINS) {
        const share = map.graph.nodes.filter((node) => node.terrain === terrain).length / total;
        expect(Math.abs(share - TERRAIN_AREA_SHARE[terrain])).toBeLessThan(0.05);
      }
    }
  }, 30000);

  // §4.2 fixes the POI count per terrain, so a terrain that loses nodes crowds
  // its POIs together. This is the reading that made the skew visible.
  it('keeps POI density comparable across the three terrains', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const poiNodes = new Set(map.pois.map((poi) => poi.node));
      const spacing = TERRAINS.map((terrain) => {
        const nodes = map.graph.nodes.filter((node) => node.terrain === terrain);
        const pois = nodes.filter((node) => poiNodes.has(node.id)).length;
        return nodes.length / pois;
      });
      expect(Math.max(...spacing) / Math.min(...spacing)).toBeLessThan(2);
    }
  }, 30000);
});

describe('regeneration', () => {
  it('throws away an attempt whose terrain cannot hold its §4.2 POI quota, rather than failing', () => {
    // A mountain quota of 100 passes `validateRuleset` — 145 POIs over ~240
    // nodes — but no map's mountains are that big, so the attempt is rejected
    // at step 7, the retry loop runs to its bound, and the failure names the
    // reason. Without the check this crashes with a RangeError from §4.3.
    const ruleset: Ruleset = {
      ...DEFAULT_RULESET,
      config: {
        ...DEFAULT_RULESET.config,
        pois: { ...DEFAULT_RULESET.config.pois, POI_COUNT: { plains: 25, forest: 20, mountain: 100 } },
      },
      content: {
        REWARD_TABLE: {
          ...DEFAULT_RULESET.content.REWARD_TABLE,
          mountain: [
            { kind: 'gold', guard: 'fighting', totalUnits: 140, poiCount: 70 },
            { kind: 'gold', guard: 'magic', totalUnits: 60, poiCount: 30 },
          ],
        },
      },
      engineering: { ...DEFAULT_RULESET.engineering, MAX_GENERATION_ATTEMPTS: 2 },
    };
    expect(() => generateMap({ seed: 'adventure', ruleset, remotenessScorer: defaultRemotenessScorer })).toThrow(
      /terrain_share_unreachable at 7-place-pois/,
    );
  }, 30000);
});
