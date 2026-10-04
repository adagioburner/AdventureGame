import type { GameContent, RewardTable } from './types.ts';

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
 * the plains have a stamina row (900 A, 901 A), unguarded like the speeds, and
 * `POI_COUNT.plains` grew by its 5 sites, since invariant 1 below needs each
 * terrain's `poiCount` column to sum to it. What a unit gives is
 * `STAMINA_PER_UNIT` in defaults.ts.
 */
/**
 * [Q115] The chance that a forest gold POI is guarded by magic instead of by
 * fighting, drawn for each POI on its own (450 A, 451 A). It was 0.5, a coin
 * flip, from 2026-09-30; [Q185] it is 1 since Andrei, 2026-10-01: "make all
 * gold in the forests guarded by magic. Otherwise magic plays too little
 * role". Kept as a chance so a coin flip is this one number away.
 */
export const FOREST_MAGIC_GUARD_CHANCE = 1;

/**
 * [Q185, 730 A] The chance games began with from 2026-09-30 until it became
 * 1: a hot seat game kept from then goes on with the guards it began with.
 */
export const COIN_FLIP_FOREST_MAGIC_GUARD_CHANCE = 0.5;

export const DEFAULT_REWARD_TABLE: RewardTable = {
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
 * 1.4 × today's sites, 35 / 28 / 21.
 */
export const LARGER_MAP_REWARD_TABLE: RewardTable = {
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
