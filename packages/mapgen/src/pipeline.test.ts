import { describe, expect, it } from 'vitest';

import {
  COIN_FLIP_FOREST_MAGIC_GUARD_CHANCE,
  DEFAULT_RULESET,
  FORTRESS_MIN_LINE_SPACES,
  FORTRESS_MIN_ROAD_STEPS,
  LARGER_MAP_RULESET,
  REWARD_KINDS,
  SKILL_KINDS,
  TERRAINS,
  withMagicGuardChance,
  withRewardsBeforeMove,
  type Ruleset,
  type Terrain,
} from '@adventure/config';
import {
  createRng,
  leafNodes,
  poiAt,
  rewardGroupKeyOf,
  spaceRemoteness,
  startingNodeFor,
  stepsFromForestAndMountains,
  totalGoldUnits,
  totalSkillUnits,
  type GameMap,
  type NodeId,
} from '@adventure/core';
import { defaultRemotenessScorer } from '@adventure/sim';
import { generateMap, reviveGameMap } from './pipeline.ts';
import { areaLabels } from './terraingrowth.ts';
import type { MapDraft } from './types.ts';

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
      // Step 3 prunes to exactly MAP_EDGE_COUNT; step 6b then puts a few back
      // where terrains meet too thinly (Q105) — 1 to 14 over 100 maps.
      expect(map.graph.edges.length).toBeGreaterThanOrEqual(MAP_EDGE_COUNT);
      expect(map.graph.edges.length).toBeLessThan(MAP_EDGE_COUNT * 1.1);
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
    const rows = TERRAINS.flatMap((terrain) => DEFAULT_RULESET.content.REWARD_TABLE[terrain]);
    const tabled = rows.reduce((sum, row) => sum + row.poiCount, 0);
    // [Q240] The stamina row: in the forest on 6 sites since Q250, with 12 units since Q260.
    const staminaRows = rows.filter((row) => row.kind === 'stamina');
    const tabledStamina = staminaRows.reduce((sum, row) => sum + row.poiCount, 0);
    const tabledStaminaUnits = staminaRows.reduce((sum, row) => sum + row.totalUnits, 0);
    expect([tabledStamina, tabledStaminaUnits]).toEqual([6, 12]);
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const stamina = map.pois.filter((poi) => poi.reward.kind === 'stamina');
      const surplus = stamina.length - tabledStamina;
      expect(surplus).toBeGreaterThanOrEqual(0);
      expect(map.pois.length).toBe(tabled + surplus);
      expect(stamina.filter((poi) => poi.terrain === 'forest').length).toBeGreaterThanOrEqual(tabledStamina);

      // §3/§9, chat: surplus leaves, one stamina unit each; [Q240, 901 A] the
      // table's stamina sites unguarded like every reward but gold.
      const units = stamina.reduce((sum, poi) => sum + poi.reward.units, 0);
      expect(units).toBe(tabledStaminaUnits + surplus * DEFAULT_RULESET.config.pois.OVERFLOW_LEAF_STAMINA_UNITS);
      for (const poi of stamina) {
        expect(poi.guard).toBeNull();
        expect(poi.group).toEqual({ kind: 'stamina', guard: null });
      }
    }
  }, 30000);

  it('puts the same gold and skill totals on every map, because §4.2 fixes them', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      expect(totalGoldUnits(map)).toBe(48);
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

  it("walks with the map's own K, so the computer player's K leaves the map alone", () => {
    const withBalancing = (balancing: Partial<Ruleset['config']['balancing']>): Ruleset => ({
      ...DEFAULT_RULESET,
      config: { ...DEFAULT_RULESET.config, balancing: { ...DEFAULT_RULESET.config.balancing, ...balancing } },
    });
    const pois = (map: GameMap) => map.pois.map((poi) => [poi.node, poi.remoteness, poi.reward, poi.guard]);

    const today = pois(mapOf('adventure'));
    expect(pois(mapOf('adventure', withBalancing({ CLOSE_CANDIDATE_COUNT: 3 })))).toEqual(today);
    expect(pois(mapOf('adventure', withBalancing({ REMOTENESS_CANDIDATE_COUNT: 3 })))).not.toEqual(today);
  }, 30000);
});

