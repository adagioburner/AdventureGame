# Tech stack — a recommendation for you to confirm

Hosting and infrastructure are explicitly open (GDD.md §12.1), so **nothing here
is a committed choice.** The code is written so that every item below can change
without a rewrite: the engine packages import no runtime APIs, and the session
layer reaches the outside world only through `SessionPorts`.

What follows is what I'd pick, and why, plus a straight answer on Durable Objects.

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
path-mapped `@adventure/*` imports, one `npm run typecheck` over everything.
Engine packages carry **zero runtime dependencies**, which matters for
determinism as much as portability — fewer places for a library update to change
a generated map.

The one library I'd add: `delaunator` for §2.1 step 2. Delaunay is a solved
problem and a hand-rolled version is a determinism risk, not a feature.
Poisson-disc sampling (step 1) is a dozen lines and stays in-repo.

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

## 4. Where the CPU lives — the decision that actually matters

Two components are CPU-bound, and they are very different:

| Component | Cost | Where it should run |
|---|---|---|
| Map generation | Once per game. Delaunay and flood fill are trivial at 240 nodes; the remoteness pass dominates — `REMOTENESS_SIMULATION_RUNS` (100) walks × ~60 legs, each leg a partial Dijkstra over 240 nodes, so order 6,000 small searches, times the retry count. Likely tens to a few hundred ms. **Measure it before assuming.** | Fine almost anywhere, including inside a session actor. |
| MCTS | 10 s of CPU **per AI move** (§9). A 60-turn game with two AI players is on the order of 20 CPU-minutes. | Must be off the request path and off any actor that also serves players. |

Because generation is deterministic in `(seed, ruleset)`, a store only ever has
to persist the seed — the map can be regenerated on load instead of serialised.
That is worth taking advantage of whatever the host.

---

## 5. Cloudflare Durable Objects — split verdict

**Yes for the session layer. No for the AI.** In more detail:

### Where it fits well

- **One DO per `gameId` gives exactly the concurrency model `GameSession`
  already assumes.** Single-writer, strongly consistent, no locking, no external
  coordination. This is the single best structural argument for DOs here, and
  it's a real one — it's the part of multiplayer backends that is usually fiddly,
  and it comes for free.
- **WebSocket Hibernation suits a turn-based game unusually well.** Players in a
  2–5 player turn-based game idle for minutes at a time. Hibernation means idle
  games cost approximately nothing while keeping connections open, which is
  precisely the wrong-shaped workload for a conventional always-on server
  process.
- **Transactional storage is co-located** with the object that owns the state,
  so `GameStore` is a thin adapter and there's no cache-coherency question.
- **Message board (§12.3) fits either answer.** Per-game → DO storage. Cross-game
  → a D1 or KV binding. The `MessageBoardStore` port hides which, so this choice
  doesn't have to be made now.
- Global placement near the game's creator is a genuine latency win for a game
  whose players may be scattered.

### Where it doesn't fit

- **A DO is single-threaded.** Running a 10-second MCTS search inside the game's
  own DO would block every other message for that game for ten seconds —
  including the message board and, worse, §7.1's out-of-turn planning, which is
  specifically the feature that lets other players do something useful while
  someone else is thinking. The AI turn would freeze the one thing designed to
  make waiting bearable.
- **Workers bill by CPU time**, and 10 CPU-seconds per AI move is a lot of it.
  Even where the per-invocation CPU ceiling is configurable upward on paid plans,
  sustained CPU-bound compute is against the grain of an edge runtime — this is a
  pricing-model mismatch, not just a limit to raise.
- **The balancing harness wants a plain process.** Thousands of maps and
  self-play batches belong in Node on a workstation or in CI, not on workerd.
  (This costs nothing today, because the engine packages are runtime-neutral.)

### What I'd actually propose

- Session, lobby, setup, turn sequencing, message board → **Durable Objects**,
  one per game, with the Hibernation API.
- `AiService` → a **separate compute home**: Cloudflare Containers if you want to
  stay on one platform, or a small Node service (or queue worker) elsewhere. The
  DO calls it and awaits a `TurnAction`; `AiPlayer` is already async precisely
  for this.
- `MapService` → either, once measured. Simplest is in the DO at game start.
- Auth → Workers has WebCrypto, so PBKDF2 password hashing is available natively;
  argon2/bcrypt would need WASM. Worth knowing before committing, though
  `AuthProvider` makes it swappable either way.

**If you'd rather not split the deployment**, the honest alternative is a single
long-lived Node service with an in-process queue keyed by `gameId` (same
single-writer property, by construction) and a worker thread pool for MCTS. It
is less elegant at idle, cheaper to reason about, and one deployment instead of
two. Given AI players are a headline feature rather than an afterthought, this
is a defensible first choice — and the ports mean starting here and moving to
DOs later is an adapter, not a rewrite.

### What I'd want measured before you commit either way

1. Wall-clock map generation for one map, and at `REMOTENESS_SIMULATION_RUNS`
   of 50 / 100 / 200 — this also answers §5.1's own "if 100 proves too slow".
2. Rollouts per second in TypeScript, to see what 10 seconds actually buys once
   a tree policy exists (§12.2).
3. Serialised `GameState` size, to confirm seed-only persistence is worth it.

---

## 6. Summary of what I'm asking you to confirm

| Choice | My recommendation | Reversibility |
|---|---|---|
| Language | TypeScript, one shared engine | Hard to reverse — decide deliberately |
| Client map rendering | PixiJS (canvas/WebGL) | Easy — behind `MapRenderer` |
| Client chrome | React + Vite | Easy |
| Delaunay | `delaunator` | Easy — one step |
| Session host | Durable Objects, one per game | Easy — adapter only |
| AI compute host | Separate from the session host | Easy — behind `AiService` |
| Single-service alternative | Node + per-game queue + worker threads | Easy — adapter only |
