# Open items routed around in the architecture pass

Every unresolved item that actually shaped a decision in the code, what I did
about it, and where the seam lives. Two categories:

- **Routed around** — the architecture stays coherent without an answer. There
  is a named interface or a `pending` config entry, it has *no default*, and
  reading it throws with a GDD reference attached.
- **Asking** — I could not proceed honestly without you, or I found a gap or a
  discrepancy that isn't in GDD.md §12 and that you should see.

Nothing below was resolved by picking something reasonable.

**Answered so far:** all four of GDD.md §12's own open items, and Q1–Q25.
`pending` in the config is empty.

**Outstanding: none.** Every question in this register is answered, and so is
every reading that was held open for confirmation — Q1's first-segment wrinkle,
Q13, Q17, and, as of 2026-09-22, Q18's own pick of what "total skills
available" divides by ([Q24](#q24)). The config's `pending` block is empty.

The next session's work is implementation against a settled spec rather than
more design review. `docs/IMPLEMENTATION_PLAN.md` is the build order;
`docs/ARCHITECTURE.md` §11 lists the seams it draws on.

Q20–Q23 came out of writing that plan rather than the architecture pass, and
sit in their own section below.

---

## A. The four known open items (GDD.md §12) — **all answered**

| # | Decision | What it changed in the code |
|---|---|---|
| §12.1 | [SOURCE, chat] "Durable Objects, with flexible architecture to swap it for something else if DO don't fit the bill. Everything else, i.e. map generation and player AI, runs on the game master's machine." | The DO becomes one adapter behind `SessionPorts`; `packages/session` still imports no transport, storage, socket or timer, so the swap stays an adapter. `MapService` and `AiService` keep their interfaces but the DO implements them as **round trips to the GM's client** (`gm.requestMapGeneration`/`gm.mapGenerated`, `gm.requestAiMove`/`gm.aiMove`). See `docs/STACK.md` for what the choice costs. |
| §12.2 | [SOURCE, chat] Branches are the closest unclaimed POIs at that point in the game; "for everything else please use sensible defaults that are recommended for standard MCTS implementations." The K was `MCTS_NODE_EXPANSION_PRUNING = 10`, **superseded** — see Q19. | `closestUnclaimedPoiEnumerator()` and `uctTreePolicy()` ship as named, swappable defaults. The enumerator calls the same `closestPoiCandidates` as the remoteness walk and the rollout policy — three consumers, one kernel, one K. Sub-questions: Q16, Q17, Q19. |
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
POI it's double the length of the first segment, and for the last one it's
double the length of the last segment."

On the follow-up: the segments that count are the ones **between POIs** — the
leg in from the random plains start is discarded, so both boundary cases are the
same rule, "missing one neighbour, so double the one you have".

Implemented as `segmentSumRemotenessScorer()`. For POIs `P1 … Pn` over inter-POI
segments `t1 … t(n−1)`, where `ti` runs from `Pi` to `P(i+1)`:

```
score(P1) = 2 × t1
score(Pi) = t(i−1) + ti     for 1 < i < n
score(Pn) = 2 × t(n−1)
```

Summed across all `REMOTENESS_SIMULATION_RUNS` walks, then min-max normalised.
Sum vs. mean doesn't matter — they differ by a constant and normalisation is
invariant under it. A single-POI walk has no inter-POI segment and scores 0; it
cannot arise on a real map, but the arithmetic is defined.

Verified against four worked cases, including one confirming the start leg has
no effect on any score.

This changed the `RemotenessScorer` interface: it has `beginWalk` / `endWalk`,
since "first POI" and "last POI" are only meaningful against walk boundaries.

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

### Q6. ~~When does an MCTS rollout stop, and what do the other players do?~~ — **answered, implemented**

Both halves answered, in two rounds.

**Opponents.** [SOURCE §9, chat] "During MCTS rollout moves are simulated for
all players, AI and human." That removed a whole interface —
`OpponentRolloutPolicy` is deleted, every seat is driven by the one rollout
policy, and `subject` now only says whose gold is read at the end.

**Termination.** [SOURCE §9, chat] "The rollout stops when there is no gold
rewards left on the map." Since §1 makes gold the only thing anyone wins with, a
state with none left is decided, and simulating the tail where players collect
the remaining skill and stamina POIs buys the search nothing. Worth being
explicit that this is *not* "all POIs claimed": a rollout ends with skill and
stamina POIs still on the map, which is the point, and saves real time against
the 10-second budget.

