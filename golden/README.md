# Golden files

A golden file is a committed snapshot of the output of something that is an
exact function of its inputs. Generation is one such thing: [SOURCE §1.3] "every
one drawing from a single seeded PRNG so a map is fully reproducible from
`(seed, params)`". So a snapshot taken at a fixed seed is the cheapest possible
regression test, and the loudest alarm if someone reorders a pipeline step or
draws from the PRNG out of turn — either of which changes every downstream draw
without changing any assertion a hand-written test would make.

## The convention

- One file per snapshot, under a subdirectory named after what it covers.
- Text, human-readable, one record per line, so a failing diff is legible in a
  review rather than being an opaque blob.
- Written from a test with Vitest's `toMatchFileSnapshot()`, pointing at a path
  under this directory.
- The seed is part of the golden file's name, never only inside the test.

```ts
await expect(summary).toMatchFileSnapshot('../../../golden/rng/sfc32-seed-adventure.txt');
```

## Updating one

A golden file changing is a *finding*, not a chore. Before updating, know which
of these you are looking at:

1. **A bug.** Fix the code; the golden file was right.
2. **An intended change** to an algorithm or a constant. Update the file, and
   say in the commit message what moved and why.

To update, once you have decided it is case 2:

```sh
pnpm run test:update-golden
```

Then read the diff before committing it.

## What is snapshotted today

- `rng/` — the raw PRNG stream. This is the foundation every other snapshot
  rests on: if `sfc32-seed-adventure.txt` moves, every generated map has moved
  too, and no other golden file's diff means anything until this one is
  explained.

Map summaries join this directory in phase 1, when `generateMap` stops throwing
`NotImplementedError` — see `docs/IMPLEMENTATION_PLAN.md`.
