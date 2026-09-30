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
 * Note what is *absent*: `stamina` appears in §4.1's seven reward kinds but in
 * no row of §4.2. [SOURCE §4.2, chat] that is deliberate — "right now the
 * configuration for stamina is 0, but we may change the rewards balance and add
 * a non-zero default number of stamina rewards". The only stamina a v1 map
 * carries is incidental, from surplus leaf nodes (§3/§9, chat).
 *
 * Adding a stamina row later is a config edit, but **not a purely additive
 * one**: invariant 1 requires each terrain's `poiCount` column to sum to
 * `POI_COUNT[terrain]`, so giving stamina POIs means taking them from another
 * kind on that terrain. `validateRuleset` catches it either way.
 */
/**
 * [Q115] The chance that a forest gold POI is guarded by magic instead of by
 * fighting, drawn for each POI on its own (450 A, 451 A): at 0.5 a map has 0
 * to 4 magic-guarded forest gold POIs, 2 on 3 maps in 8 and none on 1 in 16.
 * Andrei, 2026-09-30: "Magic doesn't play an important enough role."
 */
export const FOREST_MAGIC_GUARD_CHANCE = 0.5;

export const DEFAULT_REWARD_TABLE: RewardTable = {
  plains: [
    { kind: 'plains_move', guard: null, totalUnits: 20, poiCount: 10 },
    { kind: 'forest_move', guard: null, totalUnits: 15, poiCount: 7 },
    { kind: 'magic', guard: null, totalUnits: 10, poiCount: 6 },
    // [SOURCE §1.1] Informally "cities".
    { kind: 'gold', guard: 'fighting', totalUnits: 10, poiCount: 2 },
  ],
  forest: [
    { kind: 'mountain_move', guard: null, totalUnits: 15, poiCount: 8 },
    { kind: 'fighting', guard: null, totalUnits: 15, poiCount: 8 },
    // [Q115] Each POI's guard is fighting or, by a coin flip, magic.
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