describe('Q227 — the start, deep in the plains where the sites nearby are not remote', () => {
  const spacesOf = (map: GameMap): NodeId[] =>
    map.graph.nodes.filter((node) => node.terrain === 'plains' && !map.poiByNode.has(node.id)).map((node) => node.id);

  it('starts on the deepest plains space whose sites within 5 steps average below 0.1, the least remote of equally deep ones', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const { NEARBY_STEPS, MAX_REMOTENESS } = map.ruleset.config.start;
      expect([NEARBY_STEPS, MAX_REMOTENESS]).toEqual([5, 0.1]);
      const start = startingNodeFor(map);
      const depth = stepsFromForestAndMountains(map.graph);
      const own = spaceRemoteness(map, start, NEARBY_STEPS);
      expect(spacesOf(map)).toContain(start);
      expect(own).not.toBeNull();
      expect(own as number).toBeLessThan(MAX_REMOTENESS);
      for (const node of spacesOf(map)) {
        const remoteness = spaceRemoteness(map, node, NEARBY_STEPS);
        if (remoteness === null || remoteness >= MAX_REMOTENESS) continue;
        expect(depth[node] as number).toBeLessThanOrEqual(depth[start] as number);
        if (depth[node] === depth[start]) expect(remoteness).toBeGreaterThanOrEqual(own as number);
      }
    }
  }, 30000);

  it('starts the larger maps by the same rule', () => {
    const map = mapOf('adventure', LARGER_MAP_RULESET);
    expect(map.ruleset.config.start).toEqual(DEFAULT_RULESET.config.start);
    expect(spaceRemoteness(map, startingNodeFor(map), 5) as number).toBeLessThan(0.1);
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
    //
    // Generated without §4.3 step 4, because step 4 is very nearly the rule
    // against this POI existing: the only way past the cap is a 1-unit stack at
    // remoteness ≥ 0.5, and moving small stacks off remote POIs is exactly what
    // step 4 does. Measured over 60 maps, unguarded gold falls from 3.3% of all
    // gold POIs at 0 passes to 0.2% at the default 5, and 58 of those 60 maps
    // have none at all — so asking the default seeds for one is asking for a
    // coincidence. The sealing path still has to work when it does happen.
    // [Q250] Since the rewards moved terrain the small gold piles are on the
    // plains, the least remote terrain, and these seeds no longer meet the cap
    // at today's weights, so remoteness weighs more here.
    const noSwaps: Ruleset = {
      ...DEFAULT_RULESET,
      config: {
        ...DEFAULT_RULESET.config,
        balancing: { ...DEFAULT_RULESET.config.balancing, REWARD_SWAP_PASSES: 0, REMOTENESS_WEIGHT: 12 },
      },
    };
    const unguardedGold = SEEDS.flatMap((seed) =>
      mapOf(seed, noSwaps).pois.filter((poi) => poi.reward.kind === 'gold' && poi.guard === null),
    );
    expect(unguardedGold.length).toBeGreaterThan(0);
    for (const poi of unguardedGold) {
      expect(poi.group.guard).not.toBeNull();
      const raw =
        poi.reward.units * noSwaps.config.balancing.GOLD_WEIGHT -
        poi.remoteness * noSwaps.config.balancing.REMOTENESS_WEIGHT;
      expect(Math.ceil(raw)).toBeLessThanOrEqual(0);
    }
  }, 30000);

  // The same statement the other way round, on the map a player actually gets:
  // an unguarded gold POI is now the exception rather than a regular feature,
  // which pushes §4.4's "every gold POI is guarded, none are exempt" back
  // toward literally true. Registered for Andrei as part of Q29.
  //
  // Counted over the four seeds together, not per map: one unguarded gold POI
  // is already 1 in 21 on a single map. Over 100 maps with step 6b (Q105) it
  // is 10 in 2100 gold POIs (0.48%; 0.33% before step 6b).
  it('leaves almost no gold unguarded once §4.3 step 4 has run', () => {
    const gold = SEEDS.flatMap((seed) => mapOf(seed).pois.filter((poi) => poi.group.guard !== null));
    const unguarded = gold.filter((poi) => poi.guard === null);
    expect(unguarded.length / gold.length).toBeLessThan(0.02);
  }, 30000);
});