`goldExhaustedTermination()` also stops on a finished game. That clause comes
from the engine rather than from the answer: §1's win condition can fire
*earlier* than gold exhaustion, when a leader's lead already exceeds what
remains, and at that point there is nothing left to simulate. Gold exhaustion
implies a finished game (Q3: a tie resolves once nothing remains to break it),
so the gold clause is the one that bites in practice.

The cost note stands as a forward-looking flag rather than an open question: if
rollouts prove too slow, a turn or depth cap is the usual mitigation, and it
would change what the backpropagated value means — so it is a seam, not a
default.

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

### Q11. ~~In the hybrid evaluator, what is "number of skills"?~~ — **answered; the surrounding formula is superseded by Q18**

[SOURCE §9, chat] "The sum of all skill levels" — so fighting 3 + magic 1
contributes 4, not 2. Summed over the five skills (three movement, fighting,
magic); gold is the objective and stamina a resource, so neither counts.

`hybridGoldAndSkillsEvaluator(balancingConstant)` is now fully written. Both
halves are normalised by total map gold per Q14, which keeps the average over
two comparable quantities and puts `balancingConstant` in units of *gold per
skill level* — a natural thing to tune.

**The answer above still stands; the formula around it does not.** Q18 replaces
the fixed `balancingConstant` with a weight that moves as gold is claimed,
divides the skill term by total skills rather than by total gold, and moves the
whole thing into the *estimated* evaluator, leaving the hybrid as the average of
simulated and estimated. "Sum of skill levels, not a count of skills" is what
carries over, and it is the skill numerator
`estimatedGoldAndSkillsEvaluator()` uses.

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

### Q14. ~~UCB1's √2 assumes rewards in [0, 1]~~ — **answered, implemented; Q18 changes how the estimate gets there**

[SOURCE §9, chat] "Yes, we can normalize by dividing over total gold on the
map." Every gold term divides by `totalGoldUnits(map)`, so every backpropagated
value sits in [0, 1] and √2 is the correct constant. The divisor is gold
*placed*, fixed for the whole game, so values stay comparable across a search.

The answer holds for all three evaluators, but Q18 gave the estimated one a
second denominator: its skill term divides by `totalSkillUnits(map)`, and the
two terms are combined by weights summing to 1, so it lands in [0, 1] without
gold's divisor having to carry it. The simulated evaluator is unchanged, and the
hybrid averages two values already in [0, 1].

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
**pruned** target list, not every POI on the map. A reachable POI outside that
list is not a branch the search can take, so counting it would let rest be
pruned on the strength of an option that does not exist in the tree.

`MIN_REACHABLE_NODES_FOR_REST` survives Q19 unchanged: that collapsed the two
Ks, and this is a threshold on reachability, not a K.

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

### Q18. ~~Is the hybrid evaluator's gold/skills weight a constant?~~ — **answered, implemented**

Two answers in two rounds, both from the same review.

**The formula.** [SOURCE §9, review] The weight is not a constant — it
moves with the game. "The weight coefficient for the average determines how
important we think the skills are wrt actual gold. The best solution is to make
this coefficient change with time (skills are important at the beginning of the
game, and are worthless at the end)."

```
value = gold/total_gold × progress + skills/total_skills × (1 − progress)
        progress = gold claimed by all players / total_gold
```

**Where it belongs.** [SOURCE §9, review] Not in the hybrid — in an
*estimated* evaluator, one of three kinds the designer distinguishes:

| Evaluation | What it does |
|---|---|
| **Simulated** | "We simulate random moves until all gold is exhausted." §9's specified default. `simulatedRolloutEvaluator()`. |
| **Estimated** | "Current gold plus current skills, averaged as per the new formula" — the formula above, read entirely from the node. `estimatedGoldAndSkillsEvaluator()`. |
| **Hybrid** | "The average of the two", as `(afterSimulation + now) / 2` always did. `hybridGoldAndSkillsEvaluator()`. |

So the formula is a property of a *position*, not of the rollout, and the hybrid
stays what it always was: half simulated, half estimated. The implementation
composes it from the other two evaluators rather than reimplementing either.

This **supersedes Q11 and Q14's version of the estimated half**, which added
gold to skills scaled by a fixed `balancingConstant` and normalised both by
total map gold. Three consequences:

