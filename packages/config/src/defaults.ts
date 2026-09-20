import type { EngineeringConfig, GameConfig, PendingValue } from './types.ts';

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
  },
  pois: {
    POI_COUNT: { plains: 25, forest: 20, mountain: 15 },
    // §11 says 2; [SOURCE §5.2, chat] caps the formula at 0, where 0 = unguarded.
    GUARD_STRENGTH: { min: 0, max: 10 },
  },
  balancing: {
    REMOTENESS_WEIGHT: 4,
    GOLD_WEIGHT: 3,
    REMOTENESS_WEIGHT_FOR_DISTRIBUTION: 2,
    CLOSE_CANDIDATE_COUNT: 5,
    REMOTENESS_SIMULATION_RUNS: 100,
  },
  movement: {
    STAMINA_COST: { plains: 1, forest: 2, mountain: 3 },
    REST_STAMINA_GAIN: 5,
  },
  players: {
    PLAYER_COUNT: { min: 2, max: 5 },
    STARTING_STAMINA_BASE: 30,
    STARTING_STAMINA_INCREMENT: 10,
  },
  combat: {
    GUARD_DIE: { count: 1, sides: 6 },
  },
  ai: {
    MCTS_TIME_BUDGET_PER_MOVE_MS: 10_000,
    MCTS_NODE_EXPANSION_PRUNING: 10,
    // UCB1's textbook constant. See the tuning caveat on the field.
    MCTS_EXPLORATION_CONSTANT: Math.SQRT2,
  },
};

function pending<T>(gdd: string, question: string): PendingValue<T> {
  return { __pending: true, gdd, question, value: null };
}

/**
 * Implementation-only knobs. Nothing here comes from GDD.md, and the `pending`
 * block holds values nobody has decided yet — reading one throws.
 */
export const DEFAULT_ENGINEERING_CONFIG: EngineeringConfig = {
  MAX_GENERATION_ATTEMPTS: 50,
  POISSON_RADIUS_FACTOR: 0.85,
  pending: {
    EDGE_PRUNE_JITTER: pending(
      'GDD.md §2.1 step 3',
      'Edges are pruned "longest-first, with jitter" — how much jitter, and applied how?',
    ),
  },
};