describe('Q115, Q185 — forest gold guarded by magic by chance, always until the rewards moved (Q250)', () => {
  // [Q250] Only maps from before the rewards moved terrain have forest gold.
  const before = withRewardsBeforeMove(DEFAULT_RULESET);
  const beforeMaps = new Map<string, GameMap>();
  const beforeOf = (seed: string): GameMap => {
    const held = beforeMaps.get(seed) ?? generateMap({ seed, ruleset: before, remotenessScorer: defaultRemotenessScorer });
    beforeMaps.set(seed, held);
    return held;
  };
  const withoutForestMagic: Ruleset = {
    ...before,
    content: {
      ...before.content,
      REWARD_TABLE: {
        ...before.content.REWARD_TABLE,
        forest: before.content.REWARD_TABLE.forest.map(({ magicGuardChance: _chance, ...row }) => row),
      },
    },
  };
  const isForestGold = (poi: GameMap['pois'][number]): boolean => poi.terrain === 'forest' && poi.reward.kind === 'gold';

  it('guards every forest gold POI by magic, keeping it in its §4.2 row (Q185)', () => {
    let guarded = 0;
    for (const seed of SEEDS) {
      for (const poi of beforeOf(seed).pois.filter(isForestGold)) {
        expect(poi.group).toEqual({ kind: 'gold', guard: 'fighting' });
        if (poi.guard === null) continue;
        expect(poi.guard.type).toBe('magic');
        guarded += 1;
      }
    }
    expect(guarded).toBeGreaterThan(0);
  }, 30000);

  it('guards forest gold with both fighting and magic at the coin flip a kept game may have begun with (Q115, 730)', () => {
    const coinFlip = withMagicGuardChance(before, COIN_FLIP_FOREST_MAGIC_GUARD_CHANCE);
    const types = new Set<string>();
    for (const seed of SEEDS) {
      for (const poi of mapOf(seed, coinFlip).pois.filter(isForestGold)) if (poi.guard !== null) types.add(poi.guard.type);
    }
    expect([...types].sort()).toEqual(['fighting', 'magic']);
  }, 30000);

  it('leaves plains gold fighting-guarded and mountain gold split by row', () => {
    for (const seed of SEEDS) {
      for (const poi of beforeOf(seed).pois) {
        if (poi.guard === null || isForestGold(poi)) continue;
        expect(poi.guard.type).toBe(poi.group.guard);
      }
    }
  }, 30000);

  // The coin flips are the map's last draws, so turning them on moved nothing
  // else on any seed: every road, reward, strength and picture is as it was.
  it('changes nothing on a map but the guard type of some forest gold', () => {
    for (const seed of SEEDS) {
      const without = mapOf(seed, withoutForestMagic);
      const after = beforeOf(seed);
      expect(after.graph).toEqual(without.graph);
      expect(after.attempts).toBe(without.attempts);
      expect(after.pois.map(({ guard, ...poi }) => ({ ...poi, strength: guard?.strength ?? 0 }))).toEqual(
        without.pois.map(({ guard, ...poi }) => ({ ...poi, strength: guard?.strength ?? 0 })),
      );
      after.pois.forEach((poi, index) => {
        if (!isForestGold(poi)) expect(poi.guard).toEqual(without.pois[index]?.guard);
      });
    }
  }, 60000);
});

describe('Q250 — the rewards by terrain since they moved', () => {
  // Andrei, 2026-10-04: the plains get the three speeds, the magic-guarded gold
  // that was the forest's and the two fortresses; the forests magic, combat
  // and stamina; the mountains stay as they were. Spare dead ends still hold
  // stamina on any terrain (§3).
  const kindsOn: Record<Terrain, readonly string[]> = {
    plains: ['plains_move', 'forest_move', 'mountain_move', 'gold/fighting', 'gold/magic', 'stamina'],
    forest: ['magic', 'fighting', 'stamina'],
    mountain: ['gold/fighting', 'gold/magic', 'stamina'],
  };

  it('puts each reward on its terrain, and no gold in the forest', () => {
    for (const seed of SEEDS) {
      for (const poi of mapOf(seed).pois) {
        const key = poi.reward.kind === 'gold' ? `gold/${poi.group.guard}` : poi.reward.kind;
        expect(kindsOn[poi.terrain]).toContain(key);
        // A plains stamina site is a spare dead end, never the table's.
        if (poi.reward.kind === 'stamina' && poi.terrain !== 'forest') {
          expect(poi.reward.units).toBe(DEFAULT_RULESET.config.pois.OVERFLOW_LEAF_STAMINA_UNITS);
        }
      }
    }
  }, 30000);

  it("guards the plains' small gold by magic and its fortresses by combat", () => {
    let magic = 0;
    for (const seed of SEEDS) {
      for (const poi of mapOf(seed).pois) {
        if (poi.terrain !== 'plains' || poi.reward.kind !== 'gold' || poi.guard === null) continue;
        expect(poi.guard.type).toBe(poi.group.guard);
        if (poi.guard.type === 'magic') magic += 1;
      }
    }
    expect(magic).toBeGreaterThan(0);
  }, 30000);
});

