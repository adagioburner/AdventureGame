# Open items routed around in the architecture pass

Every unresolved item that actually shaped a decision in the code, what I did
about it, and where the seam lives. Two categories:

- **Routed around** — the architecture stays coherent without an answer. There
  is a named interface or a `pending` config entry, it has *no default*, and
  reading it throws with a GDD reference attached.
- **Asking** — I could not proceed honestly without you, or I found a gap or a
  discrepancy that isn't in GDD.md §12 and that you should see.

Nothing below was resolved by picking something reasonable.

**Answered so far:** Q1, Q2 and Q12 are settled and implemented. Q3–Q11, Q13 and
the new Q2a (does guard strength round?) are outstanding.

---

## A. The four known open items (GDD.md §12)

| # | Item | How it's routed | Where |
|---|---|---|---|
| §12.1 | Hosting / infrastructure | Session layer has **zero** runtime dependencies — no transport, storage, socket or timer. Six ports (`GameStore`, `Broadcaster`, `Clock`, `MapService`, `AiService`, `DiceService`) plus two policy ports. In-memory adapters exist to prove the ports are sufficient; a Durable Objects adapter is a documented placeholder that imports nothing Cloudflare-specific. My recommendation, for you to confirm or reject, is in `STACK.md`. | `packages/session/src/ports.ts`, `apps/server/src/adapters/` |
| §12.2 | MCTS tree/selection policy | `TreePolicy` is an interface with `select` + `bestChild`; UCT, PUCT, ε-greedy, RAVE and a flat bandit all fit it unchanged, so the interface commits to nothing. **No implementation ships.** Matching config hole is `pending.MCTS_TREE_POLICY`. See also Q10 — the tree's *action enumeration* is a second hole in the same place. | `packages/ai/src/types.ts`, `packages/config/src/defaults.ts` |
| §12.3 | Message board persistence/scope | `MessageBoardStore` port with `post`/`recent` and **no `scope` parameter** — per-game vs. cross-game is invisible to every caller, so either answer is an adapter. Retention lives only in the adapter. `BoardPost` carries `gameId` so a per-game board needs no schema change. | `packages/session/src/ports.ts`, `packages/protocol/src/messageboard.ts` |
| §12.4 | Game master disconnects | `GameMasterAbsencePolicy` port, consulted on every GM-only path, with no implementation — so the default behaviour is a loud failure, not an invented rule. Deliberately offers **no** `transferGameMaster` method, since §6.1 says the role cannot be transferred in v1 and I didn't want the obvious wrong fix to be one keystroke away. | `packages/session/src/ports.ts` |

---

## B. Questions — I need an answer before these can be written

### Q1. ~~What exactly is a POI's per-walk remoteness score?~~ — **answered, implemented**

[SOURCE §5.1, chat] "A POI's score is the sum of the length of the segment that
lead to it during the walk, and the segment that lead out of it. For the first
POI it's double the length of the first segment, and for the last one it's double
the length of the last segment."

Implemented as `segmentSumRemotenessScorer()`. For POIs `P1 … Pn` over segments
`s1 … sn`, where `si` is the leg that arrived at `Pi`:

```
score(P1) = 2 × s1
score(Pi) = si + s(i+1)    for 1 < i < n
score(Pn) = 2 × sn
```

Summed across all `REMOTENESS_SIMULATION_RUNS` walks, then min-max normalised.
Sum vs. mean doesn't matter — they differ by a constant and normalisation is
invariant under it.

This changed the `RemotenessScorer` interface: it now has `beginWalk` /
`endWalk`, since "first POI" and "last POI" are only meaningful against walk
boundaries.

**One wrinkle, flagged not resolved.** "Double the length of the first segment"
is implemented literally as `2 × s1`, where `s1` is the leg in from the random
plains start. It could instead have meant the first *inter-POI* segment
(`P1 → P2`), discarding the start leg — which would make both boundary cases
symmetric ("missing one neighbour, so double the one you have"), whereas the
literal reading has `P1` ignore a real outgoing segment. The two differ only in
the first POI's score, so roughly 1–2% of a POI's total over 100 runs. Cheap to
switch: it's the `i === 0` branch in `packages/sim/src/remoteness.ts`.

### Q2. ~~How does §5.2's proportionality become a guard strength?~~ — **answered, implemented**

[SOURCE §5.2, chat] "Proceed with the following formula for the guard strength:
`amount_of_gold * GOLD_WEIGHT - remoteness * REMOTENESS_WEIGHT`, capped between
0 and 10. Set `GOLD_WEIGHT = 3` (to be fine tuned later)."

Implemented as `guardStrengthFor()`. `GOLD_WEIGHT` is a new config row — added
by the designer, so it sits in `GameConfig.balancing` alongside §11's own rows,
not in `EngineeringConfig`.

Two knock-on changes this answer makes to earlier text, recorded rather than
re-decided:

