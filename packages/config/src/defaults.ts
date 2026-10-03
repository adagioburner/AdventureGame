import type { EngineeringConfig, GameConfig, RespawnConfig } from './types.ts';
import { SKILL_KINDS } from './vocabulary.ts';

/**
 * GDD.md §11 "Configuration Parameters", transcribed with no substitutions.
 *
 * Several of these are marked "tunable (play-test)" or "starting value" in the
 * GDD. They are *values the designer intends to tune*, not placeholders — do
 * not replace, round, derive or optimise any of them.
 */
export const DEFAULT_GAME_CONFIG: GameConfig = {
  map: {
    MAP_NODE_COUNT: 240,
    MAP_EDGE_COUNT: 300,
    MAP_COORDINATE_SPACE: 1_000_000,
    LEAF_COUNT: { min: 30, max: 45 },
    TERRAIN_AREA_SHARE: { plains: 0.45, forest: 0.3, mountain: 0.25 },
    COMPACTNESS_MAX: 25,
    VALLEY_COUNT: { min: 2, max: 4 },
    VALLEY_WIDTH: 1,
    VALLEY_LENGTH: { min: 5, max: 12 },
    EDGE_PRUNE_JITTER: 10,
    // Started at 2 (Q105, 391); Andrei asked for 1 after looking at maps with 2 (Q105, 398).
    BORDER_ROAD_PLACES: 1,
    BORDER_AREA_MIN_SIZE: 5,
    BORDER_ROAD_MAX_LENGTH: 1.3,
    JOINED_PIECE_ROADS: 1,
  },
  pois: {
    POI_COUNT: { plains: 25, forest: 20, mountain: 15 },
    OVERFLOW_LEAF_STAMINA_UNITS: 1,
    // §11 says 2; [SOURCE §5.2, chat] caps the formula at 0, where 0 = unguarded.
    GUARD_STRENGTH: { min: 0, max: 10 },
  },
  balancing: {
    REMOTENESS_WEIGHT: 4,
    GOLD_WEIGHT: 3,
    REMOTENESS_WEIGHT_FOR_DISTRIBUTION: 2,
    REWARD_SWAP_PASSES: 5,
    CLOSE_CANDIDATE_COUNT: 10,
    REMOTENESS_CANDIDATE_COUNT: 10,
    REMOTENESS_SIMULATION_RUNS: 100,
  },
  movement: {
    STAMINA_COST: { plains: 1, forest: 2, mountain: 3 },
    REST_STAMINA_GAIN: 5,
  },
  players: {
    PLAYER_COUNT: { min: 2, max: 5 },
    STARTING_STAMINA_BASE: 30,
    STARTING_STAMINA_INCREMENT: 5,
    // [Q200] Andrei, 2026-10-02: "starts them with 5 gold to enable a variety of strategies".
    STARTING_GOLD: 5,
  },
  combat: {
    GUARD_DIE: { count: 1, sides: 6 },
  },
  ai: {
    MCTS_TIME_BUDGET_PER_MOVE_MS: 10_000,
    // UCB1's textbook constant. See the tuning caveat on the field.
    MCTS_EXPLORATION_CONSTANT: Math.SQRT2,
    MIN_REACHABLE_NODES_FOR_REST: 3,
    SIMULATION_TURN_CAP: 250,
    STAMINA_PER_SKILL_POINT: 5,
    BUY_SKIP_STAMINA: 5,
    THINKING_TIME_SECONDS: { min: 1, max: 60 },
  },
  // [Q190] Andrei, 2026-10-02: "allow players buy skills for gold, 1 to 1. We
  // won't need respawning skills then"; 753 the five skills, never stamina.
  // Speeds and skills no longer come back in new games (757): `respawn` is
  // left out here, and `RESPAWN_RULES` keeps what the games started before
  // this play by.
  buying: {
    KINDS: SKILL_KINDS,
    GOLD_PER_UNIT: 1,
  },
  // [Q226] Andrei, 2026-10-03: "the ideal number would leave a few positions
  // on average (around 10) and be small enough to find something even in the
  // worst case" (856).
  start: {
    MIN_SPACES: 10,
    // [Q226] 863: "let's try half and half, and see how that looks".
    DISTANCE_SHARE: 0.5,
  },
};

/**
 * [Q135] How speeds and skills came back, in the games started before they
 * could be bought (Q190, 757 and 758), which keep these rules to the end.
 * Andrei, 2026-09-30, 530 A, 531 C, 533 A; 22:56 "keep at least 2 of each
 * skill on the map (instead of 3)", and 2026-10-01 "We need two *sites* with
 * the skill at any time, not two units of skill on the map". MAX_UNITS:
 * 2026-10-01 "let us cap the skills to 2 units when they respawn", then the
 * same day "Let's change that cap to one".
 */
export const RESPAWN_RULES: RespawnConfig = {
  KINDS: SKILL_KINDS,
  SHORT_BELOW_SITES: 2,
  FAR_SHARE: 0.5,
  MAX_UNITS: 1,
};

/**
 * [Q160] Andrei, 2026-10-01: "for four and five player games we need larger
 * maps. let's make them 40% larger [...] the number of [spaces] for each
 * terrain, number of [sites] and number of skill units and the gold offered
 * should all scale by 40%." Each number below is 1.4 × today's:
 *
 *  - `MAP_NODE_COUNT` 240 → 336; the terrain shares stay 45/30/25, so each
 *    terrain gets 1.4 × its spaces too (about 151/101/84);
 *  - `POI_COUNT` 25/20/15 → 35/28/21;
 *  - 631 A: roads 300 → 420 (300 cannot join 336 spaces at all) and dead ends
 *    30–45 → 42–63. Valleys stay as they are.
 *
 * The rewards are `LARGER_MAP_REWARD_TABLE` in content.ts. Everything else is
 * today's (633 A).
 */
export const LARGER_MAP_GAME_CONFIG: GameConfig = {
  ...DEFAULT_GAME_CONFIG,
  map: {
    ...DEFAULT_GAME_CONFIG.map,
    MAP_NODE_COUNT: 336,
    MAP_EDGE_COUNT: 420,
    LEAF_COUNT: { min: 42, max: 63 },
  },
  pois: {
    ...DEFAULT_GAME_CONFIG.pois,
    POI_COUNT: { plains: 35, forest: 28, mountain: 21 },
  },
};

/**
 * Implementation-only knobs. Nothing here comes from GDD.md, and the `pending`
 * block holds values nobody has decided yet — reading one throws.
 */
export const DEFAULT_ENGINEERING_CONFIG: EngineeringConfig = {
  MAX_GENERATION_ATTEMPTS: 50,
  POISSON_RADIUS_FACTOR: 0.815,
  // Every design value is decided; see the note on `PendingConfig`.
  pending: {},
};

/**
 * The larger map's knobs: today's, but with the sampler's spacing calibrated on
 * the larger map. 0.815 yields about 330 spaces against 336 there, because a
 * bigger map has relatively less edge where sampling packs looser.
 */
export const LARGER_MAP_ENGINEERING_CONFIG: EngineeringConfig = {
  ...DEFAULT_ENGINEERING_CONFIG,
  POISSON_RADIUS_FACTOR: 0.808,
};
