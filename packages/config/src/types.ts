import type { GuardType, IntRange, PerTerrain, RewardKind, Terrain } from './vocabulary.ts';

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
  /**
   * §11 `VALLEY_COUNT` — 2–4 valleys carved per map until Q245, none since:
   * "stop making valleys, because now we are getting them for free" (Andrei,
   * 2026-10-04). The maps of games started before keep `EARLIER_VALLEY_COUNT`.
   */
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
  /**
   * `BORDER_ROAD_PLACES` — tunable, default 1. Not in §11's original table.
   *
   * [SOURCE §2.1 step 6b, chat] Terrain grows along step 3's near-tree of
   * roads, so two terrains meet exactly where roads are fewest: over 100 maps,
   * 12% had no road at all between plains and forest. Step 6b puts pruned
   * roads back until every two touching terrain areas meet in at least this
   * many separate places (roads that share a space count as one place).
   * "Let's start with 2, and make it a configurable constant that is easy to
   * change to 3" (OPEN_QUESTIONS Q105, 391); then, after looking at maps with
   * 2, "let's change it to 1 first and see if that is enough" (398). At 1
   * only areas that do not meet by road at all get one.
   */
  readonly BORDER_ROAD_PLACES: number;
  /**
   * `BORDER_AREA_MIN_SIZE` — tunable, default 5. Not in §11.
   *
   * Step 6b only joins areas of at least this many spaces, so a stray space of
   * one terrain inside another is left as it is (OPEN_QUESTIONS Q105, 395).
   */
  readonly BORDER_AREA_MIN_SIZE: number;
  /**
   * `BORDER_ROAD_MAX_LENGTH` — tunable, default 1.3. Not in §11.
   *
   * Step 6b never puts back a road longer than this multiple of the longest
   * road step 3 kept, so a put-back road looks like any other road on the map
   * (OPEN_QUESTIONS Q105, 393).
   */
  readonly BORDER_ROAD_MAX_LENGTH: number;
  /**
   * `JOINED_PIECE_ROADS` — tunable, default 1. Not in §11.
   *
   * Two pieces of the same terrain that touch on the ground but have no road
   * between them get this many roads put back by step 6b; 0 leaves them apart
   * (OPEN_QUESTIONS Q105, 394).
   */
  readonly JOINED_PIECE_ROADS: number;
  /**
   * [Q245] `TERRAIN_SEEDS` — how many seeds each terrain grows from in step 4
   * (§2.1), drawn per map between `min` and `max`. 2 for every terrain, on
   * both map sizes.
   *
   * Andrei, 2026-10-04, after looking at maps grown from 3 seeds without
   * keeping areas apart ("Many second or third components are tiny, not
   * adding much to the map structure"): "start with 2 seeds for forest and
   * mountains, and don't let them merge"; "We can do 2 seeds for plains but we
   * don't care if they merge or not. This applies to all map sizes". Which
   * terrains are kept apart is `KEPT_APART`.
   *
   * Absent on the maps of games started before, which grew every terrain from
   * `EARLIER_TERRAIN_SEEDS`, kept nothing apart and carved valleys (913).
   */
  readonly TERRAIN_SEEDS?: PerTerrain<IntRange>;
  /**
   * [Q245] Terrains whose separate areas never grow into each other, in step
   * 4's fill and in the share balancing of steps 4 and 6. Absent on the maps
   * of games started before, like `TERRAIN_SEEDS`.
   */
  readonly KEPT_APART?: KeptApartConfig;
}

/**
 * [Q245] How separate areas of a terrain are kept apart. An area never takes a
 * space that would bring it within `GAP` spaces of another area of its own
 * terrain, counting spaces that touch on the ground (step 2's triangulation),
 * not only by road.
 */
