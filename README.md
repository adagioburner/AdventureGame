# Adventure Game

A multiplayer turn-based adventure game: procedural map generation, turn-based
movement and combat resolution, MCTS-driven AI players, a web client, and a
lightweight multiplayer backend.

**[`GDD.md`](./GDD.md) is the single source of truth.** Every statement in it
carries a provenance tag — `[SOURCE §x]`, `[SOURCE §x, chat]`,
`[SOURCE §x, review]`, `[INFERRED §x]`, `[OPEN]` — and the same discipline
applies to this repo:

- If GDD.md doesn't say it, it isn't decided. That covers gameplay rules,
  balancing numbers and UI behaviour, not just the items listed in §12.
- `[OPEN]` items are not resolved by picking something reasonable. They are
  either clearly-marked swappable seams with no default, or questions put to the
  designer. All of them are registered in
  [`docs/OPEN_QUESTIONS.md`](./docs/OPEN_QUESTIONS.md).
- Nothing in GDD.md gets "improved". Stated formulas, rules and constants are
  transcribed as-is — including the ones that look like starting points
  (`REMOTENESS_WEIGHT = 4`, `COMPACTNESS_MAX = 25`): they are values the
  designer intends to tune, not placeholders.
- Every constant in §11's table lives in `@adventure/config`, never inline.

## Status

**Map generation and the rules engine work.** `generateMap(seed, ruleset)` runs
GDD.md §2.1's eight steps end to end and returns a sealed `GameMap`, and
`applyAction(state, action, dice)` plays §7 and §8's turns on it —
`pnpm map <seed>` draws a map, `pnpm game <seed>` plays one to a winner and
prints the game turn by turn. That is phases 1 and 2 of
[`docs/IMPLEMENTATION_PLAN.md`](./docs/IMPLEMENTATION_PLAN.md), on top of phase
0's test harness. The UI (§7.1), the MCTS search loop (§9) and the server
(§6.1) are still seams.

Two design questions are open, neither blocking: [Q27](./docs/OPEN_QUESTIONS.md)
— `COMPACTNESS_MAX` never binds on a graph this sparse, so §2.1's Smooth step
currently does nothing — and [Q30](./docs/OPEN_QUESTIONS.md), turned up by phase
2: §1 ends a game only through a decisive gold lead, so a position where the
gold that is left sits behind guards nobody can beat has no ending at all. The
config's `pending` block is empty. The §12 decisions: Durable Objects for the
session layer with map generation and AI on the game master's machine (§12.1),
UCT over the 10 closest unclaimed POIs (§12.2), the message board as ordinary
game state (§12.3), and no fallback for a disconnected game master — the game
stalls (§12.4). Unfinished seams throw `NotImplementedError` carrying the GDD
section to implement against; unmade *design* decisions throw
`UnresolvedDesignError` instead, and have no defaults to fall back on.

## Documents

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Component breakdown, data models, layering |
| [`docs/STACK.md`](./docs/STACK.md) | Tech-stack recommendation (unconfirmed), incl. a verdict on Durable Objects |
| [`docs/OPEN_QUESTIONS.md`](./docs/OPEN_QUESTIONS.md) | Every open item, how it was routed around, and the questions outstanding |
| [`docs/IMPLEMENTATION_PLAN.md`](./docs/IMPLEMENTATION_PLAN.md) | The phased build order, what lands in each phase, and how each is tested |

## Layout

```
packages/
  config/     GDD §11 parameters, §4.2 content tables, engineering knobs. No deps.
  core/       Domain model + rules engine. Pure; no I/O, clock or Math.random.
  mapgen/     GDD §2.1's eight-step pipeline, §4.3 assignment, §5.2 guards.
  sim/        The one random-walk implementation, shared by §5.1 and §9.
  ai/         MCTS. Rollout, evaluator and tree policy are seams, all decided.
  protocol/   Client/server wire contract and the auth port. Plain data.
  session/    Turn sequencing, authority, setup flow. Eight ports, no runtime deps.
apps/
  web/        Client: isometric renderer, interaction, online + hotseat modes.
  server/     Composition root and host adapters.
tools/
  balance/    Headless balancing harness (GDD §1.3 names it as a reason for
              seed reproducibility), the `pnpm map` and `pnpm game` CLIs, the
              diagnostic SVG, and the playthrough driver that exercises the
              rules engine end to end. Nothing here ships to a player.
Art/          Art and its atlases. Reference only — nothing in the repo reads
              it yet, and icon mapping is out of scope until phase 3.
              `Art/tools/make_placeholders.py` regenerates the stand-in sheets
              that were produced rather than supplied; their atlases carry
              `"placeholder": true`.
              `Art/tools/make_portrait_crops.py` re-derives the temporary
              head-and-shoulders boxes in `player_avatars_portraits.json`,
              which stand in until the real avatar set arrives.
```

