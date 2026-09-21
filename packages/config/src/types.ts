import type { GuardType, IntRange, PerTerrain, RewardKind } from './vocabulary.ts';

/* -------------------------------------------------------------------------- */
/*  GDD.md §11 — Configuration Parameters                                      */
/*                                                                            */
/*  "Every constant below must live in a config file/module, not be           */
/*  hard-coded." Field names are the GDD's own SCREAMING_SNAKE names so the   */
/*  table and the code are greppable 1:1. Nothing in this file may be         */
/*  referenced as an inline literal anywhere else in the repo.                */
/* -------------------------------------------------------------------------- */

/** §11 rows covering map generation geometry and terrain shaping (§2). */
export interface MapConfig {
  /** §11 `MAP_NODE_COUNT` — fixed target (~240). */
  readonly MAP_NODE_COUNT: number;
  /** §11 `MAP_EDGE_COUNT` — fixed target (~300), the budget step 3 prunes to. */
  readonly MAP_EDGE_COUNT: number;
  /**
   * §11 `MAP_COORDINATE_SPACE` — arbitrary, implementer's choice.
   * [SOURCE §1.3, chat] No required real-world scale; the camera zooms to fit
   * at game start.
   */
  readonly MAP_COORDINATE_SPACE: number;
  /**
   * §11 `LEAF_COUNT_MIN` / `MAX` — fixed (30/45). Used twice: as a rejection
   * test inside the prune step (§2.1 step 3) and as a validation test (step 8).
   */
  readonly LEAF_COUNT: IntRange;
  /** §11 `TERRAIN_AREA_SHARE` — approximate target (45% / 30% / 25%). */
  readonly TERRAIN_AREA_SHARE: PerTerrain<number>;
  /**
   * §11 `COMPACTNESS_MAX` — tunable (play-test), starts at 25.
   * [SOURCE §1.3, chat] `compactness = boundary² / area`; circle reference
   * 4π ≈ 13. Enforced by the Smooth step (§2.1 step 5) only — deliberately NOT
   * re-checked at Validate (step 8).
   */
  readonly COMPACTNESS_MAX: number;
  /** §11 `VALLEY_COUNT` — fixed, 2–4 valleys carved per map. */
  readonly VALLEY_COUNT: IntRange;
  /** §11 `VALLEY_WIDTH` — fixed, 1 node wide. */
  readonly VALLEY_WIDTH: number;
  /** §11 `VALLEY_LENGTH` — fixed, 5–12 nodes long. */
  readonly VALLEY_LENGTH: IntRange;
  /**
   * `EDGE_PRUNE_JITTER` — tunable, default 10. Not in §11's original table.
   *
   * [SOURCE §2.1 step 3, chat] "We can choose randomly from the longest
   * EDGE_PRUNE_JITTER = 10 edges." That is what "longest-first, with jitter"
   * means: each removal picks uniformly among the 10 longest edges still
   * present, rather than strictly the longest.
   *
   * 1 would be strict longest-first with no jitter at all.
   */
  readonly EDGE_PRUNE_JITTER: number;
}

/** §11 rows covering POI counts and guard strength (§3, §4.4). */
export interface PoiConfig {
  /** §11 `POI_COUNT` — fixed target, 25 plains / 20 forest / 15 mountain. */
  readonly POI_COUNT: PerTerrain<number>;
  /**
   * `OVERFLOW_LEAF_STAMINA_UNITS` — how many stamina units a leaf POI gets when
   * a terrain has more leaves than its `POI_COUNT` quota. Not in §11.
   *
   * [SOURCE §5/§9, chat] "Fill the extra leaf nodes with stamina rewards" —
   * which both settles what to do with surplus leaves (§3 forces every leaf to
   * be a POI) and gives the otherwise-unused `stamina` kind of §4.1 a home.
   *
   * [SOURCE §9a, chat] "One stamina per leaf" — confirmed.
   *
   * How much stamina a map carries therefore depends on how many leaves
   * overflow, which is not fixed and can well be zero — a proportional spread
   * of 30–45 leaves over quotas of 25/20/15 overflows nothing at all.
   *
   * [SOURCE §4.2, chat] That is accepted: "right now the configuration for
   * stamina is 0, but we may change the rewards balance and add a non-zero
   * default number of stamina rewards." So surplus-leaf stamina is incidental,
   * and the §4.2 table is where stamina will arrive properly when the balance
   * changes.
   */
  readonly OVERFLOW_LEAF_STAMINA_UNITS: number;
  /**
   * §11 `GUARD_STRENGTH_MIN` / `MAX`. §11's table says 2–10, but [SOURCE §5.2,
   * chat] superseded the minimum: the guard-strength formula is "capped between
   * 0 and 10", and 0 is a meaningful outcome — it means the POI ends up
   * unguarded ("1 gold with maximum remoteness is unguarded"). So the range is
   * 0–10 here.
   *
   * Consequence, recorded rather than resolved: §4.4's "every gold POI on every
   * terrain is guarded, none are exempt" no longer holds for low-gold,
   * high-remoteness POIs. The data model already allows `guard: null`, so
   * nothing structural changes.
   */
  readonly GUARD_STRENGTH: IntRange;
}

