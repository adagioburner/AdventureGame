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
 * `stamina` had no row of §4.2 until [Q240]: "right now the configuration for
 * stamina is 0, but we may change the rewards balance and add a non-zero
 * default number of stamina rewards" (§4.2, chat), and the only stamina a map
 * carried was incidental, from surplus leaf nodes (§3/§9, chat). Andrei,
 * 2026-10-03: "I'd like to add stamina rewarding sites to plains [...] 5 sites,
 * rewarding 10 stamina units total (and each stamina unit adds 5 stamina).
 * [...] Stamina sites follow the same rules any other reward type does." So
 * the plains had a stamina row (900 A, 901 A), unguarded like the speeds, and
 * `POI_COUNT.plains` grew by its 5 sites, since invariant 1 below needs each
 * terrain's `poiCount` column to sum to it. What a unit gives is
 * `STAMINA_PER_UNIT` in defaults.ts. Since [Q250] the row is the forest's.
 */
/**
 * [Q115] The chance that a forest gold POI is guarded by magic instead of by
 * fighting, drawn for each POI on its own (450 A, 451 A). It was 0.5, a coin
 * flip, from 2026-09-30; [Q185] it is 1 since Andrei, 2026-10-01: "make all
 * gold in the forests guarded by magic. Otherwise magic plays too little
 * role". Kept as a chance so a coin flip is this one number away. [Q250]
 * Since the rewards moved terrain the forest has no gold, so only
 * `REWARD_TABLE_BEFORE_MOVE` and the maps from before use it.
 */
export const FOREST_MAGIC_GUARD_CHANCE = 1;

/**
 * [Q185, 730 A] The chance games began with from 2026-09-30 until it became
 * 1: a hot seat game kept from then goes on with the guards it began with.
 */
export const COIN_FLIP_FOREST_MAGIC_GUARD_CHANCE = 0.5;

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
 * [Q260] Andrei, 2026-10-05, after computer games on 60 maps with 10 and with
 * 12: "Stamina sites with just one heart are not very attractive [...] let's
 * change the total stamina units to 12." The hearts on the forest's 6 stamina
 * sites, drawn by §4.3 like every reward (942 A)...
 */
export const FOREST_STAMINA_UNITS = 12;

/** [Q260, 940 A] ...and on the 4-5 player map's 9: 1.4 × 12 = 16.8, rounded. */
export const LARGER_MAP_FOREST_STAMINA_UNITS = 17;

/**
 * [Q260, 941 A] The hearts before, 10 and 14, which games started before keep:
 * `withEarlierStaminaUnits` in index.ts.
 */
export const EARLIER_FOREST_STAMINA_UNITS = 10;
export const EARLIER_LARGER_MAP_FOREST_STAMINA_UNITS = 14;

/**
 * [Q250] Andrei, 2026-10-04: "we seem to have found a simple super strategy:
 * buy forest speed +4 and go to the forest. We need to change the allocation
 * of resources between terrains." The plains get the three speeds, "the gold
 * guarded by magic that used to be in the forest before" and the two
 * fortresses; the forests get magic, combat and stamina; the mountains stay as
 * they were. Every row kept its units and its sites and only moved terrain
 * (920 A), and then, the same day: "we can fill forests up to their usual 20
 * sites, by changing stamina to 6/10. And on plains, gold with magic guards
 * can grow to 5/8". So the forest has 20 sites and the plains 32, and the map
 * 48 gold. [Q260] The stamina sites hold 12 hearts since 2026-10-05. The magic gold's guards follow §5.2 as all gold does (921 A). The
 * table before is `REWARD_TABLE_BEFORE_MOVE`, which games started before keep.
 */
export const DEFAULT_REWARD_TABLE: RewardTable = {
  plains: [
    { kind: 'plains_move', guard: null, totalUnits: 20, poiCount: 10 },
    { kind: 'forest_move', guard: null, totalUnits: 15, poiCount: 7 },
    { kind: 'mountain_move', guard: null, totalUnits: 15, poiCount: 8 },
    // [SOURCE §1.1] Informally "cities"; Andrei's "fortresses". [Q255] Kept apart.
    { kind: 'gold', guard: 'fighting', totalUnits: 10, poiCount: 2, apart: FORTRESSES_APART },
    // [Q250] The forest's magic-guarded gold, moved, and grown from 5 gold on 4 sites.
    { kind: 'gold', guard: 'magic', totalUnits: 8, poiCount: 5 },
  ],
  forest: [
    { kind: 'magic', guard: null, totalUnits: 10, poiCount: 6 },
    { kind: 'fighting', guard: null, totalUnits: 15, poiCount: 8 },
    // [Q240] The stamina sites, moved here by [Q250], 6 of them instead of 5; [Q260] 12 hearts, 10 before.
    { kind: 'stamina', guard: null, totalUnits: FOREST_STAMINA_UNITS, poiCount: 6 },
  ],
  mountain: [
    // Mountain gold is split by guard type. Both rows are `kind: 'gold'`:
    // the split is a sub-partition of the gold group, not an extra kind.
    { kind: 'gold', guard: 'fighting', totalUnits: 20, poiCount: 10 },
    { kind: 'gold', guard: 'magic', totalUnits: 10, poiCount: 5 },
  ],
};