## Working on it

```sh
pnpm install              # once; installs the pinned TypeScript and Vitest
pnpm run typecheck        # tsc --noEmit across every package
pnpm test                 # vitest run
pnpm run test:watch       # the same, watching
pnpm run test:update-golden

pnpm map adventure        # one map: a report, and out/maps/adventure.svg
pnpm map adventure --json # ... and the sealed GameMap beside it
pnpm map                  # a random seed, printed first so it can be reused
pnpm map:batch 50         # 50 seeds, the §11 distributions, no files

pnpm game adventure       # play one map to a winner, turn by turn
pnpm game                 # a random seed, printed first so it can be reused
```

`pnpm-lock.yaml` pins the compiler, and `packageManager` in `package.json` pins
pnpm itself, so local and CI run the same tools.

Tests sit beside the module they cover as `*.test.ts`; golden files live in
`golden/`, whose README explains when updating one is legitimate.

**CI** (`.github/workflows/ci.yml`) runs two jobs, Typecheck and Test, on every
pull request and on every push to `main`. It installs with `--frozen-lockfile`,
so a dependency change that isn't reflected in the lockfile fails the build
rather than being silently applied.

`pnpm run typecheck` is two programs, not one: `tsconfig.json` covers
`packages/` and `apps/`, and `tools/tsconfig.json` covers `tools/`. Only the
second has Node's globals (`process`, `console`, `node:fs`), because only
`tools/` runs on Node and nowhere else — the engine packages run in a browser
too, and nothing in them may quietly depend on a Node API.

The engine packages have one *runtime* dependency: `delaunator`, for §2.1 step
2's triangulation, in `@adventure/mapgen` alone. Everything else is still
devDependencies. See `docs/STACK.md`.

## Looking at a generated map

**Without a clone**, ask for the seeds you want in the project thread: the
plates come back as attachments or as one page you can page through, with each
map's §11 reading beside it. `golden/maps/adventure.txt` is also committed, so
it renders on GitHub — the golden map as text, one record per line. Neither
needs anything installed. See §2.0 of [the implementation
plan](docs/IMPLEMENTATION_PLAN.md).

**With a clone:**

```sh
pnpm map adventure
```

prints a report — node, edge and leaf counts, terrain shares and compactness
both after Smooth and after Carve Valleys, remoteness and guard-strength
histograms — and writes `out/maps/adventure.svg`, whose absolute path is the
**last** line, ready to paste into a browser. `out/` is gitignored.

### Watching a game

`pnpm game adventure` plays one to a winner and prints it a turn at a time —
what was walked, what it cost, and every guard roll with the skill added to it
and the strength it was compared against. Without a clone,
`golden/games/adventure-2p.txt` is the same thing, committed, so it renders on
GitHub. The players are driven by a deliberately dumb rule (walk to the nearest
POI you could take), not by an AI: §9's player is phase 5.

That map drawing is a **developer diagnostic and never becomes the game's map**. It
is top-down, and it deliberately shows the generator's internals — remoteness
above all, which decides §4.3's rewards and §5.2's guards and which a player
must never see. It is written by `tools/balance`, never by `apps/web`, so it
cannot drift into the client.

The map players look at is the isometric view, `pnpm dev`, and it arrives in
phase 3. The two are different drawings of the same `GameMap` and are not meant
to look alike; see
[`docs/ARCHITECTURE.md` §9](docs/ARCHITECTURE.md#9-client--ui-layer-7).

`pnpm map:batch 50` runs the same generation over 50 seeds and prints the §11
distributions with no per-map files — that is the check on `COMPACTNESS_MAX`,
`REMOTENESS_WEIGHT` and their neighbours.
