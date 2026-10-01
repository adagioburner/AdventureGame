import type { EngineeringConfig, GameConfig } from './types.ts';
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
    THINKING_TIME_SECONDS: { min: 1, max: 60 },
  },
  // [Q135] Andrei, 2026-09-30, 530 A, 531 C, 533 A; 22:56 "keep at least 2 of each
  // skill on the map (instead of 3)", and 2026-10-01 "We need two *sites* with
  // the skill at any time, not two units of skill on the map".
  respawn: {
    KINDS: SKILL_KINDS,
    SHORT_BELOW_SITES: 2,
    FAR_SHARE: 0.5,
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