export interface KeptApartConfig {
  /** "don't let them merge": the forest and the mountains. */
  readonly TERRAINS: readonly Terrain[];
  /** "1 space gap should be enough, like what we have for valleys width today": 1. */
  readonly GAP: number;
  /**
   * 916: whether, on a map where the shares can be reached no other way, the
   * share balancing may give a terrain a space that joins two of its areas.
   */
  readonly JOIN_FOR_SHARES: boolean;
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
   * [Q240] `STAMINA_PER_UNIT` — the stamina one unit of a stamina reward gives
   * when it is claimed, on every stamina site, the spare dead ends' included
   * (903 A). Andrei, 2026-10-03: "each stamina unit adds 5 stamina".
   *
   * Absent on the maps of games started before stamina sites came to the
   * plains, whose stamina units give 1 stamina each, as they began with.
   */
  readonly STAMINA_PER_UNIT?: number;
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
   * §11 `REWARD_SWAP_PASSES` — tunable (play-test). §4.3 step 4 only.
   *
   * How many pair draws each §4.2 row gets, as a multiple of the number of POIs
   * in the row: a row of 10 POIs and 5 passes draws 50 pairs.
   *
   * [SOURCE §4.3, review] Step 3's weighted draw leans the right way but only
   * weakly — measured over 200 maps, the bigger of two stacks in the same row
   * was the more remote one 57.1% of the time, and raising
   * `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` saturates near 65% because the draw is
   * random and most rows have barely more spare units than POIs. Step 4 fixes
   * that by repair rather than by weighting. Measured agreement by pass count:
   * 0 → 57.1%, 2 → 86.8%, 3 → 91.8%, 5 → 96.3%, 10 → 99.3%. Three clears
   * Andrei's 90% across a batch; the default of 5 clears it on all but one map
   * in 200 taken one at a time.
   */
  readonly REWARD_SWAP_PASSES: number;
  /**
   * §11 `CLOSE_CANDIDATE_COUNT` — tunable. The computer player's K: used by
   * the MCTS rollout policy (§9) and, identically, by MCTS tree expansion.
   *
   * [SOURCE §12.2, review] The tree originally had a K of its own,
   * `MCTS_NODE_EXPANSION_PRUNING` = 10. The designer removed it: "We don't
   * really need two different constants here. We will prune the tree by the
   * CLOSE_CANDIDATE_COUNT, plus one branch for resting." So the rollout and the
   * tree share this one number, and tuning it moves them together — which is
   * the point.
   *
   * [SOURCE §5.1, review] It no longer sets the remoteness walk's K, which is
   * `REMOTENESS_CANDIDATE_COUNT`: "if we change the setting for the number of
   * the closest places, it should affect computer player only [...] these two
   * definitely need to be separated."
   */
  readonly CLOSE_CANDIDATE_COUNT: number;
  /**
   * §11 `REMOTENESS_CANDIDATE_COUNT` — tunable (10). The K of §5.1's
   * remoteness walk, which runs while a map is generated: each leg moves to
   * one of this many closest unvisited POIs. Split from
   * `CLOSE_CANDIDATE_COUNT` so the map and the computer player tune apart.
   */
  readonly REMOTENESS_CANDIDATE_COUNT: number;
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
  /** §11 `STARTING_STAMINA_INCREMENT` — tunable (5; 10 until Q75). */
  readonly STARTING_STAMINA_INCREMENT: number;
  /**
   * §11 `STARTING_GOLD` — tunable (5). [Q200] Andrei, 2026-10-02: "Now that
   * players can buy skills for gold, it makes sense to starts them with 5
   * gold to enable a variety of strategies". The same for every seat.
   *
   * Absent on the maps of games started before it (790), whose players
   * started with none: an online game carries the config its map was made
   * with. Read it through `startingGoldOf`.
   */
  readonly STARTING_GOLD?: number;
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
  /**
   * `SIMULATION_TURN_CAP` — 250. Not in §11; the designer's, 2026-09-24 (Q44).
   *
   * [SOURCE §9, review] A game the computer plays out in its head stops after
   * this many turns, counted from the position it is thinking about, "and give
   * the victory to whatever player has more gold". It is there for Q30's
   * position, where the gold left is behind guards nobody can beat and a
   * simulated game would otherwise never stop.
   */
  readonly SIMULATION_TURN_CAP: number;
  /**
   * `STAMINA_PER_SKILL_POINT` — 5. Not in §11; the designer's, 2026-09-30.
   *
   * [SOURCE §9, chat] The estimated evaluation counts stamina with the skills:
   * "gold * game_progress + (total skill points + stamina / 5) * (1 -
   * game_progress)", each term over its total. So this many stamina weigh as
   * much as one skill point. Its own setting rather than `REST_STAMINA_GAIN`,
   * though both are 5 today.
   */
  readonly STAMINA_PER_SKILL_POINT: number;
  /**
   * `BUY_SKIP_STAMINA` — 5. [Q190] Andrei, 2026-10-02: "buying a skill is not
   * available to a computer player if that skill is within 1 turn reach from
   * them [...] or 1 turn reach plus some stamina"; 759 B, plus 5 stamina.
   *
   * The computer's search has no branch for buying a skill while an unclaimed
   * site offering it can be reached this turn for at most this much stamina
   * past its free steps, and no more than it holds. 5 is what his distance
   * formula (Q65) counts a turn as.
   */
  readonly BUY_SKIP_STAMINA: number;
  /**
   * The thinking time a computer seat can be given on the start game panel, in
   * whole seconds. Not in §11; the designer's, 2026-09-24 (Q41): 1 to 60, the
   * box starting at `MCTS_TIME_BUDGET_PER_MOVE_MS`.
   */
  readonly THINKING_TIME_SECONDS: IntRange;
}

/**
 * [Q135] Speeds and skills coming back to empty sites once they run short.
 *
 * Andrei, 2026-09-30: "Skills need to respawn where there are too few of it
 * left, randomly at POIs that were offering this skill before and are far from
 * all players." At the end of every turn each kind in `KINDS` is counted on its
 * own; while fewer than `SHORT_BELOW_SITES` unclaimed POIs offer it, one
 * claimed POI that held it gets its reward back each turn (532 A), at most
 * `MAX_UNITS` of it, picked
 * at random from the `FAR_SHARE` of them farthest from the nearest figure
 * (533 A), by the cheapest route's stamina cost (534 A), never one a figure
 * stands on. A POI can come back any number of times (535 A).
 */
