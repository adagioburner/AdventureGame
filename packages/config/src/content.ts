import type { GameContent, RewardTable, SitesApart } from './types.ts';

/**
 * GDD.md §4.2 "Reward totals per terrain", transcribed row for row.
 *
 * Every row is a *reward group* keyed by `(kind, guard)`. Two invariants that
 * `validateRuleset()` enforces and that the §4.3 algorithm depends on:
 *
 *   1. Per terrain, `Σ poiCount` === `POI_COUNT[terrain]` — every POI gets
 *      exactly one kind (§3), so the groups partition the terrain's POIs.
 *   2. Per row, `totalUnits >= poiCount` — §4.3 step 2 gives every POI in the
 *      group one guaranteed unit before step 3 distributes the remainder.
 *
 * [Q240] `stamina` has a row of §4.2. Andrei, 2026-10-03: "Stamina sites
 * follow the same rules any other reward type does." So the row is unguarded
 * like the speeds (901 A), and its sites count in its terrain's `POI_COUNT`,
 * since invariant 1 above needs each terrain's `poiCount` column to sum to it.
 * What a unit gives is `STAMINA_PER_UNIT` in defaults.ts. [Q250] The row is
 * the forest's.
 */
/**
 * [Q255] Andrei, 2026-10-04: "make sure that two large gold prises guarded by
 * combat on plains are well separated from each other". The fortresses, the
 * plains' gold guarded by combat, are drawn at least this many road steps
 * apart, every pair of them, on both map sizes (931, 932 A)...
 */
export const FORTRESS_MIN_ROAD_STEPS = 12;

/** [Q255] ...and at least this many spaces apart in a straight line, so they never look close on screen (930 B). */
export const FORTRESS_MIN_LINE_SPACES = 5;

/** [Q255] The fortresses' row keeps its sites this far apart: §4.3 step 1b. */
export const FORTRESSES_APART: SitesApart = {
  roadSteps: FORTRESS_MIN_ROAD_STEPS,
  lineSpaces: FORTRESS_MIN_LINE_SPACES,
};

/**
 * [Q270] Andrei, 2026-10-05: "12 stamina hearts in the forest make acquiring
 * forest speed unattractive. We need to change that to 8 hearts on 4 sites."
 * The hearts on the forest's 4 stamina sites, drawn by §4.3 like every reward...
 */
export const FOREST_STAMINA_UNITS = 8;

/**
 * [Q270] ...and on the 4-5 player map's 6: "1.4 times as many hearts and
 * sites" (960), 1.4 × 8 = 11.2 and 1.4 × 4 = 5.6, rounded as 630 A does.
 */
export const LARGER_MAP_FOREST_STAMINA_UNITS = 11;

/**
 * [Q250] Andrei, 2026-10-04: "we seem to have found a simple super strategy:
 * buy forest speed +4 and go to the forest. We need to change the allocation
 * of resources between terrains." The plains get the three speeds, the gold
 * guarded by magic and the two fortresses; the forests get magic, combat and
 * stamina; the mountains get gold (920 A). Then, the same day: "on plains,
 * gold with magic guards can grow to 5/8". [Q270] The forest's stamina is 8
 * hearts on 4 sites, so the forest has 18 sites: "There will be fewer sites in
 * the forest" (961). The plains have 32 sites and the map 48 gold. The magic
 * gold's guards follow §5.2 as all gold does (921 A).
 */
export const DEFAULT_REWARD_TABLE: RewardTable = {
  plains: [
    { kind: 'plains_move', guard: null, totalUnits: 20, poiCount: 10 },
    { kind: 'forest_move', guard: null, totalUnits: 15, poiCount: 7 },
    { kind: 'mountain_move', guard: null, totalUnits: 15, poiCount: 8 },
    // [SOURCE §1.1] Informally "cities"; Andrei's "fortresses". [Q255] Kept apart.
    { kind: 'gold', guard: 'fighting', totalUnits: 10, poiCount: 2, apart: FORTRESSES_APART },
    // [Q250] Magic-guarded gold, 8 gold on 5 sites.
    { kind: 'gold', guard: 'magic', totalUnits: 8, poiCount: 5 },
  ],
  forest: [
    { kind: 'magic', guard: null, totalUnits: 10, poiCount: 6 },
    { kind: 'fighting', guard: null, totalUnits: 15, poiCount: 8 },
    // [Q240] The stamina sites, the forest's since [Q250]; [Q270] 8 hearts on 4 sites.
    { kind: 'stamina', guard: null, totalUnits: FOREST_STAMINA_UNITS, poiCount: 4 },
  ],
  mountain: [
    // Mountain gold is split by guard type. Both rows are `kind: 'gold'`:
    // the split is a sub-partition of the gold group, not an extra kind.
    { kind: 'gold', guard: 'fighting', totalUnits: 20, poiCount: 10 },
    { kind: 'gold', guard: 'magic', totalUnits: 10, poiCount: 5 },
  ],
};

export const DEFAULT_GAME_CONTENT: GameContent = {
  REWARD_TABLE: DEFAULT_REWARD_TABLE,
};

/**
 * [Q160] The 4 and 5 player map's rewards: every row is 1.4 × the standard
 * map's (gold 48 → 67, speeds and skills 75 → 105). Six rows' sites do not
 * multiply to a whole number; 630 A rounds them to the nearest (9.8 → 10,
 * 8.4 → 8, 2.8 → 3; 11.2 → 11 twice, 5.6 → 6). [Q250] Its rows sit on the
 * standard map's terrains (920 A); the magic gold is 1.4 × its 8 gold on 5
 * sites, 11 on 7 (926 A). [Q270] The stamina is 11 units on 6 sites, 1.4 × the
 * standard map's 8 on 4 (960), so the forest has 25 sites. The plains have 45
 * sites, the mountains 21 and the map 67 gold.
 */
export const LARGER_MAP_REWARD_TABLE: RewardTable = {
  plains: [
    { kind: 'plains_move', guard: null, totalUnits: 28, poiCount: 14 },
    { kind: 'forest_move', guard: null, totalUnits: 21, poiCount: 10 },
    { kind: 'mountain_move', guard: null, totalUnits: 21, poiCount: 11 },
    // [Q255, 932 A] Three fortresses, every pair kept as far apart as on the standard map.
    { kind: 'gold', guard: 'fighting', totalUnits: 14, poiCount: 3, apart: FORTRESSES_APART },
    // [Q250, 926 A] 1.4 × the standard map's 8 gold on 5 sites.
    { kind: 'gold', guard: 'magic', totalUnits: 11, poiCount: 7 },
  ],
  forest: [
    { kind: 'magic', guard: null, totalUnits: 14, poiCount: 8 },
    { kind: 'fighting', guard: null, totalUnits: 21, poiCount: 11 },
    // [Q270, 960] 1.4 × the standard map's hearts and sites, rounded: 11 on 6.
    { kind: 'stamina', guard: null, totalUnits: LARGER_MAP_FOREST_STAMINA_UNITS, poiCount: 6 },
  ],
  mountain: [
    { kind: 'gold', guard: 'fighting', totalUnits: 28, poiCount: 14 },
    { kind: 'gold', guard: 'magic', totalUnits: 14, poiCount: 7 },
  ],
};

export const LARGER_MAP_GAME_CONTENT: GameContent = {
  REWARD_TABLE: LARGER_MAP_REWARD_TABLE,
};