/** §11 rows covering the balancing model (§4.3, §5). */
export interface BalancingConfig {
  /**
   * §11 `REMOTENESS_WEIGHT` — tunable (play-test). The remoteness term of the
   * §5.2 guard-strength formula; see `GOLD_WEIGHT`.
   */
  readonly REMOTENESS_WEIGHT: number;
  /**
   * `GOLD_WEIGHT` — tunable. **Not in §11's table**: added by the designer in
   * review, in the same "to be fine-tuned later" spirit as §11's own rows, so
   * it lives here rather than in `EngineeringConfig`.
   *
   * [SOURCE §5.2, chat] It resolves §5.2's proportionality into a concrete
   * formula:
   *
   *   `guard_strength = gold × GOLD_WEIGHT − remoteness × REMOTENESS_WEIGHT`,
   *   capped to `GUARD_STRENGTH`.
   *
   * Default 3. Note what the current pair of constants implies: with
   * `GOLD_WEIGHT = 3` and `REMOTENESS_WEIGHT = 4`, any POI holding 5 or more
   * gold caps at 10 for every remoteness value (5 × 3 − 4 = 11 > 10), so
   * remoteness stops discounting the guard once a stack gets that large.
   * Stated as an observation for tuning, not a recommendation.
   */
  readonly GOLD_WEIGHT: number;
  /**
   * §11 `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` — tunable (play-test).
   * §4.3 step 3 only. Deliberately distinct from `REMOTENESS_WEIGHT`.
   */
  readonly REMOTENESS_WEIGHT_FOR_DISTRIBUTION: number;
  /**
   * §11 `CLOSE_CANDIDATE_COUNT` — tunable.
   * Used by the shared random walk (§5.1), by the MCTS rollout policy (§9)
   * and, identically, by MCTS tree expansion.
   *
   * [SOURCE §12.2, review] The tree originally had a K of its own,
   * `MCTS_NODE_EXPANSION_PRUNING` = 10. The designer removed it: "We don't
   * really need two different constants here. We will prune the tree by the
   * CLOSE_CANDIDATE_COUNT, plus one branch for resting." So all three callers
   * of `closestPoiCandidates` now share this one number, and tuning it moves
   * the rollout and the tree together — which is the point.
   */
  readonly CLOSE_CANDIDATE_COUNT: number;
  /** §11 `REMOTENESS_SIMULATION_RUNS` — tunable (100). */
  readonly REMOTENESS_SIMULATION_RUNS: number;
}

/** §11 rows covering movement and rest (§7). */
export interface MovementConfig {
  /**
   * §11 `STAMINA_COST` — fixed, 1 plains / 2 forest / 3 mountain.
   * [SOURCE §1.2, chat] This same per-terrain weight is *the* distance metric
   * used throughout: remoteness walks (§5.1), the UI's shortest-path display
   * (§7.1) and the AI's POI targeting (§9).
   */
  readonly STAMINA_COST: PerTerrain<number>;
  /** §11 `REST_STAMINA_GAIN` — tunable (5). */
  readonly REST_STAMINA_GAIN: number;
}

