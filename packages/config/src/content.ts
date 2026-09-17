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
 * no row of §4.2, so v1 content places no stamina rewards on the map. The
 * engine supports the kind regardless. Flagged as OPEN_QUESTIONS Q5.
 */
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
    { kind: 'gold', guard: 'fighting', totalUnits: 5, poiCount: 4 },
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
