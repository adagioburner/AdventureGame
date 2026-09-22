# Architecture — first pass

Scope: component breakdown, boundaries and data models. No gameplay logic, no
map-generation algorithms, no MCTS implementation. Everything typechecks
(`npm run typecheck`); unimplemented seams throw `NotImplementedError` carrying
the GDD section to implement against.

Every open item is registered in [`OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md).
Tech-stack recommendation, including a verdict on Durable Objects, is in
[`STACK.md`](./STACK.md).

---

## 1. Dependency layering

```
          ┌───────────┐
          │  config   │  GDD §11 + §4.2 content + engineering knobs.
          └─────┬─────┘  No dependencies. Nothing else may inline a constant.
                │
          ┌─────▼─────┐
          │   core    │  Types + rules engine. Pure: no I/O, no clock,
          └─────┬─────┘  no Math.random. Runs identically in browser,
                │        server, MCTS rollout and balancing harness.
       ┌────────┼────────┐
  ┌────▼───┐ ┌──▼───┐ ┌──▼───────┐
  │ mapgen │ │ sim  │ │ protocol │   sim = the ONE random-walk impl (§5.1+§9)
  └────┬───┘ └──┬───┘ └──┬───────┘
       │        │        │
       │    ┌───▼──┐     │
       │    │  ai  │     │  MCTS. Tree policy is an interface only (§12.2).
       │    └───┬──┘     │
       └────────┼────────┘
           ┌────▼──────┐
           │  session  │  Sequencing + authority. Eight ports, zero runtime deps.
           └────┬──────┘
    ┌───────────┼───────────┬──────────────┐
┌───▼────┐  ┌───▼────┐  ┌───▼──────────┐
│  web   │  │ server │  │ tools/balance│
└────────┘  └────────┘  └──────────────┘
```

Two rules hold the shape together:

1. **Rules live in exactly one place.** `@adventure/core` owns movement cost,
   allowance accounting, POI interaction, turn order and the win condition. The
   server imports it to resolve moves, the client imports it to draw the path
   preview, MCTS imports it to expand nodes, the harness imports it to self-play.
   A client/server disagreement about what a move costs is therefore a bug, not
   a design allowance — which matters because §7.1's path colouring is exactly
   the server's stamina accounting rendered in green and yellow.
2. **Randomness and time are always injected.** No `Math.random`, no
   `Date.now()` below `apps/`. §1.3 requires a map to be reproducible from
   `(seed, params)`; the same discipline is what makes MCTS and the balancing
   harness testable.

---

## 2. Config module (§11)

`packages/config` — three deliberately separated objects under one `Ruleset`:

| Object | Contents | Rule |
|---|---|---|
| `GameConfig` | Every row of §11's table, under the GDD's own `SCREAMING_SNAKE` names | Exactly §11, nothing more |
| `GameContent` | §4.2's reward table | Design content, keyed by `(terrain, kind, guard)` |
| `EngineeringConfig` | `MAX_GENERATION_ATTEMPTS`, `POISSON_RADIUS_FACTOR`, and a `pending` block | Never merged into `GameConfig`, so "what the designer specified" and "what the implementation added" can't be confused |

Ranges that appear as `MIN`/`MAX` pairs in §11 are single `IntRange` values
(`LEAF_COUNT`, `VALLEY_COUNT`, `VALLEY_LENGTH`, `GUARD_STRENGTH`,
`PLAYER_COUNT`), and per-terrain rows are `PerTerrain<T>`
(`TERRAIN_AREA_SHARE`, `POI_COUNT`, `STAMINA_COST`).

Several §11 rows are marked "tunable" or "starting value". They are treated as
**values you intend to tune, not placeholders**: `REMOTENESS_WEIGHT = 4`,
`COMPACTNESS_MAX = 25`, `REMOTENESS_WEIGHT_FOR_DISTRIBUTION = 2`,
`REMOTENESS_SIMULATION_RUNS = 100` and the rest are transcribed as-is, and
nothing derives, rounds or "improves" them.

Two things the config module does structurally:

- **Formulas over values.** Starting stamina is
  `startingStaminaForSeat(seat) = STARTING_STAMINA_BASE + (seat−1) × STARTING_STAMINA_INCREMENT`,
  not a five-entry table — so raising `PLAYER_COUNT.max` above 5 needs no new
  design input. Same reasoning applies wherever §11 expresses a per-seat or
  per-terrain quantity as a rule rather than a list.
- **Undecided ≠ defaulted.** `pending.*` entries are `PendingValue<T>` with
  `value: null`. `resolvePending()` throws `UnresolvedDesignError` with the GDD
  reference. A build that needs an unmade decision fails loudly.

`validateRuleset()` enforces the invariants the algorithms rely on: §4.2's POI
counts sum to `POI_COUNT[terrain]`; every row has `totalUnits ≥ poiCount` (§4.3
step 2 needs one guaranteed unit per POI); `TERRAIN_AREA_SHARE` sums to 1; no
`(kind, guard)` key repeats within a terrain.

---

## 3. Map generator (§2, §2.1)

`packages/mapgen`. The pipeline is an ordered array of eight `GenerationStep`s —
the array *is* §2.1's "exact order", and steps are never reordered or skipped
conditionally.

```
1-sample  →  2-triangulate  →  3-prune  →  4-seed-terrain
          →  5-smooth  →  6-carve-valleys  →  7-place-pois  →  8-validate
```

Each step mutates one `MapDraft` or throws `GenerationRejected`. `generateMap()`
catches rejections and retries, up to `MAX_GENERATION_ATTEMPTS`.

**One PRNG, threaded through every step *and* every retry.** §1.3 asks for "a
single seeded PRNG"; the `Rng` is created once per `generateMap` call, so a
rejected attempt advances the stream rather than replaying it, and the whole
generation — retries included — remains an exact function of `(seed, ruleset)`.

Four details from the GDD that are easy to get wrong, and are pinned in code:

- **Validate (step 8) checks exactly two things** — disconnected, and leaf count
  outside `LEAF_COUNT`. It does **not** re-check compactness: step 6 has just
  lowered it on purpose along the plains boundary, so re-testing would reject
  nearly every map. The step's doc comment says "do not tighten this step".
- **Compactness is enforced only inside step 5**, which loops until it is
  satisfied. [SOURCE §2.1 step 5, chat] `area` counts a region's nodes and
  `boundary` counts those touching another terrain — the convention that
  reproduces the 4π circle reference, and [SOURCE §2.1 step 5, chat] it is
  measured **per connected component** — `meetsCompactnessTarget()` is the
  loop's exit test. Two properties fall out: a rounded blob scores ~13 whatever
  its size, and a thin or small component scores exactly its node count, so
  `COMPACTNESS_MAX = 25` means "thin regions up to 24 nodes are tolerated".
- **Step 3's rejection is per-removal, not per-attempt.** A removal that
  disconnects the graph or pushes leaf count out of range is skipped and pruning
  continues. That is a different mechanism from step 8's whole-map rejection.
  The "jitter" is `EDGE_PRUNE_JITTER` = 10: each removal draws uniformly among
  the 10 longest edges still present, rather than taking the single longest.
- **Planarity is never re-checked.** Guaranteed by Delaunay at step 2, and no
  later step adds an edge — so there is no planarity predicate in the repo.
- **Valley nodes are recorded even though the exemption is vacuous.** §2.1 says
  carved nodes are exempt from Smooth, and with one Smooth pass at step 5 and
  Carve Valleys once at step 6, ordering already guarantees it.
  `draft.valleyNodes` is kept anyway so the exemption stays enforceable if a
  pass is ever added, and so the harness can tell carved plains from grown plains.

Step 7 is the one composite step, and its internal order is forced by data flow
(`[INFERRED §1.3/§4.3]`): select POI nodes → compute remoteness → assign kinds
and units → assign guard strengths. Remoteness can run there because it depends
only on POI *positions*, never on their rewards.

Two things settled about placement. "Approximately equal distances" (§3) is a
goal, not a procedure, and [SOURCE §3, chat] the answer was to prototype both
farthest-point sampling and graph-space Poisson-disc and compare them in the
harness — so `PoiPlacementStrategy` stays a seam with two implementations to
build. [SOURCE chat, review] That is now narrowed: "use farthest point
sampling, we'll switch if that looks bad, which I doubt", so only
farthest-point sampling gets written and the seam stays for the switch. See
[Q23](./OPEN_QUESTIONS.md#q23).

And a terrain can hold more leaves than its `POI_COUNT` quota, since leaf
count is not apportioned by terrain; [SOURCE §9, chat] the surplus leaves become
*additional* POIs carrying `stamina`. That means total POI count is no longer
fixed at 60, it gives §4.1's otherwise-unplaced `stamina` kind a home, and it
removed the `poi_quota_unsatisfiable` rejection entirely.

---

## 4. POI / reward data model (§3, §4)

The constraint that shapes everything here: **one reward kind per POI, never
mixed** (§3). That is enforced structurally.

```ts
interface Reward { readonly kind: RewardKind; readonly units: number }
interface Poi    { readonly reward: Reward; readonly guard: Guard | null; ... }
```

A `Reward` is a single `{kind, units}` pair. There is no array of rewards, no
map keyed by kind, and no union-of-rewards type anywhere in the codebase — **a
mixed reward is not expressible**, so nobody can create one by accident and
there is no invariant left to forget. Stacks are `units > 1` of the one kind,
matching §4.1's "N (possibly overlapping) icons".

`Guard` is independent of `Reward`:

```ts
interface Guard { readonly type: GuardType; readonly strength: number }
```

Nothing in the engine inspects `reward.kind` to decide whether a guard is legal.
§4.4 requires guarding to work on any kind — "gold only" is a v1 *content*
choice, expressed entirely by the §4.2 table.

### Gold's guard split is a sub-partition, not a kind

`RewardKind` stays exactly §4.1's seven. The unit the §4.3 algorithm operates on
is a **reward group**, keyed by `(kind, guard)`:

```ts
interface RewardGroupSpec {
  kind: RewardKind; guard: GuardType | null;
  totalUnits: number; poiCount: number;   // one row of §4.2
}
```

Mountain contributes two rows that both carry `kind: 'gold'` and differ only by
guard type — 10 POIs / 20 units fighting-guarded, 5 POIs / 10 units
magic-guarded. Because the *group key* carries the guard, each has its own POI
count and unit total for free, with no eighth top-level kind and no special case
in the algorithm.

### Reward assignment (§4.3), per terrain, per row

1. **Partition** the terrain's POIs into groups sized by the "POIs of this kind"
   column. The groups partition the terrain's POIs exactly — no POI omitted,
   none in two groups — which is the structural form of §3's one-kind rule.
   `validateRuleset` has already checked the column sums to `POI_COUNT[terrain]`.
2. **One guaranteed unit** to every POI in the group.
3. **Distribute the remaining** `totalUnits − poiCount` units **one at a time**,
   each to a POI drawn from the same group with weight

   ```
   1 / (current_count − (remoteness − 1) × REMOTENESS_WEIGHT_FOR_DISTRIBUTION)
   ```

   Re-weighted after every single unit — that is what makes the `current_count`
   term self-damping.

`distributionWeight()` is implemented (it's fully specified) and its doc comment
records why **no floor, clamp or epsilon is needed**: since remoteness ∈ [0,1],
the denominator equals `current_count + (1 − remoteness) × W`, i.e. a value ≥ 1
(from step 2's baseline) plus a non-negative term, for any non-negative `W`.
The comment says not to add a clamp — it would mask a broken `current_count`
rather than protect anything.

Guard strengths (§5.2) are solved *after* units are final, since §4.3 fixes the
gold amount and §5.2 leaves guard strength as the unknown:

```
guard_strength = ceil(units × GOLD_WEIGHT − remoteness × REMOTENESS_WEIGHT),  capped to GUARD_STRENGTH
```

`GOLD_WEIGHT` (default 3) is a designer-added config row. The cap is 0–10, which
supersedes §11's `GUARD_STRENGTH_MIN` of 2 — a capped result of 0 means the POI
is unguarded, so §4.4's "none are exempt" no longer holds. The formula reads the
POI's reward `units` rather than testing for gold, keeping §4.4's requirement
that guarding work on any kind. See [Q2](./OPEN_QUESTIONS.md#q2) for the
formula and [Q2a](./OPEN_QUESTIONS.md#q2a) for the rounding: [SOURCE §5.2, chat]
"guard strength is rounded up", so the `ceil` above is the answer rather than a
placeholder. It is applied before the cap, which makes the cap the last word;
ceiling before or after agrees on every reachable input anyway, since the cap
bounds are integers.

---

## 5. Balancing / simulation engine (§5) — one shared component

`packages/sim`. §5.1 says the remoteness walk "is shared with the AI player's
MCTS rollout policy (§9)", so it is one implementation from the start, split by
what actually differs rather than by who calls it:

| File | Role |
|---|---|
| `candidates.ts` | **The shared kernel.** Rank eligible POIs by weighted terrain cost; pick uniformly among the `CLOSE_CANDIDATE_COUNT` closest. Both §5.1 and §9 are exactly these two operations. |
| `walk.ts` | The generic loop, plus `WalkDriver<TCursor>` — the three things that differ: which POIs are *eligible*, what *advancing* to a target means, and when the walk is *done*. [SOURCE §9, review] Not expected to survive the rollout: "we may end up sharing code for choosing the next target only". See [Q25](./OPEN_QUESTIONS.md#q25). |
| `remoteness.ts` | §5.1's driver: eligible = unvisited, advance = move straight there charging path cost, done = all POIs visited. Runs `REMOTENESS_SIMULATION_RUNS` walks from a random plains node, then min-max normalises to [0,1]. |
| `rollout.ts` | §9's driver: eligible = unclaimed POIs of any kind, advance = play real turns through `applyAction` (so allowance, stamina, guard rolls and turn boundaries all apply), done = no unclaimed gold left. |

Neither consumer contains a copy of the other's logic. If the generic loop does
give way ([Q25](./OPEN_QUESTIONS.md#q25)), `candidates.ts` and the one distance
metric are what stay shared — which is what §9 asks for. The distinction the
split makes explicit: §5.1's walk is pure geometry — turn structure, stamina and
skills play no part — while a rollout leg is a sequence of real turns. What they
share is the target chooser and the cost metric, which is what §9 asks for.

The remoteness *scorer* is still injected — the scoring rule is specified and
implemented as `segmentSumRemotenessScorer()` (a POI scores its inbound plus its
outbound **inter-POI** segment, with the first and last POI doubling the one
they have; the leg in from the random plains start is discarded) — but keeping
it behind the interface means a variant stays a one-liner. The interface carries
`beginWalk`/`endWalk`, because "first POI" and "last POI" are only meaningful
against walk boundaries. [SOURCE §9, chat] every seat is simulated by this one policy — there is no
separate opponent model, which deleted an interface — and a rollout stops **when
no unclaimed gold remains** (`goldExhaustedTermination`). That is deliberately
not "all POIs claimed": since gold is the only thing anyone wins with (§1), a
goldless state is decided, so rollouts end with skill and stamina POIs still on
the map and skip simulating a settled tail. The terminal test also stops on a
finished game, because §1's win condition can fire earlier, when a leader's lead
already exceeds what remains.

**There is one distance metric in the whole repo.** `terrainStepCost` in
`core/path.ts` (1 plains / 2 forest / 3 mountain, charged on *entering* a node,
per §8's worked example) is used by remoteness walks, the UI's shortest path,
the AI's targeting and stamina charging. No second cost function exists.

---

## 6. Turn / game-state engine (§6–§8)

`packages/core`. One writer:

```ts
applyAction(state: GameState, action: GameAction, dice: DiceSource): ActionOutcome
```

Pure, deterministic given `dice`, and the only function that produces a new
`GameState`. Session layer, AI, harness and replays all drive the game through
it — which is what lets MCTS search *real* states rather than an approximation.

Turn sequence (§7, §8): resolve movement → if the turn ends on an unclaimed POI,
interact automatically → if a gold reward was claimed, re-evaluate the win
condition → end turn, advance seat, refresh the next player's allowance.

State split for cheap cloning (MCTS copies states in a tight loop):

```ts
interface GameState {
  map: GameMap;                          // immutable, shared reference
  players: readonly PlayerState[];       // indexed by seat − 1
  turn: TurnState;                       // number, activeSeat, allowance
  poiRuntime: readonly PoiRuntimeState[];// dense, parallel to map.pois
  status: GameStatus; winners: readonly PlayerId[];
}
```

`GameMap` never changes during play, so only the small mutable part is copied.
§4.5's "reward consumed once claimed" lives in `poiRuntime`, not on the `Poi`,
which keeps the generated map a pure function of its seed and safe to cache and
replay.

Notable rule consequences already encoded:

- `PlayerStats` is `Record<RewardKind, number>` — §6's seven stats are §4.1's
  seven kinds, so claiming a reward is one addition and the lists can't drift.
  Uncapped, so no clamping anywhere.
- Movement allowance *is* the skill level, refreshed per turn, independent per
  terrain (`refreshAllowance`).
- §8's "any player may attempt a guarded POI", "may remain stationed", "multiple
  players may occupy one node" mean there is **no** per-player attempt history
  and **no** occupancy check in the engine.
- A failed guard roll has no cost, so `InteractionResolution` has no penalty field.
- Die rolls are passed in, never drawn inside the engine.

Win condition (§1) is implemented. [SOURCE §1, chat] "Players can be tied for the
win only when there is no more gold left on the map" resolves the clause that
did not compose on its own: a single leader wins when
`max − runnerUp > unclaimedGold`, and tied leaders share exactly when no gold
remains.

---

## 7. AI player (§9)

`packages/ai`. Four interfaces, so each part stays separately swappable. All
four are now decided — two by §9 directly, two by §12.2:

| Seam | Status |
|---|---|
| `RolloutPolicy` | **Specified** (§9). `closestPoiRolloutPolicy()` is a thin wrapper over `@adventure/sim`. |
| `NodeEvaluator` | **Specified default** (§9): the simulated rollout, which is what v1 runs. Three ship — simulated, estimated and hybrid; see below. |
| `TreePolicy` | **Decided** (§12.2): UCT, `MCTS_EXPLORATION_CONSTANT` = √2, most-visited child as the final move. `uctTreePolicy()`. |
| `ActionEnumerator` | **Decided** (§12.2): the `CLOSE_CANDIDATE_COUNT` (10) closest *unclaimed* POIs, recomputed per node, **plus a rest branch** when fewer than `MIN_REACHABLE_NODES_FOR_REST` (3) of them are reachable this turn. `closestUnclaimedPoiEnumerator()`. |

The enumerator is worth a second look, because it completes the sharing story:
it calls the same `closestPoiCandidates` that the remoteness walk and the
rollout policy call. Three consumers, one ranking kernel and — since the
designer collapsed the tree's own constant into it (Q19) — one K,
`CLOSE_CANDIDATE_COUNT` = 10. They differ only in what they do with the ranked
list: the tree makes every candidate a branch, the rollout picks one uniformly,
remoteness walks to its pick.

**A branch is a macro-action**, in the tree and in the rollout alike. [SOURCE §9,
chat] taking a target means "the simulated player keeps moving to the chosen POI
without making new decision until it's reached or claimed by a different
player", so one tree edge spans several turns and ends on one of three
outcomes — `arrived`, `target_claimed_by_other`, `terminal`. The same commitment
governs §5.1's remoteness walk, which already worked this way; only the
"claimed by another player" exit has no counterpart there, since that walk has
no players in it. That is what keeps the tree shallow
enough to search in ten seconds: a node is a real decision point, not a single
step. `search()` returns only the *first* turn of the chosen branch, since the
session layer commits one turn at a time.

**Values are normalised.** The invariant every evaluator holds to is the
*range*: a backpropagated value is always in [0, 1], which is what makes
`MCTS_EXPLORATION_CONSTANT` = √2 correct, since UCB1's derivation assumes it.
How each one gets there differs. [SOURCE §9, chat] gold terms divide by the
total gold placed on the map; the estimated evaluator's skill term divides by
the total skill units placed, and its two terms are combined by weights summing
to 1. The two settings are coupled; changing normalisation without revisiting
the constant breaks the exploration/exploitation balance.

[SOURCE §9, chat] "Number of skills" in that skill term is the **sum of the five
skill levels** rather than a count of skills held.

One signature detail worth flagging, because it is the kind of thing that is
expensive to change later:

```ts
evaluate(node: MctsNode, rolledOut: RolloutCursor, subject: PlayerId): number
```

The evaluator receives **both** the rolled-out result and the node being
evaluated, which is what lets all three kinds of evaluation sit behind one
interface. [SOURCE §9, review] The three, and what each looks at
(see [Q18](./OPEN_QUESTIONS.md#q18)):

| Evaluation | Reads | |
|---|---|---|
| **Simulated** | the rolled-out state | §9's specified default: play random moves until the gold is exhausted, take the subject's gold. `simulatedRolloutEvaluator()`. |
| **Estimated** | the node | What the subject holds now, gold against skills. No rollout. `estimatedGoldAndSkillsEvaluator()`. |
| **Hybrid** | both | The average of the two. `hybridGoldAndSkillsEvaluator()`. |

The estimate is where the designer's formula lives. Its weight between gold and
skills is not a tuned constant — it moves with the game, because "skills are
important at the beginning of the game, and are worthless at the end":

```
value = gold/total_gold × progress + skills/total_skills × (1 − progress)
        progress = gold claimed by all players / total_gold
```

At the opening almost no gold is claimed, so `progress` ≈ 0 and the skill term
carries the value; by the end `progress` ≈ 1 and only gold counts. Every
quantity is read from the node, which is what makes `progress` meaningful here:
it moves across the tree, whereas a rollout by definition ends with no
unclaimed gold left (Q6). [Q11](./OPEN_QUESTIONS.md#q11) still decides the skill
numerator — the sum of all five skill levels, not a count of skills held.

Two properties fall out of the shape rather than out of a constant. The estimate
is in [0, 1], because both its terms are and its two weights sum to 1; the
simulated value is too; so the hybrid's average is as well, which is what
[Q14](./OPEN_QUESTIONS.md#q14) needs for UCB1's √2. And `balancingConstant` is
gone, because what it tuned by hand is `progress`.

[SOURCE §9, review] **v1 runs the simulated one**; the other two are
there to experiment with once it works, which is why `SearchOptions.evaluator`
is injected rather than defaulted.

One thing for whoever writes `search()`'s simulate phase: the estimated
evaluator never reads `rolledOut`, so a search configured with it would pay for
a rollout and throw it away. Skipping the rollout when the evaluator does not
use it is a search-level optimisation, not an evaluator change — the interface
deliberately hands over both, and only the evaluator knows which it wants.

The hybrid is **composed from the other two** rather than reimplementing either,
so a change to one cannot leave it computing something else.
`totalSkillUnits()` joins `totalGoldUnits()` in `@adventure/core` as the skill
term's divisor, and the five skill kinds are now one list (`SKILL_KINDS` in
`@adventure/config`) shared by that helper and the evaluator, so the numerator
and denominator cannot drift apart.

`search()` documents the four phases (select / expand / simulate / backprop) and
the `MCTS_TIME_BUDGET_PER_MOVE` loop, and throws: the loop itself is still to be
written (§11 item 11). Every policy it drives is decided — two phases by §9, two
by §12.2 — which is precisely why they sit behind their own interfaces instead
of inside the function.

The session layer sees only:

```ts
interface AiPlayer {
  chooseAction(state, subject, cancel?): Promise<TurnAction>;
}
```

Async and behind a port, because 10 seconds of CPU per move must not run in a
request handler or on the UI thread — the same code works whether the search
runs in a Web Worker, a worker thread, or a separate service. That is also the
single biggest constraint on the hosting decision; see `STACK.md`.

---

## 8. Multiplayer / session layer (§6.1, §7.3)

`packages/session`. Decoupled from hosting by construction: it imports **no**
transport, storage engine, socket, or timer. Everything arrives through
`SessionPorts` — now six: `GameStore`, `Broadcaster`, `Clock`, `MapService`,
`AiService`, `DiceService`.

§12's answers removed two of the original eight. `MessageBoardStore` is gone
because the board is game state (§12.3), so `GameStore` already persists it.
`GameMasterAbsencePolicy` is gone because §12.4 decided there is no fallback to
configure: a GM-only request with no game master connected is answered
`game_master_unavailable` and the game waits.

`MapService` and `AiService` survive as interfaces but have moved house.
[SOURCE §12.1, chat] map generation and the MCTS search run on the **game
master's machine**, so the Durable Object adapter implements both as round trips
to the GM's client. The session core never learns this — which is what the ports
were for.

That composition has a consequence stronger than §12.4 states on its own: with
AI on the GM's machine, a disconnected game master blocks not just forced turns
but every AI turn and map creation, so even an all-AI game cannot advance.

`GameSession` is single-writer per `gameId`: every message for a game is handled
in order, so the authoritative state never needs locking. That shape is the main
thing a host has to supply (a Durable Object gives it per-object; a Node process
gives it with an in-process queue keyed by `gameId`) and `GameSession` is
identical either way.

Its responsibilities, and only these: **authority** (is this user the game
master, is it this player's turn), **sequencing**, **driving AI turns**, and
**persistence + broadcast**. It contains no game rules.

Authority is here and nowhere else — the engine deliberately doesn't know who
the GM is. §6.1's GM is the game's creator and the role cannot be transferred in
v1, so the check is against a value fixed at creation and there is no transfer
message in the protocol at all.

`SetupFlow` implements §6.1: GM sets player count, users request to join, GM
accepts or rejects (which allocates the next seat and thereby fixes turn order,
per §6's explicit "whatever is most convenient"), each player picks name and
avatar, GM starts. All seats start on one shared node — a random plains node
holding no POI, via `chooseStartingNode`, drawn from an `Rng` derived from the
map seed so it replays with the map.

`@adventure/protocol` holds the wire contract as plain data: `ClientMessage` /
`ServerMessage` unions, lobby and setup types, `BoardPost`, and the `AuthProvider`
port. No transport, no framework. Because §1 guarantees no hidden information,
the server sends the whole `GameState` and never computes a per-player view —
the one thing not shared is the server's die stream.

Auth (§6.1) is entirely behind `AuthProvider`: `Credentials` is an open union
whose only v1 variant is `{method:'password', username, password}`, and no other
package knows what a password is. Adding WebAuthn or an IdP later is a new
variant plus an adapter, with no change to the session layer, lobby or any
message type — which is the "swappable without a rewrite" requirement.

---

## 9. Client / UI layer (§7)

`apps/web`. Boundaries only in this pass — no framework is committed to in code.

| Module | Covers |
|---|---|
| `render/isometric.ts` | `Projection` (world ↔ screen), `Camera`, `fitToViewport` for §1.3's "whole map visible at game start" |
| `render/scene.ts` | `MapRenderer` and the draw layers (terrain, dressing, edges, nodes, POIs, path overlay, characters, UI), split by how often each invalidates |
| `interaction/camera.ts` | §7.1 click-drag pan, `+`/`-` zoom |
| `interaction/moveMode.ts` | The §7.1 move-mode state machine: idle → selecting → previewing, shift-click waypoint, End Turn, Rest |
| `state/client.ts` | `ClientGameStore` and the `Transport` seam |
| `modes/` | Online vs. hotseat as a flag on one UI |

Two decisions worth stating:

- **The client computes no rules.** `previewPath` comes from `@adventure/core` —
  the same accounting the server commits — so the green/yellow/grey colouring
  and the committed move cannot disagree. §7.1's colours reflect only *this*
  turn and recalculate each turn as allowances refresh, so grey is never cached
  and never treated as a connectivity claim (resting always restores stamina).
- **Hotseat is a flag, not a second client.** §7.2 differs from §7.1 in exactly
  one behaviour — no out-of-turn planning — so `allowOutOfTurnPlanning: false`
  makes the move-mode controller refuse `enter()` for any non-active seat.
  Everything else (pan, zoom, preview, End Turn, prominent current-player name
  and avatar, character highlight) is the same UI. Duplicating the client to
  remove one feature would guarantee drift.

Art binding is **out of scope** and marked so: nothing reads `Art/`, and
`Poi.artVariant` is only a stable per-POI random index. What it indexes into —
sheet extraction, sizing, the icon-to-reward mapping — is a later decision.

---

## 10. Balancing harness

`tools/balance`. A first-class consumer, not a script: §1.3 names it as a reason
reproducibility is required. Headless, imports the same packages the server
does, touches neither session nor UI. It exists to tune the rows §11 marks
tunable — `COMPACTNESS_MAX`, `REMOTENESS_WEIGHT`,
`REMOTENESS_WEIGHT_FOR_DISTRIBUTION`, `MCTS_TIME_BUDGET_PER_MOVE`, and
especially `REMOTENESS_SIMULATION_RUNS`, which §5.1 explicitly expects to change
"if 100 proves too imprecise or too slow".

`runMapBatch` reports leaf counts, terrain shares, compactness both after Smooth
and after Carve Valleys (the latter expected to be worse, by design), remoteness
and guard-strength histograms. `runSelfPlayBatch` is blocked on §12.2.

---

## 11. What the next session can pick up

Each of these is independently implementable against the shapes above:

1. `shortestPath` + `closestPoiCandidates` (one Dijkstra, deterministic tie-break) — unblocks the UI preview, remoteness and rollouts at once.
2. Mapgen steps 1–4 and 6 — no open items.
3. `resolveMovement` / `previewPath` — §8's worked example is the test case.
4. `resolveInteraction` — §8.
5. §4.3 assignment — the weight function is already written.
6. Step 5 Smooth — the measurement and its exit test are written; the flip loop is not.
7. Step 7 placement — farthest-point sampling behind `PoiPlacementStrategy`; the
   second strategy is not wanted unless the maps disappoint
   ([Q23](./OPEN_QUESTIONS.md#q23)).
8. Remoteness — scorer is written; needs `closestPoiCandidates` (item 1) to run.
9. `SetupFlow.start` — starting positions are settled; needs the rest of setup.
10. Guard strengths — written; needs remoteness (item 8) to run.
11. MCTS `search()` — every policy, evaluator and branch rule is written; the four-phase loop and `macroAdvanceToTarget` are not.
