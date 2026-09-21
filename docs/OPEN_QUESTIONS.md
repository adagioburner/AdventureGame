# Open items routed around in the architecture pass

Every unresolved item that actually shaped a decision in the code, what I did
about it, and where the seam lives. Two categories:

- **Routed around** — the architecture stays coherent without an answer. There
  is a named interface or a `pending` config entry, it has *no default*, and
  reading it throws with a GDD reference attached.
- **Asking** — I could not proceed honestly without you, or I found a gap or a
  discrepancy that isn't in GDD.md §12 and that you should see.

Nothing below was resolved by picking something reasonable.

**Answered so far:** all four of GDD.md §12's own open items, and Q1–Q17.
`pending` in the config is empty.

**Outstanding: one unconfirmed reading.** Q13 and Q17, both previously held open
for confirmation, are now confirmed. What remains is the wrinkle under Q1, which
has not been answered: whether "double the length of the first segment" means
the leg in from the random plains start (implemented) or the first inter-POI
segment. It moves only the first POI's score — roughly 1–2% of a POI's total
over 100 runs — and it is the `i === 0` branch in
`packages/sim/src/remoteness.ts`.

Everything else is settled and the config's `pending` block is empty, so the
next session's work is implementation against a settled spec rather than more
design review. `docs/ARCHITECTURE.md` §11 lists what to pick up and in what
order.

---

## A. The four known open items (GDD.md §12) — **all answered**

| # | Decision | What it changed in the code |
|---|---|---|
| §12.1 | [SOURCE, chat] "Durable Objects, with flexible architecture to swap it for something else if DO don't fit the bill. Everything else, i.e. map generation and player AI, runs on the game master's machine." | The DO becomes one adapter behind `SessionPorts`; `packages/session` still imports no transport, storage, socket or timer, so the swap stays an adapter. `MapService` and `AiService` keep their interfaces but the DO implements them as **round trips to the GM's client** (`gm.requestMapGeneration`/`gm.mapGenerated`, `gm.requestAiMove`/`gm.aiMove`). See `docs/STACK.md` for what the choice costs. |
| §12.2 | [SOURCE, chat] `MCTS_NODE_EXPANSION_PRUNING = 10`; branches are the closest unclaimed POIs at that point in the game; "for everything else please use sensible defaults that are recommended for standard MCTS implementations." | `closestUnclaimedPoiEnumerator()` and `uctTreePolicy()` ship as named, swappable defaults. The enumerator calls the same `closestPoiCandidates` as the remoteness walk and the rollout policy — three consumers, one kernel. Two sub-questions remain: Q16, Q17. |
| §12.3 | [SOURCE, chat] "The message board should be part of the game state and as such persistent along with the rest of the game. There is no difference between the message board state and other game state." | `BoardPost` moved into `@adventure/core`; `GameState.messageBoard` holds it; posting is a `PostMessageAction` through `applyAction`, the single writer. `MessageBoardStore` and the `board.posts` message are **deleted** — no store, no retention policy, no separate channel. |
| §12.4 | [SOURCE, chat] "The game cannot proceed for a player that cannot establish connection with the game state server. If the game master disconnects there is no one to force the next turn so the game stalls as well." | `GameMasterAbsencePolicy` **deleted** — there is no fallback to configure. A GM-only request with no GM connected is answered `game_master_unavailable` and the game waits. |

**One consequence of §12.1 and §12.4 together, worth stating because it is
stronger than either alone:** with map generation and MCTS on the game master's
machine, a disconnected GM blocks not just forced turns but every AI turn and
map creation. Even an all-AI game cannot advance while the GM is offline. That
follows from the two answers; it is recorded, not re-opened.

`SessionPorts` is down from eight ports to six as a result.

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

### Q2a. ~~Is guard strength rounded?~~ — **answered, implemented**

[SOURCE §5.2, chat] "Guard strength is rounded up." `Math.ceil` before the cap;
ceiling before or after gives the same answer for every reachable input, since
the cap bounds are integers.

### Q3. ~~What exactly is "a tie for the win"?~~ — **answered, implemented**

[SOURCE §1, chat] "Players can be tied for the win only when there is no more
gold left on the map." That makes §1's two clauses consistent: a lead of 0 can
only win when the threshold it must exceed is also 0.

`checkVictory()` now implements it — one leader wins when
`max − runnerUp > unclaimedGold`; tied leaders share exactly when no gold
remains. Checked against seven worked cases.

### Q4. ~~What do "boundary" and "area" count?~~ — **answered, implemented**