/** §11 rows covering player setup (§6). */
export interface PlayerConfig {
  /** §11 `PLAYER_COUNT_MIN` / `MAX` — tunable, "not a hard limit" (2–5). */
  readonly PLAYER_COUNT: IntRange;
  /**
   * §11 `STARTING_STAMINA_BASE` — tunable (30).
   * [SOURCE §2, chat] Starting stamina for seat s (1-based) is
   * `STARTING_STAMINA_BASE + (s − 1) × STARTING_STAMINA_INCREMENT`. Expressed
   * as a formula rather than a per-seat list so raising `PLAYER_COUNT.max`
   * needs no new config.
   */
  readonly STARTING_STAMINA_BASE: number;
  /** §11 `STARTING_STAMINA_INCREMENT` — tunable (10). */
  readonly STARTING_STAMINA_INCREMENT: number;
}

/** A dice specification. §11 `GUARD_DIE` is fixed at 1d6 (§8). */
export interface DieSpec {
  readonly count: number;
  readonly sides: number;
}

/** §11 rows covering guard resolution (§8). */
export interface CombatConfig {
  /** §11 `GUARD_DIE` — fixed, d6. §8: `roll + relevant skill > guard_strength`. */
  readonly GUARD_DIE: DieSpec;
}

/**
 * §11 rows covering the AI player (§9).
 *
 * The final row of §11's table — "MCTS tree/selection policy, exploration
 * constant" — is **OPEN** (§12.2) and therefore has no field here. It is
 * carried instead as `EngineeringConfig.pending.MCTS_TREE_POLICY`, an explicit
 * unresolved placeholder, so that a build which needs it fails loudly rather
 * than silently using a value nobody chose.
 */
export interface AiConfig {
  /** §11 `MCTS_TIME_BUDGET_PER_MOVE` — tunable, 10 seconds. Milliseconds. */
  readonly MCTS_TIME_BUDGET_PER_MOVE_MS: number;
  /**
   * `MCTS_EXPLORATION_CONSTANT` — tunable, default √2.
   *
   * [SOURCE §12.2, chat] "For everything else please use sensible defaults that
   * are recommended for standard MCTS implementations." √2 is UCB1's textbook
   * constant, so UCT with c = √2 is that default.
   *
   * √2 is only the right constant because every evaluator returns a value in
   * [0, 1], which is exactly what UCB1's derivation assumes. The invariant is
   * that range, not any one divisor: [SOURCE §9, chat] gold terms divide by the
   * total gold on the map, while the estimated evaluator's skill term divides
   * by total skill units and its weights sum to 1 (Q18). Changing normalisation
   * without revisiting this constant will break the exploration/exploitation
   * balance.
   */
  readonly MCTS_EXPLORATION_CONSTANT: number;
  /**
   * `MIN_REACHABLE_NODES_FOR_REST` — tunable, default 3. Not in §11.
   *
   * [SOURCE §12.2, chat] "Rest is a branch as well. Let us prune it if there
   * are at least MIN_REACHABLE_NODES_FOR_REST = 3 POIs reachable in one turn."
   *
   * So the tree gets a rest branch alongside the POI targets, dropped whenever
   * the player already has three or more targets they can actually reach this
   * turn — resting is only worth searching when movement is constrained.
   *
   * [SOURCE §12.2, review] Untouched by the removal of
   * `MCTS_NODE_EXPANSION_PRUNING`: that collapsed the two Ks, and this is a
   * threshold on reachability, not a K.
   *
   * Counts reachable POI *targets*, despite the name saying nodes; the name is
   * the designer's.
   */
  readonly MIN_REACHABLE_NODES_FOR_REST: number;
}

/**
 * GDD.md §11's table, plus constants the *designer* has added to it in review
 * (currently `GOLD_WEIGHT`). Nothing the implementation invented on its own —
 * that lives in `EngineeringConfig`.
 */
export interface GameConfig {
  readonly map: MapConfig;
  readonly pois: PoiConfig;
  readonly balancing: BalancingConfig;
  readonly movement: MovementConfig;
  readonly players: PlayerConfig;
  readonly combat: CombatConfig;
  readonly ai: AiConfig;
}

/* -------------------------------------------------------------------------- */
/*  GDD.md §4.2 — content tables                                               */
/* -------------------------------------------------------------------------- */