describe('Q255 — the fortresses kept apart, by road and on the map', () => {
  // Andrei, 2026-10-04: "make sure that two large gold prises guarded by combat
  // on plains are well separated from each other". Every pair at least 12 road
  // steps and 5 spaces in a straight line apart (930 B, 931), the three on the
  // larger map as well (932 A).
  const isFortress = (poi: GameMap['pois'][number]): boolean =>
    poi.terrain === 'plains' && poi.reward.kind === 'gold' && poi.group.guard === 'fighting';

  function stepsFrom(map: GameMap, from: NodeId): number[] {
    const steps = map.graph.nodes.map(() => Number.POSITIVE_INFINITY);
    steps[from] = 0;
    const queue = [from];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head] as NodeId;
      for (const next of map.graph.adjacency[node] ?? []) {
        if (steps[next] !== Number.POSITIVE_INFINITY) continue;
        steps[next] = (steps[node] as number) + 1;
        queue.push(next);
      }
    }
    return steps;
  }

  /** Road steps and straight-line spaces between every pair of the map's fortresses. */
  function pairsOf(map: GameMap): { steps: number; line: number }[] {
    const length = (edge: { a: NodeId; b: NodeId }): number => {
      const a = map.graph.nodes[edge.a]?.position, b = map.graph.nodes[edge.b]?.position;
      return a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y);
    };
    const lengths = map.graph.edges.map(length).sort((x, y) => x - y);
    const space = lengths[Math.floor(lengths.length / 2)] as number;
    const nodes = map.pois.filter(isFortress).map((poi) => poi.node);
    const pairs: { steps: number; line: number }[] = [];
    nodes.forEach((a, i) => {
      const steps = stepsFrom(map, a);
      for (const b of nodes.slice(i + 1)) pairs.push({ steps: steps[b] as number, line: length({ a, b }) / space });
    });
    return pairs;
  }

  const farEnough = ({ steps, line }: { steps: number; line: number }): boolean =>
    steps >= FORTRESS_MIN_ROAD_STEPS && line >= FORTRESS_MIN_LINE_SPACES;

  /** `ruleset` with no row kept apart: the fortresses wherever step 1 drew them. */
  function withoutApart(ruleset: Ruleset): Ruleset {
    const anywhere = (rows: Ruleset['content']['REWARD_TABLE'][Terrain]) => rows.map(({ apart: _apart, ...row }) => row);
    const table = ruleset.content.REWARD_TABLE;
    return {
      ...ruleset,
      content: { ...ruleset.content, REWARD_TABLE: { plains: anywhere(table.plains), forest: anywhere(table.forest), mountain: anywhere(table.mountain) } },
    };
  }

  it('keeps every pair 12 road steps and 5 spaces in a line apart, two on the standard map and three on the larger', () => {
    expect([FORTRESS_MIN_ROAD_STEPS, FORTRESS_MIN_LINE_SPACES]).toEqual([12, 5]);
    for (const [ruleset, count] of [[DEFAULT_RULESET, 2], [LARGER_MAP_RULESET, 3]] as const) {
      for (const seed of SEEDS) {
        const map = mapOf(seed, ruleset);
        expect(map.pois.filter(isFortress)).toHaveLength(count);
        for (const pair of pairsOf(map)) expect(farEnough(pair)).toBe(true);
      }
    }
  }, 60000);

  it('leaves a map whose fortresses were drawn far enough apart exactly as it was', () => {
    let unchanged = 0;
    for (const seed of SEEDS) {
      const before = mapOf(seed, withoutApart(DEFAULT_RULESET));
      if (!pairsOf(before).every(farEnough)) continue;
      unchanged++;
      const after = mapOf(seed);
      expect(after.graph).toEqual(before.graph);
      expect(after.pois).toEqual(before.pois);
    }
    expect(unchanged).toBeGreaterThan(0);
  }, 30000);

  it("moves one of adventure's fortresses, and changes nothing but the sites it swapped and their rows' gold", () => {
    const before = mapOf('adventure', withoutApart(DEFAULT_RULESET));
    const after = mapOf('adventure');
    expect(pairsOf(before).every(farEnough)).toBe(false);
    expect(after.graph).toEqual(before.graph);
    const changed = after.pois.filter((poi, index) => JSON.stringify(poi) !== JSON.stringify(before.pois[index]));
    expect(changed.length).toBeGreaterThanOrEqual(2);
    after.pois.forEach((poi, index) => {
      const was = before.pois[index] as GameMap['pois'][number];
      // No site moves and none is more or less remote: only what lies on them.
      expect(poi.node).toBe(was.node);
      expect(poi.remoteness).toBe(was.remoteness);
      if (JSON.stringify(poi) === JSON.stringify(was)) return;
      expect(poi.terrain).toBe('plains');
      expect([poi.reward.kind, was.reward.kind]).toEqual(['gold', 'gold']);
    });
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

  // [SOURCE §4.3, review] The whole point of §4.3 step 4, on the map a player
  // is handed. Step 3's weighting alone left this at 57.1% over 200 maps; with
  // the default 5 passes the same batch reads 96.3%, and the worst single map
  // of the 200 reads 91.0%. Andrei named 90% as satisfactory, so that is what
  // this holds each seed to — per map, not pooled, since pooling would let one
  // badly ordered map hide behind three good ones.
  it('puts the bigger reward stacks on the more remote POIs, §4.3 step 4', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const rows = new Map<string, typeof map.pois>();
      for (const poi of map.pois) {
        if (poi.group.kind === 'stamina') continue; // a surplus leaf, not a §4.2 row
        const key = `${poi.terrain}/${rewardGroupKeyOf(poi.group)}`;
        rows.set(key, [...(rows.get(key) ?? []), poi]);
      }

      let agree = 0;
      let pairs = 0;
      for (const row of rows.values()) {
        for (let left = 0; left < row.length; left++) {
          for (let right = left + 1; right < row.length; right++) {
            const first = row[left] as (typeof row)[number];
            const second = row[right] as (typeof row)[number];
            if (first.reward.units === second.reward.units) continue;
            pairs++;
            const byRemoteness = first.remoteness - second.remoteness;
            if ((first.reward.units - second.reward.units) * byRemoteness > 0) agree++;
          }
        }
      }

      expect(pairs).toBeGreaterThan(50);
      expect(agree / pairs).toBeGreaterThan(0.9);
    }
  }, 30000);
});

