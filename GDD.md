# Game Design Document — Multiplayer Turn-Based Adventure Game

Status: v1 design, consolidated from `Annotated_Design_Document.md` (the traceability record — original text plus every clarification, in full, with typo/naming history preserved). This file is the clean version for implementation: typo corrections, superseded terminology, and clarifications that only confirmed an already-obvious reading have been left out. **Every statement is still tagged with its provenance** — `[SOURCE §x]`, `[SOURCE §x, chat]`, `[SOURCE §x, review]`, `[INFERRED]`, or `[OPEN]` — so nothing here is invented. `[SOURCE §x, review]` is a decision the designer made reviewing a pull request, superseding or extending what §x said; the superseded text is kept alongside it, tagged as it was. `[OPEN]` items are genuinely undecided; do not fill them in. See §12 before writing code that touches those areas.

---

## 1. Overview

[SOURCE §intro] A multiplayer turn-based adventure game, supporting AI players alongside humans, playable online or via a hotseat mode (§7.2).

[SOURCE §2] There is no hidden information: the entire map, all POIs, and all rewards are visible to every player at all times.

[SOURCE §2] The goal of the game is to collect gold. A player wins once their gold lead over every other player exceeds the amount of gold still unclaimed on the map [SOURCE §2, chat: evaluated each time a POI with gold is claimed]; a tie for the win results in shared victory.

---

## 2. Map Generation

[SOURCE §1] The map is a planar graph, ~240 nodes and ~300 edges, rendered as small ovals connected by road/path-styled edges, in isometric view [SOURCE §6].

[SOURCE §1] The map is divided into three terrain types — plains (light brown), forests (green), mountains (grey) — each with matching eye-candy dressing (mountains, trees, grass texture, bushes, rocks) and matching node color.

[SOURCE §1] Terrain regions are generally rounded (low perimeter-to-area ratio), except plains, which may extend long single-node-wide "valleys" into forest or mountain territory.

[SOURCE §1.3, chat] The map's coordinate space has no required real-world scale — players always view it zoomed in. Use any convenient large coordinate space (e.g. 1,000,000 units) and set the initial camera zoom so the whole map is visible on screen at game start.

### 2.1 Generation pipeline

[SOURCE §1.3] Steps run in this exact order, every one drawing from a single seeded PRNG so a map is fully reproducible from `(seed, params)` — needed for debugging, replays, and the balancing harness:

1. **Sample positions** — Poisson-disc sampling over the map rectangle, ~240 points.
2. **Triangulate** — Delaunay triangulation over the points (planar by construction; planarity never needs re-checking).
3. **Prune to budget** — remove edges longest-first, with jitter, down to 300 edges; reject any removal that disconnects the graph or pushes leaf count outside 30–45.
4. **Seed terrain regions** — 1 or 2 seeds per terrain (plains, forest, mountain); grow by flood fill biased toward nodes with more same-terrain neighbours, until area shares are approximately 45% plains / 30% forest / 25% mountain.
5. **Smooth** — flip isolated nodes to their majority-neighbour terrain until `compactness = boundary² / area` falls below `COMPACTNESS_MAX` [SOURCE §1.3, chat: circle reference = 4π ≈ 13; `COMPACTNESS_MAX` starts at 25].
6. **Carve valleys** — convert 2–4 narrow (1-node-wide) fingers of 5–12 nodes from the plains boundary into neighbouring regions; these nodes are exempted from the Smooth step (there is only the one Smooth pass, above — Carve Valleys runs once, after it).
7. **Place POIs** — node selection and reward assignment; see §3 and §4.
8. **Validate** — reject and regenerate the whole map if: disconnected, or leaf count outside 30–45.

> [SOURCE §2.1, review] **The area shares in step 4 are a property of the finished map, not of the draft step 4 hands on.** Carve Valleys converts nodes out of forest and mountain into plains, so measuring the shares before it runs lets the finished map drift a long way from 45 / 30 / 25 — over 40 seeds the finished mountain share ran from 6.4% to 31.0%, and one seed finished 65 / 26 / 9. Step 6 therefore ends by growing whatever terrain is now short back into plains, leaving the carved fingers and the plains node each one opens from untouched. The same growth also finishes step 4, whose flood fill cannot reach the shares on its own: a region on a graph this sparse is routinely sealed off, every neighbouring node already claimed, while it is still far short. Because §4.2 fixes the POI count per terrain, a terrain that loses nodes also crowds its POIs — the skew that made this visible had two thirds of every mountain node carrying a POI.