- `balancingConstant` goes away. What it was tuning is `progress`, which the
  game state already supplies, so there is no constant left to fine-tune.
- **Q14's normalisation is satisfied by the shape rather than by a divisor.**
  The estimate's two terms sit in [0, 1] and its weights sum to 1; the simulated
  value is in [0, 1] already; so the hybrid's average is too, and
  `MCTS_EXPLORATION_CONSTANT` = √2 stays correct. The coupling Q14 flagged
  between the two settings is unchanged in kind.
- The weights run the way the designer described: at the start almost no gold is
  claimed, so `progress` ≈ 0 and skills carry the value; by the end `progress`
  ≈ 1 and only gold counts. `progress` is meaningful precisely because the
  estimate reads the node — a rollout ends with no unclaimed gold left (Q6), so
  measured there it would always be 1.

`totalGoldUnits(map)` and `unclaimedGoldUnits(state)` gave `total_gold` and, by
subtraction, gold claimed by all players. `totalSkillUnits(map)` is new, and the
five skill kinds moved into `SKILL_KINDS` in `@adventure/config` so the skill
term's numerator and denominator read the same list.

**One reading I picked, flagged on PR #5 rather than assumed silently:**
`total_skills` is the sum of skill units *placed on the map*, the exact parallel
of `totalGoldUnits`, so the term reaches 1 when one player holds every skill
POI. The alternative — a theoretical maximum skill level per player — would make
the term mean something different and never reach 1. Changing it later is a
one-line change to `totalSkillUnits`.

**Confirmed, 2026-09-22.** That reading shipped as a pick rather than an answer
and is now the designer's own: see [Q24](#q24). No code changed.

**What v1 uses.** [SOURCE §9, review] "The plan is to use the simulated
rollout for node evaluation in v1, and then experiment with other evaluators."
So `simulatedRolloutEvaluator()` — §9's specified default — is the one the first
release runs, and the other two exist to be switched in afterwards. That is why
`SearchOptions.evaluator` is injected with no default: choosing between them is
a caller's decision, not a hard-coded one.

The three are named the same way everywhere, in the register, in
`docs/ARCHITECTURE.md` §7 and in the code: **simulated**
(`simulatedRolloutEvaluator()`), **estimated**
(`estimatedGoldAndSkillsEvaluator()`) and **hybrid**
(`hybridGoldAndSkillsEvaluator()`). The simulated one was called
`goldAfterSimulationEvaluator()` until this PR, which left the code and the
design using different words for the same thing.

### Q19. ~~Two constants for one ranking?~~ — **answered, implemented**

[SOURCE §12.2, review] On the `docs/RULES.md` PR, reading back that the tree
pruned to `MCTS_NODE_EXPANSION_PRUNING` = 10 while the rollout and the
remoteness walk used `CLOSE_CANDIDATE_COUNT` = 5: "We don't really need two
different constants here. We will prune the tree by the CLOSE_CANDIDATE_COUNT,
plus one branch for resting."

So `MCTS_NODE_EXPANSION_PRUNING` is **deleted** from `AiConfig`, and
`closestUnclaimedPoiEnumerator` prunes to `CLOSE_CANDIDATE_COUNT` — one K for
all three callers of `closestPoiCandidates`, and tuning it now moves the tree
and the rollout together.

This also removed a latent inconsistency rather than only a constant.
`closestPoiCandidates` caps its own result at `CLOSE_CANDIDATE_COUNT`, so the
enumerator's `slice(0, MCTS_NODE_EXPANSION_PRUNING)` could never have widened it
to 10 — the tree would have branched over 5 whatever that constant said. The
slice is gone with it; the kernel's cap is the only cap.

The rest branch is untouched: `MIN_REACHABLE_NODES_FOR_REST` = 3 still gates it
(Q16), since it is a threshold on reachability rather than a second K.

**Follow-up: the value moved.** [SOURCE §1.2, chat] With one constant now
serving all three callers, the designer raised it from 5 to **10** — "we don't
want to risk pruning out good moves early on". The numbers above are what was
true when the two constants were collapsed, not the current default. Worth
knowing that this is no longer only an AI knob: §5.1's remoteness walk reads the
same constant, so the change moves remoteness scores, and through §5.2 the guard
strengths and reward stacking of every generated map.

---