describe('regeneration', () => {
  it('throws away an attempt whose terrain cannot hold its §4.2 POI quota, rather than failing', () => {
    // A mountain quota of 100 passes `validateRuleset` — 150 POIs over ~240
    // nodes — but no map's mountains are that big, so the attempt is rejected
    // at step 7, the retry loop runs to its bound, and the failure names the
    // reason. Without the check this crashes with a RangeError from §4.3.
    const ruleset: Ruleset = {
      ...DEFAULT_RULESET,
      config: {
        ...DEFAULT_RULESET.config,
        pois: { ...DEFAULT_RULESET.config.pois, POI_COUNT: { ...DEFAULT_RULESET.config.pois.POI_COUNT, mountain: 100 } },
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

describe('Q160 — the larger map for 4 and 5 players', () => {
  const LARGER_SEEDS = ['adventure', 'alpha', 'beta'];
  const larger = new Map<string, GameMap>();
  const largerOf = (seed: string): GameMap => {
    const map = larger.get(seed) ?? mapOf(seed, LARGER_MAP_RULESET);
    larger.set(seed, map);
    return map;
  };
  const each = (check: (map: GameMap) => void): void => {
    for (const seed of LARGER_SEEDS) check(largerOf(seed));
  };

  it('lands inside its own targets: 336 spaces, 420 roads, 42 to 63 dead ends', () => {
    const { MAP_NODE_COUNT, MAP_EDGE_COUNT, LEAF_COUNT } = LARGER_MAP_RULESET.config.map;
    each((map) => {
      expect(map.ruleset).toBe(LARGER_MAP_RULESET);
      expect(map.graph.nodes.length).toBeGreaterThan(MAP_NODE_COUNT * 0.95);
      expect(map.graph.nodes.length).toBeLessThan(MAP_NODE_COUNT * 1.05);
      expect(map.graph.edges.length).toBeGreaterThanOrEqual(MAP_EDGE_COUNT);
      expect(map.graph.edges.length).toBeLessThan(MAP_EDGE_COUNT * 1.1);
      const leaves = leafNodes(map.graph).length;
      expect(leaves).toBeGreaterThanOrEqual(LEAF_COUNT.min);
      expect(leaves).toBeLessThanOrEqual(LEAF_COUNT.max);
    });
  }, 30000);

  it('keeps the terrain shares, so each terrain has 1.4 times its spaces', () => {
    each((map) => {
      for (const terrain of TERRAINS) {
        const share = map.graph.nodes.filter((node) => node.terrain === terrain).length / map.graph.nodes.length;
        expect(Math.abs(share - LARGER_MAP_RULESET.config.map.TERRAIN_AREA_SHARE[terrain])).toBeLessThan(0.05);
      }
    });
  }, 30000);

  it('matches its reward table row for row, with 67 gold and 105 speed and skill units', () => {
    each((map) => {
      for (const terrain of TERRAINS) {
        for (const row of LARGER_MAP_RULESET.content.REWARD_TABLE[terrain]) {
          const group = map.pois.filter(
            (poi) =>
              poi.terrain === terrain &&
              rewardGroupKeyOf(poi.group) === rewardGroupKeyOf({ kind: row.kind, guard: row.guard }),
          );
          expect(group).toHaveLength(row.poiCount);
          expect(group.reduce((sum, poi) => sum + poi.reward.units, 0)).toBe(row.totalUnits);
        }
      }
      expect(totalGoldUnits(map)).toBe(67);
      expect(totalSkillUnits(map)).toBe(105);
    });
  }, 30000);

  it('is a different map from the standard one for the same seed', () => {
    expect(largerOf('adventure').graph.nodes.length).not.toBe(mapOf('adventure').graph.nodes.length);
  }, 30000);
});

describe('Q245 — the forest and mountains in separate areas, no valleys', () => {
  /** The map for `seed`, with the draft as step 8 left it (valleys and the ground are draft-only). */
  function drafted(seed: string, ruleset: Ruleset): { map: GameMap; draft: MapDraft } {
    let last: MapDraft | null = null;
    const map = generateMap({
      seed,
      ruleset,
      remotenessScorer: defaultRemotenessScorer,
      observer: {
        stepCompleted: (step, draft) => {
          if (step.id === '8-validate') last = structuredClone(draft);
        },
      },
    });
    return { map, draft: last as unknown as MapDraft };
  }

  function areasOf(draft: MapDraft, terrain: Terrain): number[] {
    const ground: NodeId[][] = draft.terrain.map(() => []);
    for (const edge of draft.triangulation) {
      (ground[edge.a] as NodeId[]).push(edge.b);
      (ground[edge.b] as NodeId[]).push(edge.a);
    }
    const label = areaLabels(ground, (node) => draft.terrain[node] === terrain);
    const sizes = new Map<number, number>();
    for (const value of label) if (value !== -1) sizes.set(value, (sizes.get(value) ?? 0) + 1);
    return [...sizes.values()].sort((a, b) => b - a);
  }

  it('carves no valleys, while VALLEY_COUNT above 0 still carves them', () => {
    const valleys: Ruleset = {
      ...DEFAULT_RULESET,
      config: { ...DEFAULT_RULESET.config, map: { ...DEFAULT_RULESET.config.map, VALLEY_COUNT: { min: 2, max: 4 } } },
    };
    for (const seed of SEEDS) {
      expect(drafted(seed, DEFAULT_RULESET).draft.valleyNodes.size).toBe(0);
      expect(drafted(seed, valleys).draft.valleyNodes.size).toBeGreaterThan(0);
    }
  }, 30000);

  it('keeps the forest and the mountains in two areas each on most of these maps, at both sizes', () => {
    // Not on every map: a second area hemmed in by wide gaps early on can stay
    // under 5 spaces, and two areas join where only that reaches the shares.
    let two = 0;
    let cases = 0;
    for (const ruleset of [DEFAULT_RULESET, LARGER_MAP_RULESET]) {
      for (const seed of SEEDS) {
        const { draft } = drafted(seed, ruleset);
        for (const terrain of ['forest', 'mountain'] as const) {
          cases++;
          if (areasOf(draft, terrain).filter((size) => size >= 5).length === 2) two++;
        }
      }
    }
    expect(two).toBeGreaterThan(cases / 2);
  }, 60000);

  it("draws every space's gap within KEPT_APART.GAP (917)", () => {
    const { draft } = drafted('adventure', DEFAULT_RULESET);
    expect(draft.apartGaps).toHaveLength(draft.terrain.length);
    expect(new Set(draft.apartGaps)).toEqual(new Set([1, 2, 3]));
  }, 30000);
});