/**
 * One row of the §4.2 table: a *reward group*, which is the unit the §4.3
 * assignment algorithm operates on.
 *
 * The group key is `(kind, guard)` — **not** `kind` alone. That is what lets
 * mountain gold split into 10 fighting-guarded POIs / 20 units and 5
 * magic-guarded POIs / 10 units without inventing an eighth reward kind: both
 * rows carry `kind: 'gold'`, and the guard type sub-partitions the gold group.
 * `RewardKind` stays exactly the seven kinds of §4.1.
 *
 * [SOURCE §1.1, chat] "Where a terrain's gold has more than one guard type
 * (mountain only), the POI-count and unit-total are further split per guard
 * type, since each guard type is effectively its own sub-kind for the §4.3
 * algorithm."
 */
export interface RewardGroupSpec {
  readonly kind: RewardKind;
  /**
   * `null` = unguarded. [SOURCE §1.1, chat] In v1 only gold is guarded and
   * every gold POI is guarded — but this is a *content* choice expressed in
   * this table, not an engine constraint: §4.4 requires that guarding work on
   * any reward kind, which it does, because nothing downstream inspects `kind`
   * to decide whether a guard is legal.
   */
  readonly guard: GuardType | null;
  /** §4.2 "Total units" — the group's total reward units on this terrain. */
  readonly totalUnits: number;
  /** §4.2 "POIs of this kind" — group size; these must sum to `POI_COUNT`. */
  readonly poiCount: number;
}

/** §4.2, keyed by terrain. Rows are ordered as in the GDD for readability. */
export type RewardTable = PerTerrain<readonly RewardGroupSpec[]>;

/** Design *content* (§3/§4.2) as distinct from design *parameters* (§11). */
export interface GameContent {
  readonly REWARD_TABLE: RewardTable;
}

/* -------------------------------------------------------------------------- */
/*  Implementation-only knobs — NOT from GDD.md                                */
/* -------------------------------------------------------------------------- */

/**
 * A value that GDD.md does not specify and that nobody has chosen yet.
 *
 * It is deliberately *not* a number: code that needs one cannot accidentally
 * read a plausible-looking default, and `resolvePending()` throws with the GDD
 * reference attached. See `docs/OPEN_QUESTIONS.md`.
 */
export interface PendingValue<T> {
  readonly __pending: true;
  /** Where the gap lives, e.g. "GDD.md §12.2". */
  readonly gdd: string;
  /** What decision is missing, in one line. */
  readonly question: string;
  /** Always `null` — there is no default, by design. */
  readonly value: T | null;
}

/**
 * Knobs the implementation needs that GDD.md's §11 table does not contain.
 *
 * Kept in its own object, never merged into `GameConfig`, so that "what the
 * designer specified" and "what the implementation had to add" can never be
 * confused for one another.
 */
export interface EngineeringConfig {
  /**
   * Safety valve for the regenerate-on-failure loop of §2.1 step 8. Not a
   * design value — without a bound, a pathological `(seed, params)` pair loops
   * forever.
   */
  readonly MAX_GENERATION_ATTEMPTS: number;
  /**
   * Poisson-disc minimum separation, as a fraction of the naive spacing
   * implied by `MAP_NODE_COUNT` over `MAP_COORDINATE_SPACE`. Purely a knob for
   * making step 1 hit its node budget; §11 leaves sampling detail to the
   * implementer.
   */
  readonly POISSON_RADIUS_FACTOR: number;
  /** Values GDD.md leaves genuinely undecided. Never silently defaulted. */
  readonly pending: PendingConfig;
}

/**
 * Unresolved design values.
 *
 * **Currently empty** — every open item from GDD.md §12, and every gap found
 * while building against it, has now been decided. The machinery stays because
 * it is the mechanism that keeps "undecided" from decaying into "whatever the
 * first implementer typed": a new gap becomes a `PendingValue` here, and
 * `resolvePending()` throws on it with the GDD reference attached.
 */
export interface PendingConfig {
  readonly [key: string]: PendingValue<unknown> | undefined;
}

/** Everything needed to generate and run a game, in three separated layers. */
export interface Ruleset {
  /** GDD.md §11, verbatim. */
  readonly config: GameConfig;
  /** GDD.md §3/§4.2 content tables. */
  readonly content: GameContent;
  /** Implementation-only; explicitly not design. */
  readonly engineering: EngineeringConfig;
}