[SOURCE §2.1 step 5, chat] "Yes, counting nodes is the right approach." `area` is
the region's node count, `boundary` the count of its nodes touching another
terrain — the convention that reproduces the stated 4π reference.

### Q4a. ~~Compactness per terrain, or per connected component?~~ — **answered, implemented**

[SOURCE §2.1 step 5, chat] "Compactness is measured per connected component."
`terrainCompactness()` returns one value per component and
`meetsCompactnessTarget()` is the Smooth loop's exit test.

Two properties of the resulting rule, worth having in hand when you tune
`COMPACTNESS_MAX`:

- a **rounded blob sits at ~4π ≈ 13 whatever its size** — area and boundary
  scale as r² and r, so size doesn't move the number, only shape does;
- for any component where every node touches another terrain (thin or small),
  boundary equals area, so **compactness equals the node count**. At 25 that
  tolerates a thin or speckled region of up to 24 nodes, and a single stray node
  scores 1 — passing trivially. Small stragglers are cleared by Smooth's "flip
  isolated nodes" behaviour, not by the threshold.

So 25 leaves roughly 2× headroom over a circle, and its practical meaning is
"thin regions up to 24 nodes are allowed".

### Q5. ~~`stamina` appears in no §4.2 row~~ — **answered**

[SOURCE §4.2, chat] "Proceed now without stamina, add later as a config edit.
One possibility is to have extra leaf nodes filled with stamina rewards." The
§4.2 table is unchanged; stamina's only placement for now is the surplus-leaf
rule of Q9.

### Q6. When does an MCTS rollout stop? — **half answered**

You answered the opponent half: [SOURCE §9, chat] "During MCTS rollout moves are
simulated for all players, AI and human." That removed a whole interface —
`OpponentRolloutPolicy` is deleted, every seat is driven by the one rollout
policy, and `subject` now only says whose gold is read at the end.

**To answer your question back:** that was half of it. The other half was *when
the rollout stops* — a fixed turn horizon, all POIs claimed, the win condition
firing, or something else. Your §12.2 instruction to use standard MCTS defaults
covers it: standard rollouts play to a terminal state, and with Q3 answered this
game reliably reaches one. So `playToCompletionTermination()` ships as the
default.

Flagging the cost rather than pre-empting it: a full playout over ~60 POIs with
multi-turn journeys is not cheap against a 10-second budget, and if rollouts
prove too slow the usual fix is a turn or depth cap. That changes what the
backpropagated value means, so it stays a config-free seam until you want it.

### Q7. ~~How much jitter in the edge-pruning order?~~ — **answered, implemented**

[SOURCE §2.1 step 3, chat] "We can choose randomly from the longest
EDGE_PRUNE_JITTER = 10 edges." Now a real `MapConfig` row, so `pending` is
**empty** for the first time.

### Q8. ~~What procedure gives POIs "approximately equal distances"?~~ — **answered**

[SOURCE §3, chat] "Let us prototype and choose." `PoiPlacementStrategy` stays a
seam with two implementations to build — farthest-point sampling and graph-space
Poisson-disc — and `tools/balance` compares them on real maps.

### Q9. ~~What gives when a terrain has more leaves than its POI quota?~~ — **answered**

[SOURCE §9, chat] "Fill the extra leaf nodes with stamina rewards." The §4.2
quota is met exactly as written, and surplus leaves become *additional* POIs
outside the table carrying stamina. Consequences, all recorded rather than
re-decided: a map can hold slightly more than 60 POIs; the
`poi_quota_unsatisfiable` rejection is **deleted**, since the case no longer
aborts generation; and these POIs are unguarded, because §4.2 is what decides
guarding and they are not in it.

### Q9a. ~~How many stamina units per surplus leaf?~~ — **answered**

[SOURCE §9a, chat] "One stamina per leaf." `OVERFLOW_LEAF_STAMINA_UNITS = 1`.

On my flag that the total can be zero — a proportional spread of 30–45 leaves
over quotas of 25/20/15 overflows nothing at all — [SOURCE §4.2, chat]: "right
now the configuration for stamina is 0, but we may change the rewards balance
and add a non-zero default number of stamina rewards." So surplus-leaf stamina
is incidental, and the §4.2 table is where stamina arrives properly when the
balance changes.

Worth knowing for that edit: adding a stamina row is a config change but **not a
purely additive one**. Each terrain's `poiCount` column must sum to
`POI_COUNT[terrain]`, so giving stamina POIs means taking them from another kind
on that terrain. `validateRuleset` catches it either way.