## B3. Questions from the implementation-planning pass

Six gaps found while turning GDD.md and the architecture into a phased build
order (`docs/IMPLEMENTATION_PLAN.md`), all answered by the designer on
2026-09-22. None of them changed a rule; they settled scope and content, Q24
confirmed a reading Q18 had had to pick, and Q25 confirmed §5.1 unchanged while
narrowing how much code two components should expect to share.

### Q20. ~~Which §10 art assets are coming, and which need standing in?~~ — **answered**

Writing the art-binding phase turned up six §10 asset groups absent from `Art/`
and one POI sheet: forest's 4 fighting-guarded gold POIs (the other eight rows
of §4.2 each have a sheet), the stamina POIs that surplus leaves create,
character figurines and player avatars, the die-roll animation, the three
terrain textures, the road/path brush, and the move-prospect visuals (path
highlight, destination cross, waypoint marker).

Also worth recording, because it misleads: all seven §4.1 reward icons *are*
present, but two filenames do not describe their contents — `Art/Icons/roads.png`
is the brown wagon wheel (plains movement) and `Art/Icons/plains.png` is the
green foot (forest movement). There is no road-brush asset in `Icons/` at all.
Any art mapping must be written against the pictures, not the names. This
contradicts GDD.md §4.1's `[INFERRED §6]` line that the supplied icons "match
this table with no discrepancies": the *set* matches, the names do not.

[SOURCE chat, 2026-09-22] "I will add the missing placeholder art before we
start implementing the plan." So the phases assume the full set and need no
fallback path. Two of the gaps were closed on request in the same pass —
`Art/Dice_d6_*` and `Art/Roads_Brush_*`, generated rather than supplied and
marked `"placeholder": true` in their atlases,
regenerable with `Art/tools/make_placeholders.py`.

**Two of the POI gaps borrow an existing sheet meanwhile.** [SOURCE §10,
review] "Mountain gold placeholder images can be used" for forest's gold POIs,
and "Plaines movement placeholder images can be used" for the stamina POIs that
surplus leaves create. So the art mapping is not one sheet per §4.2 row: two
rows point at a sheet belonging to another row. Keep those two substitutions in
one table rather than scattered through the renderer, so dropping in a real
sheet is a one-line edit. [SOURCE §10, review] The die-roll animation "will be
provided" too, so the generated one is a stand-in rather than the final asset.

### Q21. ~~Is the AI's time budget wall-clock seconds or a rollout count?~~ — **answered: seconds**

`docs/STACK.md` §5 raised this and left it open: with the MCTS search on the
game master's machine (§12.1), a fixed 10-second budget buys very different
search on a laptop than on a workstation, so AI strength is not reproducible
across games. A budget expressed in rollouts would fix that, at the cost of a
variable turn length.

[SOURCE chat, 2026-09-22] "Let's stick to the seconds budget for AI, the purpose
of this game is fun, not the strongest and most consistent AI."

So `MCTS_TIME_BUDGET_PER_MOVE_MS` stands, §9 and §11 are unchanged, and
`docs/STACK.md` §5's "AI difficulty is not reproducible across games" is an
accepted cost rather than an open item. One consequence for the balancing
harness: a self-play result is only comparable to another run on the same
machine, so `runSelfPlayBatch` should record the machine beside the numbers.

### Q22. ~~How many seats does hotseat fix, while the count is temporary?~~ — **answered: 2**

[SOURCE chat, 2026-09-22] "2 players is a good enough number and exercises all
necessary functionality." Two seats also exercise both victory cases — a clear
leader and a tie with no gold left — and turn order.

`PLAYER_COUNT` (2–5) is untouched: this is a constraint of the hotseat mode
while the setup flow does not exist yet, not a change to the game's range.
§6.1's flow is where a game master picks a count for real.

Left unasked and not worth blocking on: whether a hotseat game survives a page
reload. Persisting it is small but the design does not mention it, so the plan
does not either, and a closed tab loses the game.

### Q23. ~~Build both POI placement strategies, or one?~~ — **answered: farthest-point only, seam kept**

`docs/ARCHITECTURE.md` §3 read §3's "approximately equal distances" as a goal
rather than a procedure and left `PoiPlacementStrategy` a seam with *both*
farthest-point sampling and graph-space Poisson-disc to build and compare in
the harness — two implementations for one shipped behaviour.

