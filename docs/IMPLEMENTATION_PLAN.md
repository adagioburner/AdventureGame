# Implementation plan

Status: **agreed; phases 0–4 done, phase 5 next.** This plan is derived from the
five-step order Andrei proposed, checked against the design of record and
against what is actually in the repo today. Phase 0 landed the test harness,
phase 1 the map generator, phase 2 the rules engine, phase 3 the map as a
player sees it and phase 4 a hot seat game played on it; everything from
phase 5 on is still seams.

The design of record is [`GDD.md`](../GDD.md), with
[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) for component boundaries,
[`docs/RULES.md`](./RULES.md) for the rules as the code has them,
[`docs/STACK.md`](./STACK.md) for the tech-stack decisions and
[`docs/OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md) for the register. Where this
plan needs something the design does not say, it asks rather than choosing —
see [Questions](#questions) at the end. It invents no rules, no constants and
no defaults.

Andrei answered all five questions on 2026-09-22, and they are folded into the
phases below: the AI budget stays in seconds, hotseat is 2 players, POI
placement is farthest-point sampling alone, Q18's `total_skills` reading is
confirmed as the units placed on the map, and he is supplying the missing
placeholder art — the die-roll animation and the road brush are in this change,
and forest gold and the stamina POIs borrow an existing sheet meanwhile. All
five are registered as Q20–Q24 in
[`docs/OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md), since that register rather
than this plan is where the repo records a decision.

Where the repo stands: the architecture pass landed data models, component
boundaries and interfaces that typecheck, and phases 0 and 1 have turned the
first of the seams into code. The rest still throw `NotImplementedError`
carrying the GDD section to implement against, and
`grep -rn NotImplementedError packages apps tools` is the live worklist. Every
phase below is written as "turn these named seams into code", not as "design
this".

---

## 1. Verdict on the proposed order

**The order works.** Each of the five steps depends only on what the steps
before it deliver, with one exception (step 1 is not self-contained — see
below). Four changes are worth making, and two whole pieces of work are
missing from the five steps.

### 1.1 The four changes

**(a) A phase 0 is needed before step 1, because the repo has no test runner.**
Step 1 asks for "tests verifying that map generation runs successfully and
according to set parameters". There is no test framework installed, no test
file anywhere, and CI runs `pnpm run typecheck` and nothing else.
`docs/STACK.md` §3 recommends Vitest and golden-seed snapshots but no
dependency was ever added. So the first thing to land is the harness that every
later phase reports into, and a second required CI check. That is phase 0.

**(b) Step 1 cannot be "only the map generator".** Pipeline step 7 computes
remoteness between POI placement and reward assignment (§2.1 step 7, §5.1), and
§5.2's guard strengths consume remoteness. Remoteness is a random walk over
"the `CLOSE_CANDIDATE_COUNT` closest unvisited POIs", ranked by the weighted
terrain cost. So generating one complete map unavoidably requires:

- `shortestPath` in `packages/core/src/path.ts` — the single Dijkstra,
- `closestPoiCandidates` in `packages/sim/src/candidates.ts` — the shared
  ranking kernel,
- the remoteness walk in `packages/sim/src/remoteness.ts` on top of
  `walk.ts`'s loop, which is already written.

This is not scope creep, it is the dependency graph: `packages/mapgen` already
declares `@adventure/sim` as a dependency for exactly this reason. It is also
the best possible place to start, because those same three pieces unblock the
UI's path preview (§7.1) and the AI's targeting (§9) later. Phase 1 below opens
with them.

**(c) The rules engine should land headless, before any UI.** Step 2 as written
bundles two very different jobs: implementing §7 and §8 (movement allowance,
stamina, automatic interaction, guard rolls, turn order, victory) and building
an isometric client. The first is pure functions in `packages/core` with §8's
worked example as a ready-made test case; the second is pixels. Splitting them
means the rules are proven correct before a renderer can hide a bug, and it
means the UI phase is only about interaction. Phases 2 and 4 below.

**(d) AI players do not need multiplayer, and would be better built earlier.**
Step 5 puts AI last, but MCTS depends only on `core`, `sim` and `ai` — no
server, no transport, no lobby. Building it straight after the hotseat UI buys
three things immediately: self-play is far and away the most effective test of
the rules engine (a rules bug that unit tests miss shows up as a self-play game
that will not terminate); `runSelfPlayBatch` in `tools/balance` is blocked on
`search()` and is the only way to tune §11's tunable constants; and an AI
opponent in hotseat makes the game actually playable for one person, well
before any of the multiplayer work lands.

This plan therefore puts the MCTS engine in phase 5, before the server phases,
and keeps AI's *multiplayer* integration (the GM's-machine Web Worker, AI
settings UI, resign-to-AI handover, GM switching a seat between human and AI)
in phase 8 where it belongs, because that part genuinely does need the server.
Phase 5 and phases 6–7 are independent of each other, so if you would rather
keep AI last, swap them; nothing downstream changes.

### 1.2 The two missing pieces

