# Tech stack

**§12.1 is decided.** [SOURCE §12.1, chat] "We confirm using Durable Objects,
with flexible architecture to swap it for something else if DO don't fit the
bill. Everything else, i.e. map generation and player AI, runs on the game
master's machine."

The rest of this file is the reasoning that led there, what the decision costs,
and the items still open for confirmation. The swap-out flexibility is real and
structural: engine packages import no runtime APIs, and the session layer
reaches the outside world only through `SessionPorts`, of which the DO is one
adapter.

---

## 1. Language: TypeScript everywhere

The deciding argument is in §7.1, not in any performance consideration. Path
colouring — green for "covered by skill allowance", yellow for "costs stamina",
labelled with the exact cost — *is* the server's movement accounting, rendered.
If the client and the server compute it in two languages, they will eventually
disagree, and the bug will look like cheating or desync to players.

One language means `@adventure/core` is imported by the client for the preview,
by the server to commit the move, by MCTS to expand nodes, and by the balancing
harness to self-play. Four consumers, one rule implementation.

Supporting reasons: the engine stays runtime-neutral (Node, browser, Workers,
Deno all run it unchanged), which is what keeps §12.1 reversible; and the whole
codebase is one toolchain for what is presumably a small team.

The honest cost: **MCTS in TypeScript**. A 10-second budget per move (§9) in a
GC'd language will explore fewer nodes than the same budget in Rust or C++. Two
mitigations are already in the structure — `AiPlayer` is a port, so the search
can move to a separate service in any language; and the rollout kernel in
`@adventure/sim` is small and isolated, so it could become WASM without touching
anything else. I'd measure before doing either.

## 2. Workspace: pnpm monorepo

Already set up: `packages/*` + `apps/*` + `tools/*`, one `tsconfig.base.json`,
path-mapped `@adventure/*` imports, and `pnpm run typecheck` over everything —
two `tsc` programs since phase 1, one for `packages/` and `apps/` and one for
`tools/`, for the reason given in §3.

Engine packages carry **one runtime dependency**, which matters for determinism
as much as portability — fewer places for a library update to change a generated
map. That one is `delaunator`, added in phase 1 for §2.1 step 2 and used by
`@adventure/mapgen` alone: Delaunay is a solved problem and a hand-rolled
version is a determinism risk, not a feature. Poisson-disc sampling (step 1) is
a dozen lines and stayed in-repo, as predicted.

## 3. Client: Vite + React for chrome, PixiJS for the map

- **Map: canvas/WebGL, not DOM or SVG.** ~240 nodes, ~300 edges, plus per-node
  eye-candy billboards (§6) and POI/guardian sprites, under continuous pan and
  zoom. PixiJS is the least-ceremony option that batches sprites properly.
- **Isometric is a projection, not 3D.** §6 asks for an isometric view with
  billboard sprites pasted on; a 3D engine like three.js would buy nothing and
  cost a lot. `Projection` in `render/isometric.ts` is the whole of it.
- **HUD, message board, setup screens: ordinary DOM/React.** Per-player stat
  blocks next to name and avatar (§6), the join/accept flow (§6.1), the message
  board (§7.1) and GM controls (§7.3) are forms and lists. Drawing them in
  WebGL would be self-harm.