> [SOURCE §1.3, chat] Compactness is *not* re-checked at the Validate step: Carve Valleys deliberately reduces compactness along the plains boundary immediately before this step runs, so re-checking it here would fail generation almost every time. Compactness is already enforced inside the Smooth step itself (step 5 loops until it's satisfied).

---

## 3. Points of Interest (POIs)

[SOURCE §1] Some nodes are POIs. A POI has: a reward (§4), optionally a guard (§4.4), and an eye-candy image of the place or — if guarded — of the guardian, with a red (fighting) or purple (magic) contour.

[SOURCE §1] POI placement: distributed randomly at approximately equal distances from each other; every leaf node of the graph must be a POI (no dead ends); leaf nodes are assigned POI status first, remaining POIs distributed randomly among the rest.

[SOURCE §1] POI counts: **25 on plains, 20 in forests, 15 in mountains** (total 60).

[SOURCE §1.1, chat] **A POI's reward is always exactly one kind** — reward kinds (§4.1) are never mixed on the same POI. A POI can still hold multiple *units* of its one kind (a stack, e.g. "plains movement +3").

---

## 4. Rewards

### 4.1 Reward kinds and icons

[SOURCE §1] Seven reward kinds, one icon each:

| Reward | Icon |
|---|---|
| Plains moving skill | brown wagon wheel |
| Forest moving skill | green foot |
| Mountain moving skill | black mountain |
| Fighting skill | red crossed swords |
| Magic skill | purple 4-pointed star |
| Gold | yellow gold coin |
| Stamina | white heart |

[SOURCE §1] A stack of N same-kind units on one POI shows N (possibly overlapping) icons.

[INFERRED §6] The seven icon image assets Andrei supplied match this table with no discrepancies.

### 4.2 Reward totals per terrain

Three things per kind, all needed by the assignment algorithm in §4.3: the total reward **units** of that kind on the terrain, how many **POIs** on that terrain are dedicated to that kind (these must sum to the terrain's total POI count, since every POI gets exactly one kind, §3), and — for gold specifically — its **guard type**. Where a terrain's gold has more than one guard type (mountain only), the POI-count and unit-total are further split per guard type, since each guard type is effectively its own sub-kind for the §4.3 algorithm.

[SOURCE §1.1] / [SOURCE §1.1, chat]

| Terrain | Kind | Guard | Total units | POIs of this kind |
|---|---|---|---|---|
| Plains (25 POIs) | Plains moving skill | none | 20 | 10 |
| | Forest moving skill | none | 15 | 7 |
| | Magic skill | none | 10 | 6 |
| | Gold (informally "cities") | fighting | 10 | 2 |
| Forest (20 POIs) | Mountain moving skill | none | 15 | 8 |
| | Fighting skill | none | 15 | 8 |
| | Gold | fighting | 5 | 4 |
| Mountain (15 POIs) | Gold | fighting | 20 | 10 |
| | Gold | magic | 10 | 5 |

### 4.3 Reward assignment algorithm

[SOURCE §1.3, chat] Run per terrain, per row of the §4.2 table (i.e. per kind, or per kind+guard-type where gold is split by guard type):

1. **Assign kind (and, for gold, guard type) to POIs.** Partition the terrain's POIs into groups sized by the "POIs of this kind" column (e.g. on plains: 10 POIs → plains-movement, 7 → forest-movement, 6 → magic, 2 → gold/fighting-guarded; all 25 plains POIs accounted for, no overlap. On mountain: 10 POIs → gold/fighting-guarded, 5 → gold/magic-guarded).
2. **Give every POI 1 guaranteed unit** of its assigned kind.
3. **Distribute the remaining units** of that row's total (total units − POIs of this kind, from §4.2) one at a time, to a randomly chosen POI within the same group, weighted so each POI's chance is inversely proportional to `(its current count of this type − (remoteness − 1) × REMOTENESS_WEIGHT_FOR_DISTRIBUTION)`. Default `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` = **2** (distinct from `REMOTENESS_WEIGHT` in §5.2) — intentionally: weight decreases as a POI's own count grows, and increases the more remote the POI is, so extra units gravitate toward remote, lightly-stacked POIs.

Since remoteness ∈ [0,1], `(remoteness − 1) ∈ [−1, 0]`, so this denominator is always `current_count + (1 − remoteness) × REMOTENESS_WEIGHT_FOR_DISTRIBUTION` — current_count (≥1, from the guaranteed baseline) plus a non-negative term. It's always ≥ 1, for any non-negative value of `REMOTENESS_WEIGHT_FOR_DISTRIBUTION`, so the earlier non-positive-denominator problem no longer applies at all, regardless of how that constant is tuned later.

### 4.4 Guards

[SOURCE §1] A reward may (not must) be guarded: shown as a red number (fighting-gated) or purple number (magic-gated) beside the node, indicating guard strength, range **2–10**.

[SOURCE §1.1, chat] In v1, only gold rewards are guarded — every gold POI on every terrain is guarded, none are exempt. Guard type by terrain (per §4.2): plains' 2 gold POIs and forest's 4 gold POIs are all fighting-guarded; mountain's 15 gold POIs split 10 fighting-guarded / 5 magic-guarded. The engine should not hard-code "gold only" — guarding should work on any reward kind — this is a v1 content choice, not an engine constraint.

### 4.5 Consumption

[SOURCE §2] A POI's reward is consumed once claimed; the node then behaves like an ordinary node of its terrain type.

---

## 5. Balancing

[SOURCE §1.2] Reward difficulty balances guard strength against remoteness.

### 5.1 Remoteness

[SOURCE §1.2] Computed via simulated random walks: start at a random plains position, repeatedly move to one of the `CLOSE_CANDIDATE_COUNT` closest unvisited POIs (chosen at random among them), until every POI has been visited once per walk. Distance for "closest" and for walk-segment lengths uses the same weighted terrain cost as movement: 1 plains / 2 forest / 3 mountain per step [SOURCE §1.2, chat: the one distance metric used throughout the design — also for the UI's shortest-path display, §7, and the AI's own POI targeting, §9]. Run `REMOTENESS_SIMULATION_RUNS` walks, normalize the resulting per-POI scores to **[0, 1]**.

[SOURCE §1.2, chat] `CLOSE_CANDIDATE_COUNT` = **10**, raised from 5 once §9's MCTS tree began pruning to this same constant: "we don't want to risk pruning out good moves early on". Note it now sets the search's branching factor as well as this walk's candidate set, so it is no longer a remoteness-only knob — changing it moves generated maps and AI play together. `REMOTENESS_SIMULATION_RUNS` = **100** (expected to change if 100 proves too imprecise or too slow). This random-walk code is shared with the AI player's MCTS rollout policy (§9).

### 5.2 Guard-strength / remoteness formula

[SOURCE §1.2, chat] `guard_strength + remoteness × REMOTENESS_WEIGHT ∝ reward`, where `reward` is the gold amount being protected (v1 guards gold only, §4.4).

`REMOTENESS_WEIGHT` starting value: **4** (anchor: 1 gold unguarded at max mountain remoteness ≈1, vs. guard 4 on plains at min remoteness ≈0 — both config values, tuned later by play-testing).

---

## 6. Player Stats & Setup

[SOURCE §2] Per-player stats, uncapped: stamina, plains/forest/mountain moving skill levels, fighting skill, magic skill, gold. Displayed for every player to see, next to name and avatar.

[SOURCE §2, chat] Player count: **2–5** (config, not a hard limit). Turn order fixed at game start, never changes thereafter (order determined by whatever is most convenient to implement — expected default: order the game master accepts join requests, §6.1).

[SOURCE §2, chat] Starting stamina by seat: `STARTING_STAMINA_BASE` (default 30) + (seat − 1) × `STARTING_STAMINA_INCREMENT` (default 10).

### 6.1 Setup flow

[SOURCE §3] A setup screen lets the game master choose player count, lets other players join, and lets the game master accept or reject them. Each player picks a name and avatar.

[SOURCE §3, chat] The game master is the person who created the game on the game's web portal. This role cannot be transferred to anyone else in v1.

[SOURCE §3] Logged-in users see a list of in-progress games and can join one or start a new one.

[SOURCE §3, chat] v1 authentication: username + password. **Architecture requirement:** design the auth layer so stronger security can be swapped in later without a rewrite.

[INFERRED §3] Hosting/infrastructure is explicitly left open. See §12.

---

## 7. Turn Structure & Movement

[SOURCE §2] A turn is: move, then (if the turn ends on a POI) interact automatically; or rest instead (gain `REST_STAMINA_GAIN` stamina, default 5, config — no movement/interaction).

[SOURCE §2] Movement allowance: a moving skill of level N lets a player step onto N nodes of that terrain type per turn for free; the allowance refreshes every turn and each terrain has its own independent allowance. Beyond the free allowance, stamina is spent: 1 (plains) / 2 (forest) / 3 (mountain) per node.

### 7.1 Online UI

[SOURCE §4] Click-drag to pan, `+`/`-` to zoom. Clicking the player's own highlighted character enters moving mode; clicking a destination node highlights the shortest path (weighted terrain cost, §5.1) with a thick dotted line and an isometric cross at the destination. Shift-click sets an intermediate waypoint when more than one path exists.

[SOURCE §4] Path coloring: green = covered by current skill allowance, yellow = costs stamina (labeled with the stamina cost, e.g. "-3"), grey = unreachable, including the destination cross if unreachable. [SOURCE §4, chat] Coloring reflects only what's achievable *this turn*; it recalculates each new turn as skill allowances refresh — grey never means permanently impossible, since resting always restores stamina.

[SOURCE §4] "End Turn" commits the last-shown path; the character walks to the destination or as far as it gets this turn. Players may plan their next move out of turn while others play; clicking "End Turn" then executes it in one click. An unfinished path is saved for the next turn and can still be changed.

[SOURCE §4] A message board lets human players post messages visible to everyone. [OPEN] Its persistence/scope (per-game vs. cross-game, retention) is not specified.

### 7.2 Hotseat mode

[SOURCE §intro, chat] The same computer sequentially shows the game controls for all hotseat participants in turn order. The current player's name and avatar are prominently displayed, and their character is highlighted on the map. Unlike online play, there is **no out-of-turn planning** in hotseat mode — the §7.1 "plan your move while others play" feature does not apply.

### 7.3 Game master controls

[SOURCE §4] If a player takes too long, the game master can force their currently-planned move (or force a rest, if none was planned). [SOURCE §4, chat] No fixed time threshold — entirely at the game master's discretion.

[SOURCE §4] A human player may resign at any time; an AI takes over so play continues. The game master may switch any player between human and AI control at will. [SOURCE §4, chat] Only the game master can hand control back to a human after a resignation — not self-service by the player.

---

## 8. POI Interaction & Combat Resolution

[SOURCE §2] On arrival at a POI, interaction is automatic. If unguarded, the reward is simply taken. If guarded: roll 1d6; if `roll + relevant skill (fighting or magic, matching the guard's color) > guard_strength`, the reward is taken; otherwise the reward stays on the node and the roll has no other cost. Either outcome ends the turn.

[SOURCE §2, chat] Any player may attempt a guarded POI on their turn — not only the one who first failed. A player may leave and return later, or remain stationed on the node. Multiple players may occupy the same node simultaneously, without restriction.

[SOURCE §2] Worked example: stamina 14, plains-move 3, forest-move 1, mountain-move 0, fighting 2, standing on a plains node. Moves 3 plains nodes free, a 4th plains node costs 1 stamina (13 left), then 1 forest node free. Stops on a POI guarded at strength 5 (red). Rolls a 4, +2 fighting = 6 > 5: reward taken, turn ends.

---

## 9. AI Players

[SOURCE §5] Implemented via MCTS.

[SOURCE §5, chat] Rollout/simulation policy: choose a random target among the `CLOSE_CANDIDATE_COUNT` closest POIs, using the same weighted-terrain-cost random-walk code as §5.1.

[SOURCE §5, review] Backpropagated value: there are **three kinds of node evaluation**, and the tree-node evaluation function must be easily swappable between them.

| Evaluation | What it reads | Value |
|---|---|---|
| **Simulated** | the rolled-out state | "We simulate random moves until all gold is exhausted" (§9's rollout policy above), then take the simulated player's gold. |
| **Estimated** | the node being evaluated | Current gold plus current skills, with no rollout at all, weighted by how far the game has run. |
| **Hybrid** | both | The average of the estimated value and the simulated one. |

[SOURCE §5, review] **v1 uses the simulated evaluation**; estimated and hybrid are there to experiment with afterwards.

[SOURCE §5, review] The estimate's weight between gold and skills is not a tuned constant — it moves with the game, because "skills are important at the beginning of the game, and are worthless at the end":

```
value = gold/total_gold × progress + skills/total_skills × (1 − progress)
        progress = gold claimed by all players / total_gold
```

At the opening almost no gold is claimed, so `progress` ≈ 0 and the skill term carries the value; by the end `progress` ≈ 1 and only gold counts. `skills` is the **sum of the player's skill levels** [SOURCE §5, chat], not a count of the skills they hold.

> This supersedes the earlier form of the experiment, `average(gold after simulation, gold now + (number of skills) × balancing_constant, at the node being evaluated)` [SOURCE §5, chat]. Its two halves became the hybrid and the estimated evaluation respectively, and `balancing_constant` is gone — what it tuned by hand is now `progress`, which the game state supplies.

[SOURCE §5, chat] Time budget per AI move: starting value **10 seconds**.

> [OPEN] The tree/selection policy (e.g. the exploration-vs-exploitation formula) is unspecified. See §12.

---

## 10. Required Art Assets

[SOURCE §6]
- 7 reward icons (table in §4.1)
- Eye-candy symbols per terrain type (trees, mountains, etc.), isometric
- Terrain textures (all 3 types) + road/path brush pattern
- Per-POI images (huts, mills, wells, etc.) + guardian images for protected POIs (creatures, warriors, mages), isometric
- Character figurine images to choose from at setup
- Die-roll animation
- Visual elements for showing a prospective move (path highlight, cross, waypoint marker)

[SOURCE §6] Rendering: isometric view throughout; non-interactive dressing (eye candy) are billboard sprites pasted onto the map by the engine.

---

## 11. Configuration Parameters

Every constant below must live in a config file/module, not be hard-coded.

| Parameter | Default | Status |
|---|---|---|
| `MAP_NODE_COUNT` | ~240 | fixed target |
| `MAP_EDGE_COUNT` | ~300 | fixed target |
| `MAP_COORDINATE_SPACE` | e.g. 1,000,000 units | arbitrary, implementer's choice |
| `LEAF_COUNT_MIN` / `MAX` | 30 / 45 | fixed |
| `TERRAIN_AREA_SHARE` (plains/forest/mountain) | 45% / 30% / 25% | approximate target, measured on the finished map [SOURCE §2.1, review] |
| `COMPACTNESS_MAX` | 25 | tunable (play-test) |
| `VALLEY_COUNT` | 2–4 | fixed |
| `VALLEY_WIDTH` | 1 node | fixed |
| `VALLEY_LENGTH` | 5–12 nodes | fixed |
| `POI_COUNT` (plains/forest/mountain) | 25 / 20 / 15 | fixed target |
| `GUARD_STRENGTH_MIN` / `MAX` | 2 / 10 | fixed (revisit later) |
| `REMOTENESS_WEIGHT` | 4 | tunable (play-test) — guard/remoteness balance, §5.2 |
| `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` | 2 | tunable (play-test) — reward stacking, §4.3 |
| `CLOSE_CANDIDATE_COUNT` | 10 | tunable — one K for §5.1's walk, §9's rollout and §9's tree |
| `REMOTENESS_SIMULATION_RUNS` | 100 | tunable |
| `STAMINA_COST` (plains/forest/mountain) | 1 / 2 / 3 | fixed |
| `REST_STAMINA_GAIN` | 5 | tunable |
| `STARTING_STAMINA_BASE` | 30 | tunable |
| `STARTING_STAMINA_INCREMENT` | 10 | tunable |
| `PLAYER_COUNT_MIN` / `MAX` | 2 / 5 | tunable, not a hard limit |
| `GUARD_DIE` | d6 | fixed |
| `MCTS_TIME_BUDGET_PER_MOVE` | 10 seconds | tunable |
| MCTS tree/selection policy, exploration constant | — | **OPEN**, unspecified |

---

## 12. Open Items

Genuinely undecided. Do not invent values for these — either design around them as clearly-marked, swappable/config placeholders, or stop and ask, per the implementation prompt's instructions.

1. **Hosting / infrastructure** — the design leaves this open ("Cloudflare's Durable Objects sounds like a good candidate, but there may be others").
2. **MCTS tree/selection policy** — nothing beyond the rollout policy and the default evaluation function (§9) has been specified.
3. **Message board persistence and scope** (per-game vs. cross-game, retention) — not addressed.
4. **What happens if the game master disconnects or is otherwise unavailable mid-game** — the role cannot be transferred (§6.1), and no fallback for GM absence is described.