[SOURCE chat, 2026-09-22] "use farthest point sampling, we'll switch if that
looks bad, which I doubt."

So farthest-point sampling is the one to write, and the seam stays, so adding
the other is a one-liner rather than a rewrite. The judgement of "looks bad"
belongs to `runMapBatch` over many seeds: POI spacing in the map dump, and the
shape of the remoteness histogram. This supersedes §3's "two implementations to
build"; the superseded reading is kept above as it was written.

### Q24. ~~Is Q18's "total skills available" the units on the map, or a per-player maximum?~~ — **answered: the units on the map**

Q18 had to pick a reading to be implementable and said so. The pick was the sum
of skill units *placed on the map* — the exact parallel of `totalGoldUnits` —
rather than a theoretical maximum skill level per player. It shipped on PR #5
under that reading, flagged, and was put to the designer twice more.

[SOURCE §9, review] "There is no set per-player maximum, none of the skills are
capped by any hardcoded number. So the total # of units place on the map are
going to be used."

So `totalSkillUnits()` in `packages/core/src/gamemap.ts` stands exactly as
written and **no code changes**. The confirmation matters for what the
estimated evaluator *means*: its skill term reaches 1 precisely when one player
holds every skill POI on the map, which is what keeps it commensurable with the
gold term and the whole evaluator inside [0, 1] — the range
`MCTS_EXPLORATION_CONSTANT` = √2 assumes ([Q14](#q14)). It also agrees with §6's
"per-player stats, uncapped": a per-player maximum would have had to be invented,
and §11 has no row for one.

### Q25. ~~Does the remoteness walk track visited POIs?~~ — **answered, confirmed: yes**

Raised on PR #6, reviewing the line that says `closestPoiCandidates` is shared
by "the remoteness walk over *unvisited* POIs, the rollout policy over
*unclaimed* POIs". [SOURCE §5.1, review] "we do not track which POIs have been
visited. As long as a POI is unclaimed it is a valid target for the next walk
destination."

That is true of the **§9 rollout**, and is what `rollout.ts` already specifies.
Applied to the **§5.1 remoteness walk** it does not compose, for three reasons
worth keeping because they are not obvious:

1. The unvisited set is that walk's *termination condition* — §5.1's "until
   every POI has been visited once per walk", `remotenessDriver.done` is
   `cursor.unvisited.size === 0`. Remoteness walks run inside §2.1 step 7,
   before any player exists, so nothing is ever claimed and an unclaimed-only
   eligibility set never shrinks.
2. The per-POI score is "the inbound inter-POI segment plus the outbound one",
   with the first and last POI doubling the single segment they have. That is
   defined against a walk visiting each POI exactly once.
3. Remoteness feeds guard strengths (§5.2) and reward stacking (§4.3), so a
   change here moves every generated map, not just a number.

Put back to the designer rather than applied. [SOURCE §5.1, review] "of course,
during the remoteness walk we can track which nodes are visited." **So §5.1
stands exactly as written and nothing changed** — `remotenessDriver` keeps its
unvisited set, and `rollout.ts` keeps its unclaimed one.

**The useful half of the answer is about code sharing.** [SOURCE §9, review]
"my prediction is that code between the remoteness walk and the rollouts will
be hard to share anyway, they are very different. We may end up sharing code
for choosing the next target only."

The architecture pass shares two things: `candidates.ts` (the target chooser)
and `walk.ts` (a generic loop plus `WalkDriver`). The first is what §5.1 and §9
actually name. The second already strains at four points — `WalkDriver.advance`
returns `TCursor | null` and so cannot express `MacroAdvanceOutcome`; `runWalk`
records every leg as `{target.node, target.cost}`, which is the Dijkstra
estimate rather than the real turns' cost and is simply wrong when a target is
claimed by someone else en route; `WalkResult.visits` exists for the remoteness
scorer and a rollout consumes none of it; and `WalkDriver.done(cursor)` cannot
supply the `legsTaken` that `RolloutTermination.isTerminal` takes for a future
depth cap.

So the expectation for phase 5 is: keep `candidates.ts` shared, and let the
rollout have its own loop over `macroAdvanceToTarget` rather than being bent
through `runWalk`. `docs/ARCHITECTURE.md` §5's "one shared component" stays
true of the target chooser and the one distance metric, which is what §9 asks
for; it is the generic loop that is not expected to survive.

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