**Art binding is not in any of the five steps, and step 2 cannot look like the
design without it.** `docs/ARCHITECTURE.md` §9 marks it out of scope on
purpose: nothing in the repo reads `Art/`, and `Poi.artVariant` is only "a
stable per-POI random index" with no decision about what it indexes into. The
sheets in `Art/` are already cut into atlases with per-sprite anchors, so the
work is small and well-defined, but it is real work and it has gaps in the
supplied assets. Phase 3 below, and question
[P1](#p1-art-gaps--answered-q20-two-assets-generated).

**Tuning the balancing constants is not in any of the five steps.** §11 marks
six parameters tunable by play-test — `COMPACTNESS_MAX`, `REMOTENESS_WEIGHT`,
`REMOTENESS_WEIGHT_FOR_DISTRIBUTION`, `CLOSE_CANDIDATE_COUNT`,
`REMOTENESS_SIMULATION_RUNS`, `MCTS_TIME_BUDGET_PER_MOVE_MS` — and
`tools/balance` exists as a first-class consumer for exactly that, with both
its entry points still stubs. The map-side half of it belongs in phase 1 (it is
how you see whether generation is "according to set parameters"); the self-play
half needs the AI, so it sits at the end of phase 5.

### 1.3 Phase map

| Phase | What lands | Andrei's step |
|---|---|---|
| [0](#phase-0--test-and-check-infrastructure) ✅ | Vitest, `pnpm test`, second CI check | new |
| [1](#phase-1--map-generation) ✅ | Distance metric, the eight pipeline steps, rewards, guards, a human-viewable map dump, the map harness | 1 |
| [2](#phase-2--rules-engine-headless) ✅ | §7/§8 movement, interaction, turn order, victory — pure, tested | part of 2 |
| [3](#phase-3--art-binding-and-the-isometric-renderer) ✅ | Atlas loader, reward-kind-to-sheet mapping, isometric projection, draw layers | new |
| [4](#phase-4--hotseat-ui) ✅ | Pan/zoom, move mode, path preview, End Turn, Rest, stats, game end | 2 |
| [5](#phase-5--ai-players-the-engine) | MCTS `search()`, rollouts, self-play harness, balancing pass | part of 5 |
| [6](#phase-6--server-foundation-auth-and-lobby) | Host decision made real, transport, auth, game list, join/accept setup | 3 |
| [7](#phase-7--online-play) | Authoritative state, broadcast, reconnect, message board, out-of-turn planning, GM controls | 4 |
| [8](#phase-8--ai-in-multiplayer) | Web Worker on the GM's machine, AI settings, resign-to-AI, human/AI switching | rest of 5 |

Phases 0–2 are strictly sequential. Phase 3 can start any time after phase 0
(it touches no game logic). Phase 5 is independent of 6–8.

---

## 2. Seeing a map

Step 1 asks for output "viewable by humans", so whatever produces it is part of
the deliverable, not something a reviewer reconstructs from the source tree.
Two things shape this section. One is §9 of `ARCHITECTURE.md`: the diagnostic
view and the player-facing view are different drawings arriving in different
phases, and §§2.1 and 2.2 below are those two views. The other is **who
reviews** — from a browser or a phone, with no clone of this repository and
nothing installed. An earlier draft of this section opened with `pnpm install`
and was wrong about that.

### 2.0 With no checkout — the reviewing path

None of this needs anything installed, and none of it needs the branch merged
first.

- **Name seeds in the thread.** "Show me five maps" is the whole interface: the
  generator is run on the branch and the plates come back as attachments, or as
  one page that pages through them with each map's §11 reading beside it. Reach
  for this first. It is the only path that answers *what does seed X look like*
  for a seed nobody has generated yet, and the only one that works before a
  phase has landed anywhere.
- **Read the committed summary.** `golden/maps/adventure.txt` renders on the
  pull request's Files tab — one record per line, every node, edge and POI of
  the golden map. It is that map as text, and it is exactly what a failing
  golden diff puts in front of a reviewer.
- **Ask for the batch numbers.** `pnpm map:batch` prints a dozen lines. A
  reviewer who wants the §11 distributions over 40 seeds should be handed them,
  not told how to produce them.

The rule behind all three: **a reviewer should never have to install a
toolchain to answer "did this do what §2.1 says".** When a question can only be
answered by running something, running it is the implementer's job, and the
answer belongs in the thread.

**With a checkout**, a contributor still has the whole loop:

```sh
pnpm install          # once
pnpm run typecheck    # three programs: packages + server, the web app, then tools
pnpm test             # vitest run
```

### 2.1 After phase 1 — the diagnostic SVG — **works now**

```sh
pnpm map adventure            # one map from the seed "adventure"
pnpm map adventure --json     # ... and the sealed GameMap beside it
pnpm map                      # a random seed, printed first so it can be reused
pnpm map:batch 50             # 50 seeds, the aggregate §11 report, no SVGs
```

`pnpm map <seed>` writes `out/maps/<seed>.svg`, prints that map's report to
stdout — node, edge and leaf counts, terrain shares, compactness both after
Smooth and after Carve Valleys, remoteness and guard-strength histograms — and
prints the SVG's absolute path as its **last** line, so it can be pasted
straight into a browser without hunting for it. `--json` writes the sealed
`GameMap` next to the SVG, which is what the phase 3 viewer can load when a
specific map needs re-examining.

`pnpm map:batch <n>` is `runMapBatch` over `n` seeds with no per-map files: the
§11 distributions only, which is the check on `COMPACTNESS_MAX`,
`REMOTENESS_WEIGHT` and their neighbours.

`out/` is already gitignored, and the SVG stays there. What gets **committed**
is the text map summary under `golden/maps/`, per `golden/README.md`'s
convention — one record per line, so a failing diff is legible in review. A
committed SVG would snapshot the same map a second time and churn on every
cosmetic change to the renderer.

**No extra runner is needed, and that is worth stating because it is not
obvious.** (Confirmed in phase 1: both scripts are one-line `node` invocations.) Every workspace package sets `"main": "src/index.ts"`, and the
codebase uses no `enum` and no `namespace`, so Node 22's built-in type
stripping runs the tools directly: `node tools/balance/src/cli.ts` resolves
`@adventure/core` and runs it with no `tsx`, no `ts-node` and no build step.
Verified on Node 22.22, which is what `.github/workflows/ci.yml` already pins.
So `map` and `map:batch` are one-line root scripts wrapping `node`, and a
reviewer needs nothing that `pnpm install` has not already put in place.

### 2.2 After phase 3 — the map as a player sees it — **works now**

**With no checkout**, the viewer comes to the thread as a published page: the
same app, built by `pnpm build:web`, posted where a phone can open it. It
generates in the browser, so any seed typed into its box draws that map there
and then. Screenshots of named seeds,
whole and zoomed in, come back as attachments the same way §2.0's plates do.
That is phase 3's answer to §2.0: nothing to run, and any seed on demand.

**With a checkout:**

```sh
pnpm dev              # Vite dev server in apps/web
pnpm build:web        # the static page, in apps/web/dist
```

then open `http://localhost:5173/?seed=adventure`. Map generation is
client-side already by [§12.1](./GDD.md), so the page generates from the seed
in the query string: no server and no file from §2.1 required. Changing the
seed is the whole loop, and a page opened with no `?seed=` picks one at random
and writes it into the URL so it can be shared.

This is the isometric view with node images, dressing, reward icons, guard
numbers and road strokes. It has no debug layer and never draws remoteness
(phase 3, item 9). When a map looks wrong here, `pnpm map <the same seed>` is
the tool that says why — same map, same seed, all the generator's internals on
show.

---

## Phase 0 — test and check infrastructure — **done**

Small, and everything after it reports into it.

1. **Install Vitest** at the workspace root (`docs/STACK.md` §3 already chose
   it) and add `"test": "vitest run"` to the root `package.json`. Keep the
   engine packages free of runtime dependencies — this is a devDependency, as
   TypeScript is.
2. **Decide where tests live.** Proposal: `*.test.ts` next to the module it
   covers, inside each package's `src/`. Same-directory tests can import via
   the relative `.ts` paths the repo already uses, so no build step and no
   second tsconfig.
3. **Add a `golden/` convention for seed snapshots.** Map generation is an
   exact function of `(seed, ruleset)`, so a committed snapshot of a generated
   map's summary is the cheapest possible regression test — and the loudest
   alarm if someone reorders a pipeline step or draws from the PRNG out of turn.
4. **Add the test job to `.github/workflows/ci.yml`** as a second job beside
   `typecheck`, and make it a required check on `main` alongside Typecheck.
5. **Decide on a linter/formatter** — not in the design, purely a contributor
   question. Proposal: skip it for now. `strict` plus `noUncheckedIndexedAccess`
   plus `exactOptionalPropertyTypes` is already doing the load-bearing work, and
   a formatter diff across every file would bury the first real
   implementation PR.

**Done when:** `pnpm test` runs, passes with one trivial test, and CI shows two
required checks.

**What actually landed.** All five, with the proposals in 2, 3 and 5 taken as
written and now recorded in [`docs/STACK.md`](./STACK.md) §3 rather than only
here. Two departures worth knowing:

- **More than one trivial test.** A harness that asserts nothing proves
  nothing, so it arrived with 59 tests over the parts of the repo that are
  already implemented — the PRNG, the graph predicates, `validateRuleset` and
  `resolvePending`, and the §5.2 guard-strength formula. None of them touch a
  `NotImplementedError` seam, so none of them pre-empt a later phase.
- **The first golden file is the PRNG stream, not a map summary**, because
  `generateMap` still throws. It is the right foundation anyway: every map
  snapshot rests on that stream, so if `golden/rng/sfc32-seed-adventure.txt`
  moves, no other golden diff means anything until that one is explained. Map
  summaries join it in phase 1.

Making the Test check **required on `main`** is a repository setting and the one
part of phase 0 that cannot land in a commit — Andrei sets it beside Typecheck
under Settings → Branches.

---

## Phase 1 — map generation — **done**

Delivers: a generated map, reproducible from `(seed, ruleset)`, viewable as a
picture, and a harness that reports whether the parameters came out as §11
asks.

### 1a. The one distance metric

- `shortestPath` (`packages/core/src/path.ts`) — Dijkstra over
  `terrainStepCost`, cost charged for *entering* a node. Ties break by lowest
  node id, deterministically, because the same request has to draw the identical
  path on two clients, on the server and in a replay. The doc comment on the
  seam already says this.
- `closestPoiCandidates` (`packages/sim/src/candidates.ts`) — one Dijkstra from
  the origin, stopped once `CLOSE_CANDIDATE_COUNT` eligible POIs are settled,
  ascending by cost, same deterministic tie-break. Three callers share it
  (`docs/RULES.md`): the remoteness walk over *unvisited* POIs, the rollout
  policy over *unclaimed* POIs, and tree expansion. Eligibility is injected;
  the ranking is written once, here.

  The two eligibility sets really are different, and the remoteness one really
  is *unvisited* (Q25): §5.1's walk runs inside map generation where nothing is
  ever claimed, and that set is also what ends the walk.

  **Expect this file to be the only thing the two walks share.** That is the
  designer's own prediction (Q25), and phase 5 below says where `walk.ts`'s
  generic loop is likely to give way.
- `routeVia` and the `PathPreview` types are already written on top of
  `shortestPath` and need nothing.

**Tests:** hand-built graphs where the weighted-cost answer differs from the
hop-count answer (so a plain BFS fails); a tie that would flip under a
different visit order; an unreachable target returning `null`; `pathCost`
agreeing with the sum of `stepCost` along the returned path.

### 1b. Pipeline steps 1–6

The pipeline array in `packages/mapgen/src/steps/index.ts` *is* §2.1's exact
order and steps are never reordered or skipped. Each of these is one file, each
throws `GenerationRejected` or mutates the draft, and all of them draw from the
one `Rng` on `GenerationContext`.

- **`1-sample`** — Poisson-disc over the map rectangle, ~`MAP_NODE_COUNT` (240)
  points in `MAP_COORDINATE_SPACE`, radius from `POISSON_RADIUS_FACTOR` (0.85).
- **`2-triangulate`** — Delaunay. Planar by construction, and no later step
  adds an edge, so there is no planarity predicate anywhere in the repo and
  none should be added. Needs a dependency decision: hand-rolled, or a small
  library (`delaunator` is the obvious one). Proposal: take the library — a
  correct incremental Delaunay is a week of subtle geometry and a hard
  dependency on nothing.
- **`3-prune`** — remove edges longest-first down to `MAP_EDGE_COUNT` (300),
  each removal drawn uniformly among the `EDGE_PRUNE_JITTER` (10) longest edges
  still present. **Rejection here is per-removal, not per-attempt:** a removal
  that disconnects the graph or pushes leaf count outside `LEAF_COUNT` (30–45)
  is skipped and pruning continues. Rebuild `adjacency` whenever `edges`
  changes.
- **`4-seed-terrain`** — 1 or 2 seeds per terrain, flood fill biased toward
  nodes with more same-terrain neighbours, until shares approach
  `TERRAIN_AREA_SHARE` (45/30/25).
- **`5-smooth`** — the flip loop. The measurement and its exit test
  (`meetsCompactnessTarget`) are already written; the loop that flips isolated
  nodes to their majority-neighbour terrain is not. Compactness is
  `boundary² / area`, measured **per connected component**, and this is the
  only step that enforces it.
- **`6-carve-valleys`** — `VALLEY_COUNT` (2–4) fingers of `VALLEY_LENGTH`
  (5–12) nodes, `VALLEY_WIDTH` 1, from the plains boundary into a neighbour.
  Record them in `draft.valleyNodes` even though the Smooth exemption is
  already satisfied by ordering — the harness needs to tell carved plains from
  grown plains.

**Tests:** per step, deterministic under a fixed seed; node and edge counts
within target; three terrains present with shares near 45/30/25; compactness
below `COMPACTNESS_MAX` at the end of step 5 and *allowed to be worse* after
step 6; a step-3 removal that would disconnect the graph being skipped rather
than aborting the attempt.

### 1c. Step 7 — POI placement, remoteness, rewards, guards

This is the one composite step, and its internal order is forced by data flow:
select POI nodes → compute remoteness → assign kinds and units → assign guard
strengths.

- **`placePoisStep`** — every leaf node is a POI first (§3, "no dead ends"),
  then the rest distributed at "approximately equal distances". §3 states that
  as a goal, not a procedure. `docs/ARCHITECTURE.md` §3 originally left
  `PoiPlacementStrategy` as a seam with both farthest-point sampling and
  graph-space Poisson-disc to build and compare; [SOURCE chat, 2026-09-22]
  Andrei settled it (Q23): "use farthest point sampling, we'll switch if that
  looks bad, which I doubt". So build **farthest-point sampling only**, and
  keep `PoiPlacementStrategy` as a seam so the switch stays a one-liner rather
  than a rewrite. 1e is where you would see it look bad.
- **`overflowLeafPois`** — a terrain can hold more leaves than its `POI_COUNT`
  quota, and the surplus leaves become *additional* POIs carrying `stamina`,
  `OVERFLOW_LEAF_STAMINA_UNITS` (1) each.
  Total POI count is therefore not fixed at 60, and there is no
  `poi_quota_unsatisfiable` rejection.
- **Remoteness** (`packages/sim/src/remoteness.ts`) —
  `REMOTENESS_SIMULATION_RUNS` (100) walks, each starting at a random plains
  node and repeatedly moving to one of the `CLOSE_CANDIDATE_COUNT` closest
  *unvisited* POIs until all are visited, then normalised to [0, 1]. The scorer
  (`segmentSumRemotenessScorer`) is written; it needs 1a to run.
- **`partitionPoisIntoGroups` / `distributeGroupUnits` / `assignRewards`** —
  §4.3, per terrain, per row of the §4.2 table, keyed by `(kind, guard)` so
  mountain's two gold rows stay distinct with no eighth reward kind. One
  guaranteed unit each, then the remainder one unit at a time, re-weighted after
  every single unit. `distributionWeight()` is already written, and its doc
  comment says why no clamp or epsilon belongs there — do not add one.
- **Guard strengths** (`packages/mapgen/src/rewards/guards.ts`) —
  `guardStrengthFor` is written and needs remoteness to run.
  `ceil(units × GOLD_WEIGHT − remoteness × REMOTENESS_WEIGHT)` capped to
  `GUARD_STRENGTH` ({min: 0, max: 10} in the config, which supersedes §11's
  `GUARD_STRENGTH_MIN` of 2). A capped result of 0 means unguarded.

**Tests:** every leaf is a POI; POI counts per terrain equal `POI_COUNT` plus
the stamina overflow; the §4.2 columns reconcile exactly — unit totals and
POI counts per `(terrain, kind, guard)` row, no POI omitted, none in two
groups, one kind per POI; remoteness strictly within [0, 1] with both ends
attained; guard strengths integral and within the cap; every gold POI guarded
and (in v1 content) nothing else.

### 1d. Step 8, sealing, and the human-viewable dump

- **`8-validate`** — exactly two checks, disconnected and leaf count outside
  `LEAF_COUNT`. It must **not** re-check compactness: step 6 has just lowered
  it on purpose, so re-testing would reject nearly every map. The step's doc
  comment says not to tighten it.
- **`generateMap`** catches `GenerationRejected` and retries up to
  `MAX_GENERATION_ATTEMPTS` (50), with the one `Rng` shared across retries so a
  rejected attempt *advances* the stream rather than replaying it.
- **The map dump.** Step 1 asks for output "viewable by humans (pdf, svg or
  similar)". Proposal: **SVG**, written by `tools/balance`, not by the web
  client. It is a few hundred lines of string building with no dependency, it
  diffs in git, it opens in a browser, and it is available long before the
  isometric renderer exists. Draw it top-down rather than isometric — the point
  here is to inspect generation, not to preview the game: nodes coloured by
  terrain, edges as lines, POIs ringed and labelled with kind, units and guard
  strength, leaves marked, carved valley nodes marked, remoteness as a shade.

  **This dump is a developer tool and never becomes the game's map.** It exists
  to answer "did generation do what §2.1 says", so it deliberately draws the
  generator's internals — remoteness shading above all, which a player must
  never see. It is written by `tools/balance`, not by `apps/web`, so it cannot
  drift into the client. The map players look at is drawn in phase 3 and shares
  nothing with this but the `GameMap` it reads. See
  [`ARCHITECTURE.md` §9](./ARCHITECTURE.md#9-client--ui-layer-7). The command
  that produces it is [§2.1](#21-after-phase-1--the-diagnostic-svg).
- **A `GameMap` JSON round-trip test.** [Q15](./OPEN_QUESTIONS.md#q15) settled
  that the finished map is *sent* to all players rather than regenerated per
  client, so `GameMap` has to
  survive `JSON.parse(JSON.stringify(map))` intact. Cheap to assert now; painful
  to discover in phase 6 with a `Set` or a `Map` in the payload.

### 1e. The map harness

`runMapBatch` in `tools/balance/src/index.ts` reports leaf counts, terrain
shares, compactness both after Smooth and after Carve Valleys (the latter
expected to be worse, by design), and remoteness and guard-strength histograms.
Run a batch over many seeds and confirm the §11 parameters land where they
should.

It needs a way in, so this step also adds `tools/balance/src/cli.ts` — argument
parsing, the SVG writer's output path, and the stdout report — plus the `map`
and `map:batch` scripts in the root `package.json` that wrap it. Both are plain
`node` invocations: [§2](#2-seeing-a-map--what-a-reviewer-types) records why no
TypeScript runner is needed. The scripts live at the **root** so nobody has to
know the workspace layout to look at a map. Since only one placement strategy is built (Q23), this is also the
check on whether that choice holds: if POI spacing looks wrong in the SVG or
the remoteness histogram is lopsided, the second strategy goes behind the same
seam and gets compared here.

**Phase 1 done when:** `generateMap(seed, ruleset)` returns a valid map for a
batch of seeds with no unexplained rejections; the same seed gives a
byte-identical map twice; the SVG of a handful of seeds looks like §2's
description (rounded terrain regions, plains valleys, POIs on every leaf); and
the harness's report sits within §11's targets.

### What actually landed

All of 1a–1e, with the proposals in 1b and 1d taken as written: `delaunator`
for step 2, SVG from `tools/balance` for the dump. `pnpm map <seed>` and
`pnpm map:batch <n>` are the §2.1 surface, plain `node` with no TypeScript
runner as §2 said they could be. 157 tests pass; `golden/maps/adventure.txt`
joins `golden/rng/`.

Measured over 40 seeds (`pnpm map:batch 40`, 7.8 s): **every seed generates on
the first attempt**, 229–248 nodes, exactly 300 edges, 31–45 leaves, 60–63 POIs.
Terrain shares on the **finished** map run 44.8–48.1% plains, 29.8–30.2% forest
and 21.8–25.2% mountain against §2.1's 45 / 30 / 25. Remoteness spans [0, 1] on
every map and §4.2 reconciles exactly, row by row.

Seven things worth knowing, five of them only visible once the pipeline ran:

- **A pruned map is nearly a tree.** ~240 nodes and 300 edges is a mean degree
  of 2.5. Almost every surprise below follows from that, and it is worth
  carrying into any later reasoning about the graph.
- **The Smooth step is inert at the current constants**, because
  `COMPACTNESS_MAX = 25` never binds on a graph that sparse — measured
  compactness is 1.0 on average, 4.5 at worst. §2.1 is implemented literally
  ("flip *until* it falls below"), so the loop exits before it starts. This is
  the one question phase 1 raised:
  [Q27](./OPEN_QUESTIONS.md#q27). Nothing downstream depends on the answer.
- **Terrain regions get sealed off** — on a near-tree, a region can find every
  node next to it already taken long before it reaches its share. Step 4 answers
  that with farthest-point seed placement on junction nodes and shallowest-first
  growth; see the note on the step. That alone still left the finished mountain
  share anywhere from 6.4% to 31.0% across 40 seeds, which is what
  [Q28](./OPEN_QUESTIONS.md#q28) then fixed.
- **The shares are a property of the finished map**
  ([Q28](./OPEN_QUESTIONS.md#q28), Andrei on PR #10). Step 6 carves forest and
  mountain into plains after step 4 has hit its shares, so the map a player is
  handed drifted badly — `adventure` finished 65 / 26 / 9 — and because §4.2
  fixes the POI count per terrain, whatever terrain shrank also crowded its
  POIs: two thirds of every mountain node on that map carried one. Step 6 now
  ends by growing the short terrains back into plains, leaving the carved
  fingers and their mouths alone, and the same growth finishes step 4. Over the
  same 40 seeds that moved plains from 32.9–66.8% to 44.8–48.1%, forest from
  17.5–45.7% to 29.8–30.2%, and mountain from 6.4–31.0% to 21.8–25.2%.
- **Bigger reward stacks now sit on more remote POIs as a rule**
  ([Q29](./OPEN_QUESTIONS.md#q29), Andrei on PR #10). §4.3's weighted draw put
  the bigger of two stacks in a row on the more remote POI only 57% of the time,
  and raising `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` saturates near 65% because
  the draw is random and §4.2 leaves most rows barely more spare units than
  POIs. §4.3 gains a **step 4**: draw `REWARD_SWAP_PASSES × (POIs in the row)`
  pairs and exchange their stacks when the larger one is the less remote. At the
  default 5 passes that reads 96.3% over 200 maps, and every one of those 200
  clears 90% on its own. Its side effect is worth carrying into phase 3: gold
  POIs sealing *unguarded* fall from 3.3% to 0.2%, because §5.2 only caps to 0
  for a 1-unit stack on a remote node.
- **`POISSON_RADIUS_FACTOR` was recalibrated**, 0.85 → 0.815. It is an
  `EngineeringConfig` knob whose whole purpose is hitting the node budget, and
  0.85 — a guess made before a sampler existed — yields ~220 nodes against
  `MAP_NODE_COUNT`'s 240. No §11 value changed.
- **`tools/` typechecks as its own program now.** A CLI needs `process` and
  `node:fs`, and the engine packages must not get Node's globals by accident;
  `pnpm run typecheck` runs both `tsconfig.json` and `tools/tsconfig.json`.
  See [`docs/STACK.md`](./STACK.md) §3.

---

## Phase 2 — rules engine, headless — **done**

Everything in `packages/core/src/rules/`, plus `previewPath`. Pure functions,
no clock, no `Math.random`, dice injected. This is the phase where §8's worked
example becomes a test.

1. **`resolveMovement`** — walk the path as far as this turn allows, charging
   the free per-terrain allowance first and stamina beyond it, terrain charged
   being that of the node being *entered*. The unwalked remainder is saved as
   next turn's planned path.
2. **`previewPath`** — the same accounting, producing §7.1's per-step colours
   instead of a new state: green free, yellow costs stamina, grey
   unreachable. (§7.1 labelled yellow steps with their cost until Q32 dropped
   the label in phase 3's review; `previewPath` still reports each cost.) Deliberately the same function family as `resolveMovement` so
   the preview and the committed move cannot disagree. Grey reflects only this
   turn and is never cached.
3. **`resolveInteraction`** — §8. Unguarded: take it. Guarded: roll
   `GUARD_DIE`, and `roll + matching skill > guard_strength` takes the reward,
   otherwise it stays and the roll costs nothing. Either outcome ends the turn.
   No per-player attempt history, no occupancy check, no penalty field.
4. **`nextSeat`** — a plain cycle; turn order is fixed at game start. Resigned
   seats are not skipped.
5. **Victory** — a single leader wins when `max − runnerUp > unclaimedGold`;
   tied leaders share the win exactly when no gold remains. Re-evaluated each
   time a gold POI is claimed.
6. **`applyAction`** — the one writer. Sequence: resolve movement → if the turn
   ends on an unclaimed POI, interact automatically → if gold was claimed,
   re-evaluate victory → end turn, advance seat, refresh allowance. Clone only
   the mutable part; `GameMap` is shared by reference.
7. **`refreshAllowance`** is already written. `PlayerStats` is
   `Record<RewardKind, number>`, uncapped, so claiming a reward is one addition.

**Tests:** §8's worked example, step by step, as the reference case — stamina 14,
plains-move 3, forest-move 1, mountain-move 0, fighting 2, three free plains
steps, a fourth costing 1 stamina, then a free forest step, then a d6 of 4
against guard 5 taking the reward. Then: a path that runs out of stamina
mid-way saving its remainder; rest granting `REST_STAMINA_GAIN` and moving
nothing; a failed guard roll leaving the POI claimable by anyone including the
same player later; two players on one node; the three victory cases (clear
leader, lead not yet decisive, tie with no gold left); `applyAction` leaving the
input state untouched.

**Done when:** a full game can be played start to finish in a test by calling
`applyAction` in a loop, and it terminates with a winner.

### What actually landed

All seven items, with the rules taken from §7/§8 as written and §8's worked
example as a test that reads step by step. 249 tests pass, up from 180.
`pnpm game <seed>` plays a whole game headlessly and prints it turn by turn, and
`golden/games/adventure-2p.txt` joins `golden/maps/` and `golden/rng/`.

**Ten games on ten generated maps, two players each, all ended with a winner**
in 74–198 turns. Guard rolls fail about 40% of the time (11 of 30 on
`adventure`, 26 of 45 on `duskmoor`), which is the engine's most-exercised
branch and exactly the loop §8 describes: leave, come back, or stand still and
try again.

Five things worth knowing, three of them only visible once games ran:

- **Two functions were added that the plan did not list**, both because the
  alternative was a copy in each of three later phases. `createGameState`
  (`rules/setup.ts`) is the opening position — §6's seats, stamina by seat and
  the one shared starting node — and `createDiceSource` (`rules/dice.ts`) is the
  one `DiceSource` over an injected `Rng`. Phase 4's hotseat, phase 5's rollouts
  and phase 6's `SetupFlow.start` all need both.
- **`PostMessageAction` carries an id and a timestamp now.** The engine has no
  clock by design (`Clock` is a session port), so the caller stamps a post and
  `applyAction` appends it. Without that, a replayed game's board could not come
  out identical to the original's.
- **`game_won` replaces `turn_ended` rather than following it.** A finished game
  hands over to nobody, so the turn does not advance — which is also what makes
  `status === 'finished'` a safe terminal test for the rollout (§9).
- **A walk stops at the first step it cannot pay for**, rather than skipping to
  a cheaper step further along. Obvious once stated; worth stating, because the
  preview and the committed move both depend on it and they are one function
  family so that they cannot disagree.
- **A game nobody can finish is possible in principle** —
  [Q30](./OPEN_QUESTIONS.md#q30). §8 needs `roll + skill > strength`, so gold
  behind a guard of 10 is unreachable to a player with fighting 3 on *any* roll,
  and §1 has no other way to end a game. None of the ten games hit it, nothing
  is blocked on it, and the engine implements the rules as written; the harness
  driver reports `stalemate` so a test cannot hang.

---

## Phase 3 — art binding and the isometric renderer — **done**

**This is the player-facing map** — the one drawn the way §1.3 and §7.1
describe it, with node images, dressing, reward icons, guard numbers and road
strokes. It replaces nothing: phase 1's SVG stays as the generator's diagnostic
view and the two are separate drawings of the same `GameMap` (see item 9).

`docs/ARCHITECTURE.md` §9 deliberately deferred this, so it needs decisions
rather than only code. It does not touch game logic and can run in parallel with
phase 2.

1. **Atlas loader.** The sheets in `Art/` are already cut: each
   `*_atlas.json` carries `sheet`, `cell_width`, `cell_height` and a `sprites`
   array of `{id, x, y, width, height, anchor, source_box_in_original}`. So the
   loader is a thin typed reader plus a sprite-id index — no cutting, no
   packing. Three fields are optional and only some sheets carry them:
   `placeholder: true` marks stand-in art, and on the road brush each sprite
   carries `tiles: "horizontal"` and `centerline_y`. The loader should keep
   them rather than drop them, since they are what tells it a sprite is a
   repeatable stroke instead of a one-shot image.
2. **The reward-kind-to-sheet mapping.** Eight POI sheets are named by
   `(terrain, kind[, guard])`: `Plains_PlainsMovement`, `Plains_ForestMovement`,
   `Plains_Magic`, `Plains_GoldGuardedByFighting`, `Forest_MountainMovement`,
   `Forest_Fighting`, `Mountains_GoldGuardedByFighting`,
   `Mountains_GoldGuardedByMagic`. That is exactly §4.2's rows *minus* forest
   gold. Two rows therefore borrow a sheet until their own exists (Q20):
   **forest gold** draws from `Mountains_GoldGuardedByFighting`, and the
   **stamina** POIs that surplus leaves create draw from
   `Plains_PlainsMovement`. Put those two substitutions in one table the art
   mapping reads, not scattered through the renderer, so swapping in a real
   sheet is a one-line edit. Four dressing sheets cover the eye candy:
   `Plains_Fields`, `Plains_GrassRocks`, `Forest_Trees`, `Mountains_Mountains`.
3. **`Poi.artVariant` becomes an index** into the chosen sheet's `sprites`
   array, modulo its length, so a POI's picture is stable across reloads and
   replays and no sheet's sprite count is baked into the generator.
4. **`render/isometric.ts`** — `Projection` (world ↔ screen), `Camera`, and
   `fitToViewport` for §1.3's "whole map visible at game start". Sprites are
   placed by their atlas `anchor`, which is what makes them sit on a node
   rather than beside it.
5. **`render/scene.ts`** — the draw layers, split by how often each
   invalidates: terrain, dressing, edges, nodes, POIs, path overlay,
   characters, UI. Dressing is billboard sprites pasted on by the engine and is
   never interactive.
6. **Reward icons** — all seven of §4.1 are in `Art/Icons/`, but two filenames
   do not describe their contents: `roads.png` is the brown wagon wheel (plains
   movement) and `plains.png` is the green foot (forest movement). The mapping
   must be written against the pictures, not the filenames, and the filenames
   are worth fixing. A stack of N units draws N overlapping icons (§4.1).
7. **Road edges.** §2 draws edges as "road/path-styled", and
   `Roads_Brush_atlas.json` supplies three stroke widths. Each is one tile of a
   stroke: rotate it to the edge's bearing and repeat it from node to node. Its
   centreline is deliberately near-flat and `centerline_y` says where that line
   sits, so a straight edge draws straight; the organic look comes from the
   width varying along the tile. Which width a given edge gets is not something
   the design assigns, so phase 3 can pick one and leave the other two unused.
8. **Dependencies.** `docs/STACK.md` §3 chose Vite + React for the chrome and
   PixiJS for the map. `apps/web` currently declares no framework dependency at
   all, so this phase is where Vite, React and PixiJS enter the lockfile, along
   with a dev server script and a build script. The dev server is what a
   reviewer opens the map in: `pnpm dev`, then
   `http://localhost:5173/?seed=<seed>`, with the page generating from the
   query string since §12.1 already puts generation on the client. Spelled out
   in [§2.2](#22-after-phase-3--the-map-as-a-player-sees-it).
9. **What the player must not see.** `GameMap` is sent whole to every client
   ([Q15](./OPEN_QUESTIONS.md#q15)), so `Poi.remoteness`, `Poi.group` and
   `GameMap.attempts` are all sitting in the browser. None of them is drawn:
   `remoteness` feeds §4.3's reward assignment and §5.2's guard strength, so
   putting it on screen would show a player the generator's own difficulty
   scoring. `artVariant` is drawn only as what it is, a sprite index. A guard's
   *strength* is shown, per §4.4 — that is a game rule, not an internal. The
   scene has no debug layer; anything a developer wants to see goes in phase 1's
   SVG.

**Done when:** a generated map from phase 1 renders isometrically in a browser,
whole-map-visible at open, with terrain colours, dressing, POI images, guard
numbers in red or purple, and reward icons — and a person looking at it can
read nothing from it that the rules do not give a player, in particular no
remoteness shading anywhere on screen.

### What actually landed

All nine items, drawn with PixiJS in `apps/web` and viewable with no checkout
as a published page (§2.2). 47 new tests, 300 in all. Andrei asked for one
thing beyond the plan — **art that is easy to swap, since most of it is
placeholder** — and that shaped most of what follows.

- **One table decides every picture: `Art/manifest.json`.** It names the sheet
  for each terrain texture, dressing kind, POI row, road, marker and figure, and
  the size each is drawn at. The two Q20 substitutions are rows in it with a
  `borrowed` note. No code names a file in `Art/`, so a swap is a file drop plus
  at most one manifest line; [`Art/README.md`](../Art/README.md) walks through
  one. A sheet pairs with its atlas by file name, because five supplied atlases
  name a file that was renamed on the way in.
- **Sizes are in node spacings, not pixels.** One node spacing is the median
  road length, and each sheet is scaled on load so its typical sprite (the
  median of each sprite's larger solid side) comes out at its manifest size. A
  replacement drawn at another resolution, or with more padding in its cells,
  needs no other change.
- **Most supplied sheets bake their shadow in as opaque grey** (`#bbbbbb`),
  which would sit on the terrain as a grey slab. The loader turns exactly the
  colours the manifest lists into translucent black, rim included, and a sheet
  whose replacement draws its own shadow just loses its line. Those sheets
  also anchor each sprite at the foot of that shadow, which left guardians
  floating behind their nodes, so a sprite whose anchor sits below its lowest
  solid pixel now stands on that pixel.
- **Some supplied sheets are edited as they load, never in the PNG**
  (Andrei's art pass after phase 4, 2026-09-23). The cottages and magic
  buildings are brightened, the magic ones with much richer colour; the
  guards are drawn twice the size with a faint cream contour, so they read
  on the mountains, and the statues half as large again with a thin dark
  contour. On the way there Andrei turned down a cream contour three times
  as thick (too bright) and brighter, more vivid guards (they looked wrong).
  Each is one line under `adjustments` in the manifest, which a replacement
  that already looks right just loses. Bigger guards crowd a mountain, so a
  picture now avoids touching another POI's picture even at the cost of a
  little road. The same pass turned the plains grass upright: it is drawn
  through the inverse of the isometric projection, where before it leaned
  right with the ground.
- **Four placeholders were generated** by `make_placeholders.py`, flagged
  `placeholder: true` like the die and the brush: tileable textures for the
  three terrains, and `Prospect_Markers` — §7.1's dots and crosses in green,
  yellow and grey, a waypoint flag and an active-player ring. The viewer
  first had an "Art in use" panel listing every picture as placeholder,
  borrowed or supplied from those flags; Andrei had it removed in phase 4, and
  the flags stay in the atlases.
- **The icons are renamed for what they show** (item 6): `plains_move.png`
  (the wagon wheel, was `roads.png`), `forest_move.png` (the green foot, was
  `plains.png`) and `mountain_move.png` (was `mountains.png`), so every icon
  is now `Icons/<reward kind>.png`.
- **The ground is one textured cell per node** (a Voronoi cell clipped to the
  map), which is how §2's terrain types read as areas rather than dots. Every
  road draws `Roads_Path`, the middle of the brush's three widths (item 7).
- **Dressing never hides the game.** It is scattered deterministically from the
  map's seed at a per-terrain density, kept off nodes and roads, and never
  stands in front of a node or a road on screen. A test checks all three.
  Mountains are the exception since Andrei's review: the manifest marks them
  `backdrop`, so they are painted onto the ground under the roads and nodes,
  each sized between `min_size` and `size` to stay over mountain ground, and
  clipped to it, covering the whole mountain area instead of only its edges.
  The largest go down first, so the middle of a region carries peaks up to
  2.4 node spacings across and smaller ones fill in along the edges; on seed
  `adventure` 60% of the mountain ground lies under a peak at least three
  times a tree's size, which a test holds above half.
  Fields are laid out in small arrays side by side along the ground.
- **Nothing internal is drawn** (item 9), and a test proves it the direct way:
  scrambling every POI's `remoteness` and `group` and the map's `attempts`
  leaves the scene identical, value for value.
- **A guard's colour is on its POI's node, and comes from the POI's guard,
  never from the sheet** (Q31). A guarded node keeps its black outline and
  gains a red or purple ring outside it. So a gold POI whose guard §5.2 capped
  to nothing still shows its castle, on a plain node with no number, and
  forest gold on the borrowed mountain sheet gets red because its guard is
  fighting. The first build ringed the picture itself, per §3's wording;
  Andrei moved it to the node in his review.
- **A POI's picture stands beside its node, where it hides least.** Each
  picture touches its node in one of seven directions, behind or to a side,
  and takes the one that covers the least road, no other node and no other
  POI's picture or reward. Measured on `adventure` with the tests' rough
  sprite shapes, that hides 3 pixels of road against 549 with every picture
  straight behind its node, and no picture covers another POI.
- **A claimed POI is drawn faded on a plain node, with no icons or number.**
  §4.5 says the node then behaves as an ordinary node; fading rather than
  removing the building is a default, one line to change.
- **Andrei's first review (2026-09-23) made everything smaller and quieter.**
  POI pictures are half their first size, which had them covering roads and
  neighbouring POIs; the plains grass is under a third of its first size, the
  fields about half, and the figures, waypoint flag, reward icons and guard
  numbers shrank to match. Route steps that cost stamina are yellow with no
  "-N" beside them (Q32). His second look the same day enlarged the node ovals
  by half, with the reward icons touching them, and the magic POIs' towers by
  half again.
- **Pan and zoom landed early** (`interaction/camera.ts`: drag, pinch, wheel,
  `+`/`-`, and "Whole map"), because a map shown whole on a phone is too small
  to judge art by. Move mode stays in phase 4. So does the move-prospect
  input: the markers are drawn from `previewPath`, and the viewer shows one
  sample route, walked by §8's worked-example player, so they can be judged
  before phase 4 wires them to a click.
- **Three type-check programs now**, not two: `apps/web` needs the DOM, JSX and
  Vite's types, which the packages must never see. `pnpm run typecheck` runs
  all three, as CI does.
- **`pixi.js/unsafe-eval` is imported once**, in `main.tsx`, so the renderer
  works under a page policy that forbids `eval` — which is what lets the
  viewer be published as a page at all.

---

## Phase 4 — hotseat UI — **done**

§7.2's hotseat is not a second client: it is the §7.1 UI with
`allowOutOfTurnPlanning: false`, which makes the move-mode controller refuse
`enter()` for any seat that is not active. Duplicating the client to remove one
feature would guarantee drift.

1. **Local setup.** **Two seats** — Andrei fixed the hotseat count at 2, which
   exercises turn order and both victory cases, and `PLAYER_COUNT` (2–5) stays
   untouched in config because this is a hotseat constraint, not a change to the
   game's range. A name and a figurine per player, starting stamina by seat
   (`STARTING_STAMINA_BASE` + (seat − 1) × `STARTING_STAMINA_INCREMENT`), all
   seats starting on one shared plains node with no POI via `chooseStartingNode`
   from an `Rng` derived from the map seed.
2. **`interaction/camera.ts`** — click-drag pan, `+`/`-` zoom.
3. **`interaction/moveMode.ts`** — the state machine: idle → selecting →
   previewing. Clicking your own highlighted character enters move mode;
   clicking a destination draws the shortest path as a thick dotted line with an
   isometric cross at the destination; shift-click sets one intermediate
   waypoint (`routeVia`); End Turn commits; Rest is the alternative action.
4. **Path colouring** comes from `previewPath` in `@adventure/core` — the client
   computes no rules of its own. It recalculates every turn as allowances
   refresh.
5. **Stats panel** — all seven stats for every player, uncapped, beside name and
   avatar, visible to everyone (§1 has no hidden information). The current
   player's name and avatar prominently displayed and their character
   highlighted on the map. The avatar set is still to come (Q26); until it
   lands, draw the figurine cropped to its box in
   `Art/player_avatars_portraits.json` and scale that into the frame.
6. **Dice.** Hotseat has no server, so it needs a local `DiceSource`. Keep it
   behind the interface the engine already takes, because online play must take
   rolls from the server's separate die stream — a client-side dice source that
   leaks into the online path would be a real bug. §10's die-roll animation is
   now in `Art/`: loop the eight `Dice_d6_Tumble_*` sprites while the roll is in
   flight, then hold the `Dice_d6_Face_*` sprite whose `value` matches what the
   engine returned. No tumble frame may be held as the result — none of them is
   axis-aligned, so none reads as settled. Show the roll, the skill added and
   the guard strength it was compared against either way.
7. **Turn hand-off, game end and the win.** Pass control to the next seat,
   detect the end through the engine (never recompute it in the UI), and show
   the winner or the shared victory.

**Done when:** a full hotseat game is playable end to end in a browser, with a
winner, and every number on screen came out of `@adventure/core`.

### What actually landed

All seven items, as the page `pnpm build:web` builds and the published viewer
now plays: pick a map by its seed, name the two seats and choose their
figurines, then play it out on one screen until the engine declares a winner.
31 new tests, 331 in all.

- **The move-mode controller is one class for both modes**
  (`interaction/moveMode.ts`). It knows the mode it runs in and the seats this
  screen controls, and nothing else about hotseat; `modes/hotseat.ts`'s
  `HOTSEAT_MODE` turns out-of-turn planning off, so `enter()` answers
  `not_your_turn` for the other seat. It commits `TurnAction`s through a
  callback and draws nothing, so phase 7 wires the same controller to a
  transport. A test plays a whole game through it, seat after seat, to a
  winner.
- **`HotseatGame` is the only local writer** (`modes/hotseat.ts`). It builds
  the state with `createGameState`, puts both seats on
  `chooseStartingNode(map, rng(map.seed).fork('starting-node'))`, and plays each
  action through `applyAction` with a `createDiceSource` of its own. The dice
  seed is drawn fresh for every game and printed at the top of the turn log,
  so any game can be replayed number for number; nothing online imports it.
- **A move keeps the waypoint it was planned through.** `MoveAction` gained an
  optional `waypoint`, and `applyMove` saves it with the route it could not
  finish, so a player's next turn reopens on that route with its waypoint flag
  still up. Before this, only the path survived and the flag vanished.
- **End Turn plays the turn out in three beats**: the figure walks the steps
  the engine says it walked, the die tumbles if a guard was faced, then the
  result card holds the matching face beside "4 rolled + 2 combat = 6
  against 5" and says what was taken or that the gold stays. The engine has
  already resolved the turn before the first beat; the beats only reveal it.
- **Every number on screen comes from the engine**: the stats panel shows the
  engine's seven stats for each player and the free steps left in this turn's
  allowance, the route's colours and its hint ("All 9 steps this turn, for
  9 stamina") come from `previewPath`, and the end card names the engine's
  `winners` and the gold `unclaimedGoldUnits` says is left. The browser check below compares them to a second
  copy of the engine after every turn.
- **The turn log says what happened in words** (`page/journal.ts`), held to
  the bar Andrei set for PR #11's log: where each player was heading, which
  terrain each step entered and whether a free step or stamina paid for it,
  why a walk stopped and what was saved, each roll with its sum, and every
  player's stats after the turn. A test reads §8's worked example back in
  those words.
- **Defaults the plan did not settle**, each a small change if Andrei wants
  otherwise:
  - A "Plan a move" button sits beside tapping your figure, and a
    "Waypoint" button arms the next tap as the waypoint, because a touch
    screen has no shift key. "Find" centres the map on the current player,
    and on a phone "Plan a move" does too, since the whole map there is too
    small to find a figure or tap a node.
  - End Turn with no route drawn means stay put, which is §8's way to fight a
    guard again from its node; Rest is its own button.
  - There is no hand-off curtain between seats: a notice names the next
    player and their card lights up. §7.2 has no hidden information, so
    nothing needs hiding while the device changes hands.
  - Tapping a POI's picture means its node, since the picture stands beside
    the node rather than on it.
  - The sample route and its toggle are gone from the page; the route drawn
    is now always the current player's own.
- **A browser check plays whole games by clicking**, at desktop and at phone
  size. A Playwright script (kept out of the repo, like the phase 3
  screenshots) taps the figure, taps the target, shift-taps or uses the
  Waypoint button, presses End Turn or Rest, and after every turn compares
  what the page shows, down to each stat in the panel, with a second copy of
  the engine fed the same actions and the page's dice seed. Games of 163 and
  153 turns ran to a winner with every number matching. It found three real
  bugs, all fixed: an animation frame stamped a moment before the walk began
  stalled End Turn for good; on a phone the end card covered the OK button of
  the winning turn's result card; and the map's canvas kept its first size
  when the panels round it changed height, because PixiJS's `resizeTo`
  follows the window only.
- **A closed tab loses the game**, as P3 says: nothing is saved, and reload
  starts a new setup on the same map.
- **Andrei's first look at the game** (2026-09-23) asked for three changes,
  all made:
  - The "Art in use" panel is gone from the page.
  - The current player's figure blinks while it is their turn, so it is easy
    to find, with a ripple spreading on the ground under it; once they tap it
    or press Plan a move it stops blinking and is highlighted instead, a gold
    ring round it, until the turn is played. Cancel sets it blinking again.
    `MapRenderer.setCue` takes `blink`, `selected` or `none`; the page picks
    one from the turn and the move mode, and the renderer animates it.
  - The page calls the moving skills **plains speed, forest speed and
    mountains speed**, and fighting **combat**: in the stats panel, the
    result card, the turn log and every hint. The engine's names
    (`plains_move`, `fighting`, the `fighting` guard type) are unchanged, and
    one table in `page/journal.ts`, `STAT_LABEL`, is where the page's words
    come from. A test reads a whole game's log and finds none of the old
    words (332 tests now). The turn log's header also reads each terrain's
    step cost from the map's ruleset rather than from fixed text.

---

## Phase 5 — AI players, the engine

Depends on phases 1, 2 and nothing else. Every policy, evaluator and branch rule
is already written; the loop is not.

1. **`unclaimedPoiNodes`, `rolloutDriver`, `runRollout`** and
   **`macroAdvanceToTarget`** (`packages/sim/src/rollout.ts`). A rollout plays
   through the *real* rules — every turn goes through `applyAction` — and every
   seat is simulated by the same policy, human-controlled seats included. There
   is no opponent model. A macro-action commits to a POI and keeps moving toward
   it across as many turns as it takes, ending on exactly `arrived`,
   `target_claimed_by_other` or `terminal`.

   **Do not force this through `runWalk`.** The architecture pass gave the two
   walks a shared loop, and the designer's prediction is that only the target
   chooser survives (Q25). Four concrete places where `runWalk` and
   `WalkDriver` fit remoteness and strain against a rollout, worth checking
   before writing `rolloutDriver`:

   - `WalkDriver.advance` returns `TCursor | null`, which cannot express
     `MacroAdvanceOutcome` — `arrived` and `target_claimed_by_other` both
     collapse to "here is a new cursor", and they are not the same thing.
   - `runWalk` records the visit unconditionally after any non-null advance, as
     `{target: target.node, legCost: target.cost}`. For remoteness that is
     exactly true. For a rollout `target.cost` is the Dijkstra *estimate*
     rather than what the real turns cost, and on `target_claimed_by_other` the
     walker never reached `target.node` at all.
   - `WalkResult.visits` and `totalCost` are what the remoteness scorer
     consumes. A rollout needs none of it — `runRollout` returns the terminal
     `RolloutCursor`, because the evaluator reads the subject's gold from the
     state.
   - `WalkDriver.done(cursor)` cannot supply the leg count that
     `RolloutTermination.isTerminal(cursor, legsTaken)` takes, and that argument
     exists for the depth cap that is the obvious lever if rollouts prove slow.

   If those hold up when the code is written, give the rollout its own small
   loop over `macroAdvanceToTarget` and `RolloutTermination`, keep
   `candidates.ts` shared, and leave `walk.ts` as remoteness's own loop. What
   §9 actually asks to share is the target chooser and the cost metric, and
   both stay shared either way.
2. **Termination.** `goldExhaustedTermination`: a rollout stops when **no gold
   rewards are left on the map** — specifically not "all POIs claimed" — and
   also on a finished game, since victory can fire earlier. It sits behind an
   interface because a turn or depth cap is the obvious lever if rollouts prove
   slow.
3. **`closestPoiRolloutPolicy.run`** — the §9 rollout policy over the same
   shared kernel from 1a.
4. **`search()` and `createRootNode`** (`packages/ai/src/mcts.ts`) — the
   four-phase loop: select with UCT, expand one untried branch at a time through
   `applyAction`, roll out, backpropagate; return the most-visited child of the
   root once `MCTS_TIME_BUDGET_PER_MOVE_MS` (10,000) is spent. Branches are the
   `CLOSE_CANDIDATE_COUNT` closest unclaimed POIs *recomputed against that
   node's state*, plus a rest branch added only when fewer than
   `MIN_REACHABLE_NODES_FOR_REST` (3) of those targets are reachable this turn —
   counted over the pruned list, not every POI on the map. `search()` returns
   only the **first turn** of the chosen branch; the session layer commits one
   turn at a time and the rest is re-derived next turn. Reachability is injected
   as `TurnReachability` because it needs `previewPath` from phase 2.
5. **Evaluators.** All three are written and v1 uses the simulated one, so this
   step is only wiring: `SearchOptions.evaluator` is injected with no default on
   purpose. Every evaluator returns a value in [0, 1], which is what makes
   `MCTS_EXPLORATION_CONSTANT` = √2 correct — a new evaluator has to preserve the
   range, not a particular divisor.
6. **An AI seat in hotseat.** The cheapest possible way to play against it, and
   it needs no server at all.
7. **`runSelfPlayBatch`** in `tools/balance`, then **the balancing pass**: tune
   the six parameters §11 marks tunable, with `REMOTENESS_SIMULATION_RUNS`
   called out by §5.1 as expected to change "if 100 proves too imprecise or too
   slow". Measure map generation's cost while here — `docs/STACK.md` §4 says the
   remoteness pass dominates and to measure it rather than assume. Because the
   AI budget stays in wall-clock seconds (P2), a self-play result is only
   comparable to another run on the same machine, so record the machine beside
   the numbers.

**Tests:** a rollout terminates when gold is exhausted with skill and stamina
POIs still on the map; a macro-action that has its target claimed underneath it
reports `target_claimed_by_other` rather than continuing; the rest branch
appears exactly when fewer than 3 targets are reachable; every evaluator's
output inside [0, 1]; `search()` inside its time budget and returning one legal
turn; self-play games terminating.

---

## Phase 6 — server foundation, auth and lobby

Step 3 is mostly `SetupFlow` plus auth plus a game list, but none of it can run
until the host is real. That is the substance of this phase.

1. **Make the host decision concrete.** §12.1 and `docs/STACK.md` §5 decided:
   Cloudflare Durable Objects for the session layer, one DO per `gameId`, with
   map generation and the MCTS search on the game master's machine. So this
   phase adds the Workers project and `wrangler` config and turns
   `apps/server/src/adapters/durable-object.ts` into a working adapter.
   `packages/session` imports no transport, storage, socket or timer and the
   in-memory adapters exist to keep proving that — keep both adapters working,
   because the in-memory one is what tests run against.
2. **Transport.** WebSocket, with Hibernation: a 2–5 player turn-based game idles
   for minutes at a time, so hibernation makes idle games cost approximately
   nothing while keeping connections open.
3. **`GameStore` and `Broadcaster`** against DO transactional storage,
   co-located with the object that owns the state. The message board is ordinary
   game state (§12.3) so it needs no storage of its own.
4. **Auth (§6.1).** Username and password, entirely behind `AuthProvider`;
   `Credentials` is an open union whose only v1 variant is
   `{method:'password', username, password}` and no other package knows what a
   password is. The architecture requirement is that stronger security swaps in
   later without a rewrite. Needs: a user store, password hashing, and session
   tokens. Login and register screens.
5. **The game list.** §3's "logged-in users see a list of in-progress games and
   can join one or start a new one" is the one thing that does not fit one-DO-
   per-game: listing games means an index *across* DOs. Proposal: a single lobby
   DO (or a KV index) that games register with on creation and update on state
   change. Worth naming because it is the only piece of multiplayer
   infrastructure the architecture pass did not shape.
6. **`SetupFlow`** — GM sets player count, users request to join, GM accepts or
   rejects (which allocates the next seat and thereby fixes turn order), each
   player picks name and avatar, GM starts. The GM is the game's creator and the
   role cannot be transferred in v1, so there is no transfer message in the
   protocol at all.
7. **`GameSession.handle`** — single-writer per `gameId`, so the authoritative
   state never needs locking. Its responsibilities are authority, sequencing,
   driving AI turns and persistence-plus-broadcast, and it contains no game
   rules.

**Done when:** two browsers can register, log in, see the same game list, and
one can create a game the other joins and is accepted into, up to the point
where the GM starts it.

---

## Phase 7 — online play

1. **Committing a turn.** Client sends the intended action, the server resolves
   it through `applyAction` with its own die stream, persists and broadcasts.
   The server's dice are deliberately separate from the public map seed — §1's
   no-hidden-information covers the map, POIs and rewards, all of which clients
   get in full, but a shared seed would let a client precompute rolls.
2. **State distribution.** The server sends the whole `GameState` and never
   computes a per-player view, because there is no hidden information. The
   finished `GameMap` is sent to all players via `gm.mapGenerated`
   ([Q15](./OPEN_QUESTIONS.md#q15)) — determinism still buys replay and
   debugging, it just is not used to save bandwidth.
3. **Reconnect and resume.** Players idle for minutes and hibernation keeps
   sockets open, so a returning client has to be able to load the current state
   and the map from scratch. Not called out in the design; unavoidable in
   practice.
4. **Out-of-turn planning (§7.1).** Players may plan their next move while
   others play, and End Turn then executes it in one click; an unfinished path
   is saved for the next turn and can still be changed. This is the *one*
   behaviour §7.2 says hotseat does not have, so it is the flag from phase 4
   turned on, and it is easy to forget precisely because phase 4 built the move
   UI without it.
5. **Message board (§7.1).** Human players post messages visible to everyone.
   Game state per §12.3, so it rides `GameStore` and the normal broadcast. Its
   persistence and scope were the §12.3 item, decided as per-game state.
6. **GM controls (§7.3).** Force a player's currently-planned move, or force a
   rest if none was planned, at the GM's discretion with no fixed time
   threshold. A GM-only request with no game master connected is answered
   `game_master_unavailable` and the game waits (§12.4) — there is no fallback
   to configure.
7. **Resignation.** A human may resign at any time. Only the GM can hand control
   back to a human. The AI takeover half of this needs phase 8.

**Done when:** a full 2-player online game is playable end to end from two
browsers, survives a reload on both sides, and the GM can force a stalling
player's move.

---

## Phase 8 — AI in multiplayer

1. **Compute on the GM's machine.** §12.1 put map generation and MCTS on the
   game master's client, so the DO adapter implements `MapService` and
   `AiService` as round trips to the GM (`gm.requestMapGeneration` /
   `gm.mapGenerated`, `gm.requestAiMove` / `gm.aiMove`). The session core never
   learns this — that is what the ports were for. Note this makes `apps/web`
   depend on `@adventure/mapgen` and `@adventure/ai`, which it does not today.
2. **A Web Worker is not optional.** 10 seconds of search per AI seat per turn
   cannot run on the GM's UI thread.
3. **The composed consequence, stated plainly:** with AI and map generation on
   the GM's machine, a disconnected game master blocks forced turns *and* every
   AI turn *and* map creation, so even an all-AI game cannot advance without the
   GM online. That is §12.1 and §12.4 composed, and it is stronger than either
   alone. Worth surfacing in the UI so a stalled game is legible rather than
   mysterious.
4. **AI seats at setup** — including AI players in a game from the setup screen.
5. **AI settings** — thinking time per turn, in seconds: Andrei confirmed the
   budget stays wall-clock rather than a rollout count, because the game is for
   fun rather than for a consistently strong AI.
   `MCTS_TIME_BUDGET_PER_MOVE_MS` is config, so a per-game override needs a
   path through the protocol.
6. **Handover** — an AI takes over a resigned seat so play continues, and the GM
   may switch any player between human and AI control at will. Only the GM hands
   control back to a human.

**Done when:** a mixed human/AI online game plays to a finish, AI turns do not
freeze the GM's browser, and the GM can flip a seat either way mid-game.

---

## Out of scope for v1

Named so the plan is not read as having forgotten them: spectators, replay
playback UI (the determinism that would support it is there either way),
tournaments or ranking, cross-game chat (§12.3 scoped the board to a game),
mobile or touch input, internationalisation, GM role transfer (§6.1 rules it out
for v1), and guarding any reward kind other than gold (an engine capability
already, but a v1 *content* choice per §4.4).

---

## Questions

Five things this plan could not settle from the documents. **All five were
answered on 2026-09-22** and are registered as Q20–Q24 in
[`docs/OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md), which is where the repo keeps
decisions; the summaries below are a convenience, and the register is
authoritative.

### P1. ~~Art gaps~~ — **answered (Q20); placeholders generated for the rest**

[SOURCE chat, 2026-09-22] "I will add the missing placeholder art before we
start implementing the plan." So phases 3 and 4 are written against the full
set and need no fallback. Two of the gaps are closed in this change, at his
request — `Art/Dice_d6_sheet.png` + `Dice_d6_atlas.json` and
`Art/Roads_Brush_sheet.png` + `Roads_Brush_atlas.json`, both regenerable with
`python3 Art/tools/make_placeholders.py`. They carry `"placeholder": true` so a
loader, or a person, can tell stand-in art from the real thing. The rest of the
list below is Andrei's to supply:

Six §10 asset groups were missing from `Art/`, and one POI sheet:

- ~~**Forest gold.**~~ Eight POI sheets cover eight of §4.2's nine rows, with
  none for forest's 4 fighting-guarded gold POIs. [SOURCE chat, review]
  "Mountain gold placeholder images can be used" — so forest gold draws from
  `Mountains_GoldGuardedByFighting` until a forest sheet exists.
- ~~**Stamina POIs.**~~ Surplus leaves become stamina POIs, on any terrain, and
  no sheet covers them. [SOURCE chat, review] "Plaines movement placeholder
  images can be used" — so they draw from `Plains_PlainsMovement`.
- ~~**Character figurines.**~~ Supplied 2026-09-22 as
  `Art/player_avatars_sheet.png` + `player_avatars_atlas.json`: six full-body
  figures on a 617×698 grid, anchored at the feet like every other sheet.
  They are Andrei's own art, so no `"placeholder": true`. Setup offers these
  six.
- **Player avatars** for GDD §2's stats panel are still coming as their own
  head-and-shoulders set (Q26). Meanwhile phase 3 crops the figurines, using
  the per-figure boxes in `Art/player_avatars_portraits.json` — one uniform
  enlarge-and-shift does not work, because the six heads start between row 24
  and row 155 of the cell. Q26 has the measurements and the reasoning.
- ~~**Die-roll animation.**~~ Generated here: eight tumble frames to loop while
  the roll is in flight, then the six resting faces, one per `GUARD_DIE` value.
  [SOURCE chat, review] "this will be provided" — the generated one stands in
  until the real animation arrives.
- ~~**Terrain textures**~~ for the three terrains — generated in phase 3 as
  placeholders (`Plains_Texture`, `Forest_Texture`, `Mountains_Texture`), each
  one tile that repeats in both directions. (The **road/path brush pattern**
  is generated too: three stroke widths, each tiling horizontally with no seam,
  with a deliberately flat centreline so a straight edge draws straight. The
  old `Art/Icons/roads.png` was not it — it was the brown wagon wheel, §4.1's
  plains-movement reward icon. Phase 3 renamed the icons for their reward
  kinds, so that is now `Icons/plains_move.png`.)
- ~~**Move-prospect visuals**~~ — path dots, destination cross, waypoint
  marker, and a ring under the player to move — generated in phase 3 as the
  placeholder `Prospect_Markers` sheet.

### P2. ~~AI budget in seconds or rollouts?~~ — **answered (Q21): seconds**

`docs/STACK.md` §5 flagged this and left it as a design question: a fixed
10-second budget buys very different search on a laptop than on a workstation,
so with MCTS on the GM's machine, AI strength is not reproducible across games.
A budget in rollouts would fix that at the cost of a variable turn length.

[SOURCE chat, 2026-09-22] "Let's stick to the seconds budget for AI, the
purpose of this game is fun, not the strongest and most consistent AI." So
`MCTS_TIME_BUDGET_PER_MOVE_MS` stays as it is, §9 and §11 stand unchanged, and
`docs/STACK.md` §5's "AI difficulty is not reproducible across games" is an
accepted cost rather than an open item. One consequence for phase 5: a self-play
comparison is only meaningful between runs on the same machine, so the harness
should record the machine alongside the result.

### P3. ~~Hotseat scope~~ — **answered (Q22): 2 players**

[SOURCE chat, 2026-09-22] "2 players is a good enough number and exercises all
necessary functionality." Phase 4 fixes the hotseat seat count at 2.
`PLAYER_COUNT` (2–5) stays untouched in config — this is a temporary
constraint in the hotseat mode, not a change to the game's range, and phase 6's
setup flow is where the GM picks a count for real.

Left unanswered, and not worth blocking on: whether a hotseat game should
survive a page reload. Persisting to `localStorage` is small but the design does
not mention it, so phase 4 does not, and a closed tab loses the game.

### P4. ~~Q18, still open in fact~~ — **answered (Q24): the shipped reading is right**

Q18's `total_skills` is implemented as the skill units *placed on the map*
rather than a per-player maximum, and that reading shipped without
confirmation.

[SOURCE chat, review] "There is no set per-player maximum, none of the skills
are capped by any hardcoded number. So the total # of units place on the map
are going to be used." So `totalSkillUnits()` stands as written, and the
estimated evaluator's skill term reaches 1 exactly when one player holds every
skill POI — which is what makes it comparable with the gold term and keeps the
evaluator inside [0, 1]. Nothing changes in the code; the reading is now
confirmed rather than assumed.

### P5. ~~Are the placement strategies still both wanted?~~ — **answered (Q23): farthest-point only**

`docs/ARCHITECTURE.md` §3 left `PoiPlacementStrategy` as a seam with
farthest-point sampling and graph-space Poisson-disc both to be built and
compared in the harness — two implementations for one shipped behaviour.

[SOURCE chat, 2026-09-22] "use farthest point sampling, we'll switch if that
looks bad, which I doubt." So phase 1c builds that one, and the seam stays so
the switch is a one-liner. Phase 1e's batch over many seeds is where "looks
bad" would show up, in the SVG's POI spacing and the remoteness histogram.
