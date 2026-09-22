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
- `maps/` — a whole generated map, as text: one line per node, per edge and per
  POI, with each POI's reward, group, guard and remoteness. Written by
  `tools/balance/src/golden.test.ts` through `formatMapSummary`, the same
  record format the harness prints.
- `games/` — a whole game played through the rules engine, written so every
  number can be checked by hand: one line per step naming the node entered, its
  terrain, and whether a moving skill or stamina paid for it; every guard roll
  with the skill it was added to and the strength it was compared against; and
  every player's stats after every turn. Node ids are the ids the diagnostic
  map (`pnpm map <seed>`) labels every node with, so the two read together. Written by
  `tools/balance/src/playthrough.test.ts`, and printed by `pnpm game <seed>`.
  It is an exact function of the map seed and a *separate* die seed, so a diff
  here with `maps/` unchanged means a rule moved rather than a map.

**Why the map summary and not the SVG.** `pnpm map <seed>` also draws the map,
and committing that drawing would look like the more useful snapshot. It is
not: it would capture the same map a second time, and it would churn on every
cosmetic change to the renderer — a nudged label or a new legend line would
show up as a map diff. The summary moves only when generation moves. The SVG
stays in `out/`, which is gitignored.

**What a map diff usually means.** Generation draws from one stream through all
eight pipeline steps, so a step reordered, a step taking an extra draw, or a
constant changed anywhere ahead of it shifts every number in this file at once.
A diff of a handful of lines is a narrow change; a diff of the whole file is a
change to the stream, and `golden/rng/` will say whether the PRNG itself moved
or whether something upstream in the pipeline is drawing differently.