/**
 * [Q250] The rewards by terrain before they moved, which a game started
 * before keeps: speeds for the plains and forest, magic and stamina on the
 * plains, and the forest's gold guarded by `FOREST_MAGIC_GUARD_CHANCE`.
 */
export const REWARD_TABLE_BEFORE_MOVE: RewardTable = {
  plains: [
    { kind: 'plains_move', guard: null, totalUnits: 20, poiCount: 10 },
    { kind: 'forest_move', guard: null, totalUnits: 15, poiCount: 7 },
    { kind: 'magic', guard: null, totalUnits: 10, poiCount: 6 },
    // [SOURCE §1.1] Informally "cities".
    { kind: 'gold', guard: 'fighting', totalUnits: 10, poiCount: 2 },
    // [Q240] The stamina sites. Changing `poiCount` changes POI_COUNT.plains with it.
    { kind: 'stamina', guard: null, totalUnits: 10, poiCount: 5 },
  ],
  forest: [
    { kind: 'mountain_move', guard: null, totalUnits: 15, poiCount: 8 },
    { kind: 'fighting', guard: null, totalUnits: 15, poiCount: 8 },
    // [Q115, Q185] Each POI's guard is magic by FOREST_MAGIC_GUARD_CHANCE (1: always), else fighting.
    { kind: 'gold', guard: 'fighting', totalUnits: 5, poiCount: 4, magicGuardChance: FOREST_MAGIC_GUARD_CHANCE },
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
 * [Q160] The 4 and 5 player map's rewards: every row's units are 1.4 × today's
 * (gold 45 → 63, speeds and skills 75 → 105). Six rows' sites do not multiply
 * to a whole number; 630 A rounds them to the nearest (9.8 → 10, 8.4 → 8,
 * 2.8 → 3; 11.2 → 11 twice, 5.6 → 6), and each terrain still totals exactly
 * 1.4 × today's sites, 35 / 28 / 21. [Q250] Its rows moved terrain with the
 * standard map's, each keeping its sites (920 A); the magic gold is 1.4 × its
 * 8 gold on 5 sites, 11 on 7 (926 A), and the stamina 14 units on 9 sites, so
 * the forest keeps its 28 (925 A), 17 units since [Q260] (940 A). The plains have 45 sites and the map 67 gold.
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
    // [Q240, 902 A] 1.4 × the stamina units, 14 before [Q260] and 17 since (940 A); [Q250, 925 A] on 9 sites, not 8, so the forest keeps its 28.
    { kind: 'stamina', guard: null, totalUnits: LARGER_MAP_FOREST_STAMINA_UNITS, poiCount: 9 },
  ],
  mountain: [
    { kind: 'gold', guard: 'fighting', totalUnits: 28, poiCount: 14 },
    { kind: 'gold', guard: 'magic', totalUnits: 14, poiCount: 7 },
  ],
};

/** [Q250] The larger map's rewards before they moved: see `REWARD_TABLE_BEFORE_MOVE`. */
export const LARGER_MAP_REWARD_TABLE_BEFORE_MOVE: RewardTable = {
  plains: [
    { kind: 'plains_move', guard: null, totalUnits: 28, poiCount: 14 },
    { kind: 'forest_move', guard: null, totalUnits: 21, poiCount: 10 },
    { kind: 'magic', guard: null, totalUnits: 14, poiCount: 8 },
    { kind: 'gold', guard: 'fighting', totalUnits: 14, poiCount: 3 },
    // [Q240, 902 A] 1.4 × the stamina sites too: 7 sites, 14 units.
    { kind: 'stamina', guard: null, totalUnits: 14, poiCount: 7 },
  ],
  forest: [
    { kind: 'mountain_move', guard: null, totalUnits: 21, poiCount: 11 },
    { kind: 'fighting', guard: null, totalUnits: 21, poiCount: 11 },
    { kind: 'gold', guard: 'fighting', totalUnits: 7, poiCount: 6, magicGuardChance: FOREST_MAGIC_GUARD_CHANCE },
  ],
  mountain: [
    { kind: 'gold', guard: 'fighting', totalUnits: 28, poiCount: 14 },
    { kind: 'gold', guard: 'magic', totalUnits: 14, poiCount: 7 },
  ],
};

export const LARGER_MAP_GAME_CONTENT: GameContent = {
  REWARD_TABLE: LARGER_MAP_REWARD_TABLE,
};