### Q10. ~~The tree policy also needs an action enumeration~~ — **answered with §12.2**

Both halves came together as predicted. What the answer did *not* settle became
Q16 and Q17.

### Q11. ~~In the hybrid evaluator, what is "number of skills"?~~ — **answered, implemented**

[SOURCE §9, chat] "The sum of all skill levels" — so fighting 3 + magic 1
contributes 4, not 2. Summed over the five skills (three movement, fighting,
magic); gold is the objective and stamina a resource, so neither counts.

`hybridGoldAndSkillsEvaluator(balancingConstant)` is now fully written. Both
halves are normalised by total map gold per Q14, which keeps the average over
two comparable quantities and puts `balancingConstant` in units of *gold per
skill level* — a natural thing to tune.

### Q12. ~~Where do players start on the map?~~ — **answered, implemented**

[SOURCE §6, chat] "The players start at a random spot of the plains that is not
a POI. All players start from the same spot." `chooseStartingNode(map, rng)`,
with its `Rng` derived from the map seed so the start point replays with the map.

### Q13. ~~Is a zero-length move a legal action?~~ — **answered, confirmed**

[SOURCE §7/§8, chat] "A zero-length move is legal, one can use it to fight the
same guard again", and on the follow-up: "resting means taking no action,
including no interaction with a POI, so it is different."

`MoveAction.path` may be empty, and §8's "remain stationed on the node" is
expressed that way: the turn still ends on the POI, so interaction re-triggers
and the player gets another roll. Rest stays a distinct action with no
interaction, so a player camped on a guarded POI chooses each turn between
another attempt and recovering stamina.

---

## B2. Sub-questions thrown off by the §12 answers

### Q14. ~~UCB1's √2 assumes rewards in [0, 1]~~ — **answered, implemented**

[SOURCE §9, chat] "Yes, we can normalize by dividing over total gold on the
map." Both evaluators divide by `totalGoldUnits(map)`, so every backpropagated
value sits in [0, 1] and √2 is the correct constant. The divisor is gold
*placed*, fixed for the whole game, so values stay comparable across a search.

The two settings are now coupled: changing the normalisation without revisiting
`MCTS_EXPLORATION_CONSTANT` breaks the exploration/exploitation balance. Noted
on both config fields.

### Q15. ~~Regenerate the map per client, or upload it?~~ — **answered**

[SOURCE §12.1, chat] "Both strategies work. Let[']s send the map over to all
players, this is less error prone." `gm.mapGenerated` carries the finished
`GameMap` — which is what the protocol already assumed. Determinism still buys
replay and debugging; it just is not used to save bandwidth.

### Q16. ~~Is "rest" also an MCTS branch?~~ — **answered, implemented**

[SOURCE §12.2, chat] "Rest is a branch as well. Let us prune it if there are at
least MIN_REACHABLE_NODES_FOR_REST = 3 POIs reachable in one turn." Both halves
are in `closestUnclaimedPoiEnumerator`.

One implementation detail worth stating: reachability is counted over the
**pruned** target list, not every POI on the map. A reachable POI outside the
closest 10 is not a branch the search can take, so counting it would let rest be
pruned on the strength of an option that does not exist in the tree.

The reachability test itself is injected (`TurnReachability`) because it needs
`previewPath`, which is not written yet. The rule is.

### Q17. ~~Macro-action or single turn?~~ — **answered, confirmed**

[SOURCE §9, chat] "Selecting a POI is a macro-action during simulation rollout.
The simulated player keeps moving to the chosen POI without making new decision
until it's reached or claimed by a different player." Confirmed on the follow-up
to cover **tree expansion** as well, so a tree edge and a rollout leg mean the
same thing and node values compose.

`macroAdvanceToTarget` ends on exactly three conditions — `arrived`,
`target_claimed_by_other`, `terminal` — with every turn in between going through
`applyAction`, and the other seats taking their own turns as they come. One
macro-action is one tree edge, which keeps the tree shallow enough to search in
ten seconds: a node is a real decision point, not a single step. `search()`
returns only the first turn of the chosen branch, since the session layer
commits one turn at a time.

[SOURCE §9, chat] "The same holds for remoteness calculation." It already did —
§5.1's walk commits to a target and makes no new decision on the way. The one
clause that cannot transfer is "or claimed by a different player": a remoteness
walk has a single walker and no players, and remoteness is a property of the map,
so no game state can cut a leg short.

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
