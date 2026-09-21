# Adventure Game

A multiplayer turn-based adventure game: procedural map generation, turn-based
movement and combat resolution, MCTS-driven AI players, a web client, and a
lightweight multiplayer backend.

**[`GDD.md`](./GDD.md) is the single source of truth.** Every statement in it
carries a provenance tag — `[SOURCE §x]`, `[SOURCE §x, chat]`, `[INFERRED §x]`,
`[OPEN]` — and the same discipline applies to this repo:

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

## Layout

```
packages/
  config/     GDD §11 parameters, §4.2 content tables, engineering knobs. No deps.
  core/       Domain model + rules engine. Pure; no I/O, clock or Math.random.
  mapgen/     GDD §2.1's eight-step pipeline, §4.3 assignment, §5.2 guards.
  sim/        The one random-walk implementation, shared by §5.1 and §9.
  ai/         MCTS. Rollout and evaluator are seams; tree policy is open (§12.2).
  protocol/   Client/server wire contract and the auth port. Plain data.
  session/    Turn sequencing, authority, setup flow. Eight ports, no runtime deps.
apps/
  web/        Client: isometric renderer, interaction, online + hotseat modes.
  server/     Composition root and host adapters.
tools/
  balance/    Headless balancing harness (GDD §1.3 names it as a reason for
              seed reproducibility).
Art/          Placeholder art. Reference only — nothing in the repo reads it,
              and asset extraction/sizing/icon mapping are out of scope for now.
```

## Working on it

```sh
npm run typecheck     # tsc --noEmit across every package
```

No install is required to typecheck (the workspace has no runtime dependencies
yet). Dependencies land when the first implementation pass needs them — see
`docs/STACK.md`.