- **Vitest** for tests. Determinism from `(seed, params)` makes golden-seed
  snapshots the natural way to test map generation, and a fake `Clock` plus a
  seeded `Rng` make the AI and the session layer testable without mocks.
  **Installed**, with `pnpm test`, as phase 0 of
  [`docs/IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). Three conventions
  came with it:
  - **Tests live beside the module they cover**, as `*.test.ts` inside each
    package's `src/`. They then import through the same relative `.ts` paths the
    modules already use, so there is no build step, and the `tsconfig.json`
    include already typechecks them.
  - **Golden-seed snapshots live in `golden/`** at the repo root, one text file
    per snapshot, written with Vitest's `toMatchFileSnapshot()`. See
    [`golden/README.md`](../golden/README.md) — in particular that a golden
    diff is a finding to explain, and `pnpm run test:update-golden` is only for
    once you have decided which kind.
  - **`vitest run` in CI, never watch mode**, as a second required check beside
    Typecheck.

  Phase 2 added a fourth: **a test-only helper module is named `*.fixture.ts`**
  and is not exported from its package's `index.ts`. Vitest collects `*.test.ts`
  only, so a fixture file is not mistaken for an empty suite, while
  `tsconfig.json` still typechecks it. `packages/core/src/rules/scenario.fixture.ts`
  is the first: the rules tests need maps they can reason about line by line, and
  a generated map is both the wrong shape for that and unavailable in `core`,
  which `@adventure/mapgen` depends on rather than the other way round.
- **`tools/` typechecks as its own program.** Phase 1 gave `tools/balance` a
  CLI, and a CLI needs `process`, `console` and `node:fs`. Rather than adding
  `@types/node` to every program — the engine packages run in a browser as well
  as on a server, and nothing in them may quietly reach for a Node API —
  `tsconfig.base.json` sets `"types": []` and `tools/tsconfig.json` opts back
  in with `"types": ["node"]`. `pnpm run typecheck` runs both programs. This is
  a *typechecking* split only: there is still no build step, and Node 22 strips
  the types and runs the source either way.
- **`apps/web` typechecks as a third program**, for the mirror-image reason:
  it needs the DOM, JSX and Vite's `import.meta.glob` types, and the engine
  packages must never see those either. `apps/web/tsconfig.json` adds them and
  `pnpm run typecheck` runs all three. Vitest runs the web app's tests with the
  rest, including the ones that read `Art/` through `import.meta.glob`, so
  every art check is part of `pnpm test`.
- **Vite, React and PixiJS entered the lockfile in phase 3**, in `apps/web`
  alone: `vite` 8, `react` and `react-dom` 19, `pixi.js` 8. `pnpm dev` serves
  the viewer and `pnpm build:web` writes it as a static page to
  `apps/web/dist`, relative paths throughout, so it can be posted anywhere.
  The page imports `pixi.js/unsafe-eval` once, which lets PixiJS run under a
  content security policy that forbids `eval`.
- **`delaunator` is the first runtime dependency**, in `@adventure/mapgen`
  alone, for §2.1 step 2. A correct incremental Delaunay is a great deal of
  subtle floating-point geometry, and this is the smallest well-tested
  implementation of it; its output is a deterministic function of the point
  list, which is what §1.3 needs. The edge list it produces is sorted into
  `(a, b)` order before anything downstream sees it, so no later step depends
  on the library's internal triangle ordering either.
- **No linter or formatter, for now.** Not a design question; a contributor one.
  `strict` plus `noUncheckedIndexedAccess` plus `exactOptionalPropertyTypes` is
  already doing the load-bearing work, and a formatter diff across every file
  would bury the first real implementation PR under whitespace. Revisit once
  the engine has code in it rather than seams.

## 4. Where the CPU lives — the decision that actually matters

Two components are CPU-bound, and they are very different:

| Component | Cost | Where it should run |
|---|---|---|
| Map generation | Once per game. **Measured in phase 1: ~200 ms per map**, one attempt, over 40 seeds (`pnpm map:batch 40` → 7.8 s). The estimate held: Delaunay and flood fill are trivial at 240 nodes and the remoteness pass dominates — `REMOTENESS_SIMULATION_RUNS` (100) walks × ~60 legs, each leg a partial Dijkstra over 240 nodes. No seed has yet needed a second attempt. | **Decided (§12.1): the game master's machine.** |
| MCTS | 10 s of CPU **per AI move** (§9). A 60-turn game with two AI players is on the order of 20 CPU-minutes. | **Decided (§12.1): the game master's machine**, in a Web Worker. |

Because generation is deterministic in `(seed, ruleset)`, a store only ever has
to persist the seed — the map can be regenerated on load instead of serialised.
That is worth taking advantage of whatever the host.

---

## 5. Durable Objects — the decision, and what it costs

**Confirmed: DO for the session layer, GM's machine for map generation and AI.**
That is the split this document argued for, with one change — the compute does
not go to a second service, it goes to the game master's browser.

### What the DO gives us

- **One DO per `gameId` is exactly the concurrency model `GameSession` already
  assumes.** Single-writer, strongly consistent, no locking, no external
  coordination. This is the part of multiplayer backends that is usually fiddly,
  and it comes for free.
- **WebSocket Hibernation suits a turn-based game unusually well.** Players in a
  2–5 player game idle for minutes; hibernation means idle games cost
  approximately nothing while keeping connections open.
- **Transactional storage is co-located** with the object that owns the state,
  so `GameStore` is a thin adapter with no cache-coherency question. §12.3 makes
  the message board part of that same state, so it needs no storage of its own.

### What moving compute to the GM's machine gives us

- **The CPU objection disappears entirely.** A 10-second MCTS search never runs
  in the DO, so it can neither block that game's other messages nor accrue
  Workers CPU billing. Map generation likewise.
- `AiPlayer.chooseAction` was already async and behind a port, so the session
  core is unchanged by this. The DO adapter implements `MapService` and
  `AiService` as round trips to the GM's client (`gm.requestMapGeneration` /
  `gm.mapGenerated`, `gm.requestAiMove` / `gm.aiMove`).

### What it costs

- **The game master's machine is now a hard dependency for progress**, not just
  for GM controls. §12.4 accepts the stall for forced turns; §12.1 widens it —
  with AI on the GM's machine, a disconnected GM also blocks every AI turn and
  map creation. An all-AI game cannot advance without the GM online. That is the
  two answers composed, and worth stating plainly because it is stronger than
  either alone.
- **MCTS must not run on the GM's UI thread.** 10 s × the number of AI seats,
  each turn, in the browser. A Web Worker is not optional here.
- **AI strength now varies with the GM's hardware.** A fixed 10-second budget
  buys very different search on a laptop than on a workstation, so AI difficulty
  is not reproducible across games. If that matters, the budget could be
  expressed in rollouts rather than seconds — a design question, not mine to
  decide.
- **Trust.** The GM's client computes AI moves and the map; the DO takes them on
  faith. Fine for a friendly game, worth knowing before any competitive use.

### If DO turns out not to fit

The swap is an adapter. `packages/session` imports no transport, storage, socket
or timer, and the in-memory adapters in `apps/server/src/adapters/memory.ts`
exist to keep proving that. The nearest alternative remains a single long-lived
Node service with an in-process queue keyed by `gameId` — same single-writer
property, one deployment, no hibernation saving.

## 6. Summary — decided, and still to confirm

| Choice | My recommendation | Reversibility |
|---|---|---|
| Language | TypeScript, one shared engine | Hard to reverse — decide deliberately |
| Client map rendering | PixiJS (canvas/WebGL) | Easy — behind `MapRenderer` |
| Client chrome | React + Vite | Easy |
| Delaunay | `delaunator` | Easy — one step |
| Session host | **Decided: Durable Objects, one per game** | Easy — adapter only |
| Map generation + AI host | **Decided: the game master's machine** | Easy — behind `MapService` / `AiService` |
| MCTS off the GM's UI thread | Web Worker | Easy |
| AI budget in seconds vs. rollouts | Seconds, per §11 — but it makes AI strength hardware-dependent | Config |