- **`GUARD_STRENGTH` is now 0–10, not §11's 2–10.** The cap was given as "0 and
  10", and 0 is meaningful: it is what "1 gold with maximum remoteness is
  unguarded" produces (`1×3 − 1×4 = −1`, capped to 0).
- **§4.4's "every gold POI is guarded, none are exempt" no longer holds.** Any
  POI whose formula result caps at 0 is unguarded. The data model already allows
  `guard: null`, so nothing structural changes.

The engine still never inspects the reward kind — §4.4 requires guarding to work
on any kind, so the formula reads the POI's reward `units`. For v1 content the
two coincide, because the §4.2 table only guards gold.

What the current constants do, as an observation for tuning rather than a
recommendation:

| gold | r=0 | r=0.25 | r=0.5 | r=0.75 | r=1 |
|---|---|---|---|---|---|
| 1 | 3 | 2 | 1 | 0 | 0 |
| 2 | 6 | 5 | 4 | 3 | 2 |
| 3 | 9 | 8 | 7 | 6 | 5 |
| 4 | 10 | 10 | 10 | 9 | 8 |
| ≥5 | 10 | 10 | 10 | 10 | 10 |

So remoteness stops discounting the guard once a stack reaches 5 gold. Reachable
stacks per §4.2 row are 1–9 (plains), 1–2 (forest), 1–11 (mountain/fighting),
1–6 (mountain/magic), so the plains and mountain rows can produce POIs pinned at
the cap.

### Q2a. Is guard strength rounded? (§5.2, §4.4)

Small leftover from Q2. Remoteness is continuous in [0, 1], so the formula gives
continuous results — 1 gold at remoteness 0.4 is guard 1.4. The cap was
specified but no rounding rule was.

§8's `roll + skill > guard_strength` works either way; what is affected is the
number §4.4 shows beside the node ("a red number ... indicating guard strength").
Round, floor, ceil, or display to one decimal?

**Routed as:** implemented exactly as specified — continuous, capped — so
nothing is invented. Adding rounding later is one line in `guardStrengthFor()`.

### Q3. What exactly is "a tie for the win"? (§1)

"A player wins once their gold lead over every other player exceeds the amount
of gold still unclaimed; a tie for the win results in shared victory."

Under a literal reading the two clauses can't both hold: if two players are tied
at the top, each one's lead over the other is 0, which never exceeds a
non-negative remaining amount — so a tie for the win could never arise. It only
works if tied leaders are evaluated as a *bloc* against the best other player.
That's the reading I'd expect you mean, but it's a reading, so I haven't written it.

Secondary: under the bloc reading, two tied leaders could be declared joint
winners while unclaimed gold remains that would have broken the tie. Intended?

**Routed as:** `checkVictory()` throws with this note attached.
`packages/core/src/rules/victory.ts`

### Q4. What do "boundary" and "area" count in `compactness = boundary² / area`? (§2.1 step 5)

Your circle reference (4π ≈ 13) is only reproduced by counting **nodes** for
both: a unit-density disc has πr² nodes and 2πr boundary nodes → 4π. Counting
boundary *edges* on a Delaunay mesh lands several times higher, which would put
`COMPACTNESS_MAX = 25` out of reach.

That derivation is strong enough that I'm fairly confident, but since the whole
Smooth loop terminates on it — and `COMPACTNESS_MAX` is a number you intend to
tune against it — I'd rather you confirm than have me assume.

**Routed as:** `compactness()` implements the formula verbatim; `regionMetrics()`,
which decides the counting convention, throws. `packages/core/src/graph.ts`

### Q5. `stamina` is a reward kind in §4.1 but appears in no row of §4.2

Six of the seven kinds appear in the reward table; stamina doesn't, so v1 places
no stamina rewards on any map. Deliberate (the white-heart icon exists for a
later version), or an omission from the table?

If it was meant to be there, note it also changes the POI-count columns, since
they currently sum exactly to 25/20/15.

**Routed as:** the engine supports the kind fully; only the content table omits
it, so adding a row later is a config edit. `packages/config/src/content.ts`

### Q6. When does an MCTS rollout stop, and what do the other players do during it? (§9)

§9 gives the rollout policy and the backpropagated value ("gold after rollout")
but not the terminal condition — fixed turn horizon, all POIs claimed, the §1 win
condition firing, something else. It also doesn't say how the non-simulated seats
behave during a rollout, and "the simulated player's gold" only means something
relative to what the opponents did.

Both choices affect what MCTS optimises *and* how many rollouts fit in the
10-second budget, so they're not incidental.

**Routed as:** `RolloutTermination` and `OpponentRolloutPolicy` are injected,
with no defaults. `packages/sim/src/rollout.ts`

### Q7. How much jitter in the edge-pruning order? (§2.1 step 3)

"Remove edges longest-first, with jitter" — the magnitude isn't given, and it's
the knob that controls how grid-like the road network looks. It isn't in §11's
table either, so I haven't invented a row for it.

