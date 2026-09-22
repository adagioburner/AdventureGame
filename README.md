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

First architecture pass. Data models, component boundaries and interfaces are in
place and typecheck; gameplay logic, map generation and the MCTS search loop are
deliberately unimplemented.

Every open question raised in this pass is answered — GDD.md §12's four items
and the thirteen gaps found while building against it. The config's `pending`
block is empty. The §12 decisions: Durable Objects for the
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
              seed reproducibility).
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
```

`pnpm-lock.yaml` pins the compiler, and `packageManager` in `package.json` pins
pnpm itself, so local and CI run the same tools.

Tests sit beside the module they cover as `*.test.ts`; golden files live in
`golden/`, whose README explains when updating one is legitimate.

**CI** (`.github/workflows/ci.yml`) runs two jobs, Typecheck and Test, on every
pull request and on every push to `main`. It installs with `--frozen-lockfile`,
so a dependency change that isn't reflected in the lockfile fails the build
rather than being silently applied.

The engine packages still have no *runtime* dependencies — TypeScript and
Vitest are the only devDependencies. More land when the first implementation
pass needs them; see `docs/STACK.md`.

## Looking at a generated map

Nothing generates one yet — `generateMap` throws until phase 1. The two
commands that will produce a map, and which phase each arrives in, are written
down in
[`docs/IMPLEMENTATION_PLAN.md` §2](docs/IMPLEMENTATION_PLAN.md#2-seeing-a-map--what-a-reviewer-types):
`pnpm map <seed>` for the generator's diagnostic SVG, and `pnpm dev` for the
in-game isometric view. They are two different drawings of the same map and are
not meant to look alike.