export interface RespawnConfig {
  /** 530 A: the five skills, the three speeds with combat and magic. Never gold or stamina. */
  readonly KINDS: readonly RewardKind[];
  /**
   * 531 C: a kind is short while fewer than this many unclaimed POIs offer it,
   * whatever the player count or their units. 2 (Andrei, 2026-10-01: "We need
   * two *sites* with the skill at any time, not two units of skill on the map").
   */
  readonly SHORT_BELOW_SITES: number;
  /** 533 A: the share of the empty POIs, farthest first and rounded up, the pick is made from. 0.5. */
  readonly FAR_SHARE: number;
  /**
   * The most units a POI that comes back offers; one that held fewer gets
   * those back. 1 (Andrei, 2026-10-01: "let us cap the skills to 2 units when
   * they respawn. The idea is to provide a player who was late to the party
   * with something to do, not to create a cornucopia"; then, having played,
   * "even capping regrown skills by 2 is too much. It's not supposed to be
   * easy when skills run out. Starving your opponents of some skill should be
   * one of the strategies. Let's change that cap to one."). Games keep the cap
   * they started with: 2 for those started under it, and absent on games
   * started before the cap, which bring back the whole reward (532 A).
   */
  readonly MAX_UNITS?: number;
}

/**
 * [Q190] Buying speeds and skills with gold.
 *
 * Andrei, 2026-10-02: "allow players buy skills for gold, 1 to 1. We won't
 * need respawning skills then, this mechanism substitutes that." On their own
 * turn, before they end it, a player buys one unit of a kind in `KINDS` for
 * `GOLD_PER_UNIT` gold, as many times as their gold pays for (751, Free). A
 * speed bought counts this turn too (752). The gold leaves the game (756).
 */
export interface BuyingConfig {
  /** 753: the five skills, the three speeds with combat and magic. Never stamina or gold. */
  readonly KINDS: readonly RewardKind[];
  /** The gold one unit costs: 1 ("1 to 1"). */
  readonly GOLD_PER_UNIT: number;
}

/**
 * [Q227] Where the figures start: the plains space that is not a site and is
 * the most road steps from every forest and mountain space, among those whose
 * remoteness is below `MAX_REMOTENESS` (878). A space's remoteness is the
 * average remoteness (§5.1) of the sites, of any terrain, within
 * `NEARBY_STEPS` road steps of it (876). Remoteness itself is unchanged.
 *
 * Andrei, 2026-10-03, after measuring it: "change the starting place to go to
 * the deepest plains space with remoteness less than 0.1. We don't need any
 * changes in how remoteness is calculated". Of equally deep spaces, the least
 * remote (873); with none below `MAX_REMOTENESS`, the least remote space (874).
 */
export interface StartConfig {
  /** 876: the road steps within which a space's sites are averaged. 5. */
  readonly NEARBY_STEPS: number;
  /** "please make 0.1 a config setting": the start's remoteness is below this. 0.1. */
  readonly MAX_REMOTENESS: number;
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
  /**
   * [Q135] Absent on the maps of games started before speeds and skills came
   * back: an online game carries the config its map was made with, and those
   * games keep the rules they started with to the end.
   */
  readonly respawn?: RespawnConfig;
  /**
   * [Q190] Absent on the maps of games started before speeds and skills could
   * be bought, which keep the rules they started with (758), speeds and skills
   * coming back included; present on every game started since, which have no
   * `respawn` (757).
   */
  readonly buying?: BuyingConfig;
  /**
   * [Q227] Absent on the maps of games started before the start moved deep
   * into the plains, which keep the start they began on: a random plains
   * space that is not a site.
   */
  readonly start?: StartConfig;
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
  /**
   * [Q115] The chance, from 0 to 1, that a POI of this group is guarded by
   * magic instead of by `guard`, flipped for each POI on its own, so a map
   * carries anywhere from none to all of the group's POIs magic-guarded.
   * Absent means never. Only a fighting-guarded row may carry it.
   *
   * The POI stays in this group whichever guard it gets (`Poi.group` keeps
   * `guard`), so the row's POI count and units reconcile as before; only the
   * guard a player rolls against changes. Andrei, 2026-09-30: "make it so the
   * forest POI are assigned randomly either magic or combat guards".
   */
  readonly magicGuardChance?: number;
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
   *
   * Calibrated once step 1 existed to actually run: the default started at
   * 0.85, which was a guess made before there was a sampler, and yields ~220
   * nodes against `MAP_NODE_COUNT`'s 240. 0.815 centres the yield on 240,
   * measured over seeds. Poisson-disc sampling is a *distribution*, so a map
   * lands a few nodes either side; §2's "~240" is what that approximates.
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