**Routed as:** `pending.EDGE_PRUNE_JITTER` (throws on read), passed into step 3.

### Q8. What procedure gives POIs "approximately equal distances"? (§3)

That names a goal, not a method. Farthest-point sampling and graph-space
Poisson-disc both satisfy the phrase and give visibly different maps. Happy to
implement whichever you prefer, or to prototype both against the balancing
harness if you'd rather decide from pictures.

**Routed as:** `PoiPlacementStrategy` seam, no default.
`packages/mapgen/src/steps/7-place-pois.ts`

### Q9. What gives when a terrain has more leaf nodes than its POI quota? (§3 vs §11)

Every leaf must be a POI, leaf count is 30–45, and per-terrain POI counts are
fixed at 25/20/15. Nothing distributes leaves across terrains in those
proportions — a legal map can put 17 leaves in the mountains, exceeding the
mountain quota of 15. Unlikely per map, near-certain across a few thousand.

Options I can see: regenerate the map, let the quota flex, or move the excess
quota between terrains. Each is a different design statement.

**Routed as:** currently throws `GenerationRejected('poi_quota_unsatisfiable')`,
i.e. regenerate — the only option that breaks neither stated rule. But note §2.1
step 8 lists exactly two rejection reasons, so this is an addition to the spec
and I'd rather you chose it than inherited it.

### Q10. The tree policy also needs an action enumeration (§12.2)

Flagging that §12.2 is slightly bigger than it looks. Selection is one hole; the
other is what the tree *branches over*. The legal action set at a node is "rest,
or move along any path", which is far too wide to expand directly, and §9's
rollout policy (random target among the K closest POIs) is explicitly a *rollout*
policy, not necessarily the tree's. Whatever answers §12.2 will probably answer
this at the same time — I just didn't want it to surface later as a surprise.

**Routed as:** `ActionEnumerator` interface, no default.
`packages/ai/src/types.ts`

### Q11. In the planned hybrid evaluator, what is "number of skills"? (§9)

`average(gold after simulation, gold now + (number of skills) × balancing_constant)`
— is "number of skills" the sum of the five skill levels, or a count of how many
are non-zero? They diverge sharply once a player stacks one skill. And
`balancing_constant` has no value and isn't in §11.

Low priority — it's a future experiment, not v1 — but the seam is built for it
now so the swap stays a one-liner.

**Routed as:** `hybridGoldAndSkillsEvaluator(balancingConstant)` exists as a
named seam and throws. `packages/ai/src/policies/evaluators.ts`

### Q12. ~~Where do players start on the map?~~ — **answered, implemented**

[SOURCE §6, chat] "The players start at a random spot of the plains that is not
a POI. All players start from the same spot."

Implemented as `chooseStartingNode(map, rng)` in `@adventure/core` — uniform over
plains nodes that hold no POI, one node shared by every seat. Several players on
one node is already unrestricted (§8), so nothing special was needed to let them
all stand there.

Its `Rng` is derived from the map seed rather than an ambient one, so the
starting node replays from `(seed, params)` along with the map itself.
`SetupFlow.start()` is no longer blocked.

### Q13. Is a zero-length move a legal action? (§7 vs §8)

§8 says a player may "remain stationed on the node", which for a failed guarded
POI implies re-attempting it without moving. §7 defines a turn as move-then-
interact, or rest. So is "stay put and re-roll" expressed as a move with an empty
path, and does interaction then re-trigger?

Minor, but it changes the action space the AI searches, so it's cheaper to settle
now than after MCTS is written.

**Routed as:** `MoveAction.path` permits an empty array; nothing yet depends on
what that means. `packages/core/src/action.ts`

---

## C. Decisions I made that are *implementation*, not design

Listed so you can veto any that read as design to you.

| Decision | Why it isn't a design call |
|---|---|
| `MAX_GENERATION_ATTEMPTS = 50` | §2.1 says "regenerate" with no bound; an unbounded loop hangs. Lives in `EngineeringConfig`, never merged into `GameConfig`. |
| Separate server-side die stream from the public map seed | §1's no-hidden-information is about map, POIs and rewards, all of which clients get in full. A shared seed would let a client precompute rolls. |
| Seats allocated in GM acceptance order | §6 explicitly delegates this: "whatever is most convenient to implement — expected default: order the game master accepts join requests". |
| `PlayerStats` typed as `Record<RewardKind, number>` | §6's seven stats are exactly §4.1's seven kinds. Typing them as one thing makes claiming a reward a single addition and stops the lists drifting. |
| Remoteness computed inside step 7, between POI placement and reward assignment | Forced by data flow: §4.3 step 3 consumes remoteness, and remoteness depends only on POI positions. |
| sfc32 PRNG, string seeds | §1.3 requires reproducibility, not a specific algorithm. |
| `Poi.artVariant` as an opaque stable index | §3 says a POI has an image; what the index means is left entirely to a later art-binding decision. Nothing reads `Art/`. |
