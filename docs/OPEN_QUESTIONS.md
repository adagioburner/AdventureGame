# Open items routed around in the architecture pass

Every unresolved item that actually shaped a decision in the code, what I did
about it, and where the seam lives. Two categories:

- **Routed around** — the architecture stays coherent without an answer. There
  is a named interface or a `pending` config entry, it has *no default*, and
  reading it throws with a GDD reference attached.
- **Asking** — I could not proceed honestly without you, or I found a gap or a
  discrepancy that isn't in GDD.md §12 and that you should see.

Nothing below was resolved by picking something reasonable.

**Answered so far:** all four of GDD.md §12's own open items, Q1–Q26, Q28–Q29 and Q31–Q61.
`pending` in the config is empty.

**Outstanding: two — [Q27](#q27) and [Q30](#q30), neither of them blocking.** Building phase 1 turned up that
`COMPACTNESS_MAX` never binds on a map of ~240 nodes and 300 edges, so §2.1's
Smooth step does nothing at the current constants. It is a tuning question
rather than a blocker: generation works and the code implements §2.1 literally.
[Q29](#q29), the other thing reviewing phase 1 turned up, is answered — §4.3
leaned bigger stacks toward remote POIs only 57% of the time, and Andrei's swap
pass is now §4.3 step 4, which takes it to 96%. Everything
else in this register is answered, and so is every reading that was held open
for confirmation — Q1's first-segment wrinkle, Q13, Q17, and, as of
2026-09-22, Q18's own pick of what "total skills available" divides by
([Q24](#q24)) and whether the §2 avatar is its own asset ([Q26](#q26)). The
config's `pending` block is empty.

[Q30](#q30) came out of phase 2: with the rules engine running, a game can in
principle reach a position where the gold that is left is behind guards nobody
can beat and §1's win condition can never fire. It is rare — ten games on ten
maps all ended with a winner — and it is a rule that is missing rather than a
rule that is wrong.

`docs/IMPLEMENTATION_PLAN.md` is the build order; `docs/ARCHITECTURE.md` §11
lists the seams it draws on.

Q20–Q26 came out of writing that plan, and of the art landing against it,
rather than the architecture pass, and sit in their own section below. Q27 came
out of running the pipeline for the first time. Q31 and Q32 are Andrei's
rulings from his first look at the phase 3 map, recorded here because each
changes what GDD §3 or §7.1 says.

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
strengths and reward stacking of every generated map. *Since [Q66](#q66) it no
longer does: the walk has its own `REMOTENESS_CANDIDATE_COUNT`.*

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

**The character figurines arrived on 2026-09-22**, supplied rather than
generated: `Art/player_avatars_sheet.png` + `player_avatars_atlas.json`, six
full-body figures on the same packed-grid, feet-anchored convention as the
POI sheets and with no placeholder flag. Whether the separate player avatar
of GDD §2 is these same six or a distinct set is not settled; the six stand
in for both meanwhile, which also means hotseat setup offers six characters.

**Two of the POI gaps borrow an existing sheet meanwhile.** [SOURCE §10,
review] "Mountain gold placeholder images can be used" for forest's gold POIs,
and "Plaines movement placeholder images can be used" for the stamina POIs that
surplus leaves create. So the art mapping is not one sheet per §4.2 row: two
rows point at a sheet belonging to another row. Keep those two substitutions in
one table rather than scattered through the renderer, so dropping in a real
sheet is a one-line edit. [SOURCE §10, review] The die-roll animation "will be
provided" too, so the generated one is a stand-in rather than the final asset.

**Phase 3 closed the rest with placeholders and renamed the icons.** The three
terrain textures and the move-prospect markers (path dots, destination cross,
waypoint flag, active-player ring) are generated by the same script and carry
the same flag. The icons are now named for their reward kind —
`Icons/plains_move.png` is the wagon wheel that was `roads.png`,
`Icons/forest_move.png` the foot that was `plains.png` — so the misleading
names above are gone. The two borrowed rows are the ones marked `borrowed` in
`Art/manifest.json`, which is the one table this question asked for.

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
Andrei has since ruled that it should survive one, and postponed it to the
multiplayer work ([Q37](#q37)).

*Replaced 2026-09-24 by [Q51](#q51) 21: a game on one device takes 2 to 5
players, picked on the one new game screen.*

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

### Q26. ~~Is GDD §2's player avatar the figurine sheet, or its own asset?~~ — **answered: its own set, cropped figurines meanwhile**

§10 asks for figurines to choose from at setup and §2 shows an avatar beside
each player's name. The six figures supplied on 2026-09-22 are plainly
figurines; whether they were also the avatar was unstated, and the two want
different framings — a figurine stands on a node, an avatar sits in a panel.

[SOURCE chat, 2026-09-22] "there will be a separate head and shoulders set. As
a temporary image the same avatars can be used enlarged and shifted so that
only their head and shoulders fit into the frame."

So the avatar is its own asset and the figurines stand in until it arrives.
**One uniform enlarge-and-shift will not do it**, which is worth recording
because it is the obvious implementation and it fails: measured from the sheet's
alpha, the six heads start between row 24 and row 155 of a 698-row cell, so a
transform that frames the knight lands on the halfling's chest. The heads are
not centred alike either — a held axe or staff drags a figure's bounding-box
centre up to 76px off its own face.

`Art/player_avatars_portraits.json` therefore carries one square, cell-relative
box per figure, measured rather than hand-placed and regenerable with
`python3 Art/tools/make_portrait_crops.py`. It is marked `"temporary": true`;
delete both it and the tool when the real set lands. Phase 3 scales the box
into the avatar frame — there is no second PNG, so nothing is upscaled on disk
and nothing has to be kept in step with the figurine sheet.

<a id="q27"></a>
### Q27. Should `COMPACTNESS_MAX` be retuned? The Smooth step currently does nothing — **asking**

§2.1 step 5 says: "flip isolated nodes to their majority-neighbour terrain
**until** `compactness = boundary² / area` falls below `COMPACTNESS_MAX`", with
[SOURCE §1.3, chat] giving a circle reference of 4π ≈ 13 and a starting value
of 25. The code implements that literally. The consequence, which only shows up
once the step is run on a real map, is that **the condition already holds
before the loop starts**, so no node is ever flipped.

The measurement is not wrong; the reference is. A circle scoring 4π assumes a
dense 2D lattice, where a region of radius *r* holds about π*r*² nodes and about
2π*r* of them sit on its edge. A finished map is not a lattice: §2.1 prunes to
~240 nodes and 300 edges, a mean degree of **2.5**, which is nearly a tree. On
a graph like that a terrain region's boundary is a handful of nodes whatever its
size, so `boundary² / area` comes out around **1.0 on average and 4.5 at worst**
over 40 seeds — against a threshold of 25. (Those are the figures after
[Q28](#q28); before step 6 grew the short terrains back, they were 0.4 and 3.4.
A terrain that a valley runs through is genuinely corridor-shaped, which is
what a valley is, so the rise is the fix working rather than a regression.)

What that costs: nothing is broken, but one of the eight pipeline steps is inert,
and the speckle it exists to clean up survives into the finished map. Flood fill
with §2.1's same-terrain bias already produces reasonably blobby regions, so the
maps look sane (`pnpm map adventure`), but they are not smoothed.

Three ways out, none of them the implementer's to pick:

1. **Lower `COMPACTNESS_MAX`** to something that binds at this density — the
   batch report suggests the interesting range is roughly 1 to 3. It is a §11
   "tunable (play-test)" row, so this is the cheapest change and needs no code.
2. **Change what compactness measures** — counting boundary *edges* rather than
   boundary *nodes* would scale with the graph's own density. [SOURCE §2.1 step
   5, chat] settled on nodes ("yes, counting nodes is the right approach"), so
   this would be a reversal rather than a tuning.
3. **Leave it.** If the regions look right, an inert step is only a tidiness
   problem, and step 5 becomes load-bearing again if `MAP_EDGE_COUNT` ever rises.

`pnpm map:batch 50` prints the compactness distribution both after Smooth and
after Carve Valleys, so whichever you pick can be checked against real maps.
Nothing downstream depends on the answer: reward assignment and guard strengths
read remoteness, not compactness.

---

### Q28. ~~Are §2.1's terrain shares measured before or after the valleys are carved?~~ — **answered: the finished map**

Andrei, reviewing PR #10: *"Because of the valleys the count of nodes of each
terrain has been skewed heavily towards plains, right? The mountains are
overcrowded with POI while Plains have huge empty spaces. ... We need to keep
close to the original balance of nodes in the final map, not before the valleys
have been carved."*

Both halves of his reading were right, and the second one is the consequence of
the first. §2.1 step 6 converts forest and mountain nodes into plains *after*
step 4 has hit its shares, so the map a player is handed drifts; `adventure`
finished 65 / 26 / 9 against 45 / 30 / 25. And because §4.2 fixes the POI count
per terrain — 25 plains, 20 forest, 15 mountain, whatever the node counts turn
out to be — every node the valleys take out of mountain also packs mountain's
POIs closer together. On that map two thirds of every mountain node carried a
POI while plains ran one per 6.2 nodes; `saltmarch` was one per 1.7.

Recorded in `GDD.md` §2.1 as [SOURCE §2.1, review] and implemented: step 6 ends
by growing whatever terrain is short back into plains, leaving the carved
fingers and the plains node each one opens from untouched, and the same growth
finishes step 4, whose flood fill cannot reach the shares on its own. Measured
over 40 seeds, the finished map now runs 44.8–48.1% plains, 29.8–30.2% forest
and 21.8–25.2% mountain. The same 40 seeds through the old pipeline ran
32.9–66.8% plains, 17.5–45.7% forest and 6.4–31.0% mountain. POI spacing sits
between one per 2.9 and one per 4.9 nodes on every terrain.

Two knock-on facts worth knowing rather than re-deriving. Plains compactness
rises — 6.8 on `adventure` against 0.9 before — because plains is now genuinely
corridor-shaped where a valley runs; that is what a valley is, and it is still
far inside `COMPACTNESS_MAX`, so [Q27](#q27) is unchanged. And a terrain walled
in by one that is already at its share cannot be fixed by a straight transfer,
so the regrowth also trades: the neighbour hands a node over and takes one back
from a terrain that has a surplus. Without that trade the shares stuck as much
as ten points out on the odd map.

### Q29. Should a bigger reward stack *always* sit on a more remote POI? — **answered 2026-09-22**

Andrei, on PR #10: *"Is distribution of rewards correlated with the remoteness
score? E.g. if a node has P4 and another P1, we definitely want the first one to
be more remote."*

**What the measurement found.** Over 200 maps, within a §4.2 row (so like for
like — the same kind, guard and terrain), §4.3 did lean the right way, but only
as a tendency:

- Spearman ρ between units and remoteness: **0.141**.
- Take any two POIs in the same row with different stacks: the bigger stack was
  the more remote one **57.1%** of the time. Chance is 50%.
- His example, `plains_move`: a P1 sat at mean remoteness 0.18, P2 at 0.21,
  P3 at 0.22, P4 at 0.25. Mountain gold was the steepest row — 0.43 / 0.52 /
  0.60 / 0.64 — and no row ran backwards.
- Raising `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` helped but saturated: 57.8% at
  the default 2, then 59.9% (w=4), 62.3% (w=8), 63.6% (w=16), 65.1% (w=32).
  §4.3 step 3 is a *weighted random draw*, one unit at a time, and §4.2 hands
  most rows barely more spare units than POIs — `plains_move` is 20 units over
  10 POIs — so with that few draws the variance dominates however hard
  remoteness leans on the weights.

**His answer:** *"we can distribute rewards without much regard for remoteness,
and then for a number of times consider pairs of POIs with the same type of
reward and swap their rewards if they do not correlate with their remoteness. We
don't have to do complete ordering, doing that a number of times will raise the
correlation enough. It would be nice to run a simulation and see how many times
we need to do that to get the correlation to 90%."*

**The simulation, 200 maps, agreement between stack size and remoteness:**

| Passes | Pooled agreement | Spearman ρ | Maps under 90%, read one at a time | Worst map |
|---|---|---|---|---|
| 0 | 57.1% | 0.14 | 200 / 200 | 39.0% |
| 2 | 87.0% | 0.70 | 158 / 200 | 76.2% |
| **3** | **91.8%** | 0.78 | 54 / 200 | 81.0% |
| **5** | **96.3%** | 0.85 | **0 / 200** | 91.0% |
| 10 | 99.2% | 0.89 | 0 / 200 | 96.4% |

A "pass" is one pair draw per POI in the row, so a whole map at 5 passes draws
about 300 pairs and swaps about 27 of them — roughly one draw in eleven finds
something to fix. **Three passes clears his 90% across a batch; five clears it
on every single map of 200 read on its own**, which is the reading a player
gets, so the default is **5**. Generated with and without step 4, the four
seeds the tests use read 59.9 → 99.2 (`adventure`), 73.2 → 96.9 (`alpha`),
58.3 → 98.6 (`beta`) and 60.9 → 96.5 (`gamma`).

**What shipped:** §4.3 gains a **step 4**, tagged `[SOURCE §4.3, review]`, and
§11 gains `REWARD_SWAP_PASSES = 5` as a tunable. `swapGroupTowardRemoteness` in
`packages/mapgen/src/rewards/assign.ts` runs it, right after step 3's draw and
before §5.2 reads the stacks for guard strength.

Three things worth knowing about it:

- **`REMOTENESS_WEIGHT_FOR_DISTRIBUTION` is left at 2.** His "without much
  regard for remoteness" reads as permission, not an instruction, and the
  measurement says the choice barely matters once step 4 runs: at 3 passes it is
  91.8% with the weight at 2 against 91.2% with it at 0. Leaving it keeps §4.3
  step 3 exactly as the GDD writes it. Say the word and it goes to 0.
- **Nothing in §4.2 moves.** A swap exchanges two stacks *inside* one row, so
  the row's total units, its POI count and step 2's guaranteed unit all survive
  untouched — verified on the sealed map, and generation still takes ~195 ms.
- **Unguarded gold all but disappears, which is a real side effect.** §5.2 caps
  guard strength at 0, and the only way to reach the cap is a 1-unit stack at
  remoteness ≥ 0.5 — precisely what step 4 moves. Over 60 maps, gold POIs
  sealing unguarded fall from **3.3%** to **0.2%**, and 58 of those 60 maps have
  none at all. That pushes §4.4's "every gold POI is guarded, none are exempt"
  back toward literally true, and mean guard strength is unchanged at 4.6. If
  the occasional unguarded remote 1-gold was wanted as a treat, that is a
  separate decision about §5.2's constants, not about step 4.

**Not taken:** making step 3 itself deterministic — sorting a row by remoteness
and dealing spare units from the remote end. It would guarantee the ordering by
construction, but it removes the per-seed variety, which is the thing his "we
don't have to do complete ordering" preserves.

---

### Q30. What ends a game nobody can finish? — **asking, not blocking**

Phase 2 made this visible rather than created it. §1 ends a game exactly one
way: a lead that exceeds the gold still unclaimed. §8 decides a guard by
`roll + matching skill > guard_strength`, so a player with fighting 3 facing a
guard of 10 cannot take that POI **on any roll** — 6 + 3 is not greater than
10. Skills come only from skill POIs, and those are finite.

So a position exists where the gold left on the map is all behind guards no
surviving player can beat, every skill POI is claimed, and nothing either player
does can change any of it. §1's condition never fires and the game runs for
ever. Nothing in §12 covers it and there is no draw, no resignation-to-end and
no turn limit in the design.

**How likely is it?** Rare at the current constants. Ten full games on ten
generated maps, two players each, all ended with a winner in 74 to 198 turns
(`pnpm game <seed>`). It needs an unlucky split of the fighting and magic POIs
between players plus high guards on what is left.

**What phase 2 did about it:** nothing, in the engine. The rules are
implemented as written and `applyAction` has no turn cap. The *harness's*
playthrough driver stops and reports `stalemate` when every seat in one full
cycle has nothing it could ever claim, because a test that cannot terminate is
worse than one that fails — that is a property of the harness, not a rule.

Ways out, if you want one: a draw when no player can claim anything, a turn
limit that awards the win on gold held, letting stamina buy a re-roll, or
lowering `GUARD_STRENGTH.max` so the die alone can always reach it. All four are
design; none is the implementer's to pick, and the engine works either way.

---

### Q31. ~~Where does a guard's red or purple go?~~ — **answered 2026-09-23: on the node**

GDD §3 gives a guarded POI's image "a red (fighting) or purple (magic)
contour", and phase 3 drew exactly that, a coloured ring round each guardian's
picture. Andrei, reviewing the map: *"the guards should not have red or purple
contours; instead, the nodes should."*

So the colour is now on the POI's node: every node keeps its black outline,
and a guarded POI's node gains a ring in its guard's colour just outside it —
the black one stays inside, as Andrei asked on his second look the same day.
The picture stands beside the node, touching it, and never on it, so the whole
ring shows; the reward icons and the guard's number touch the node's front.
Once the POI is claimed, §4.5's "behaves like an ordinary node" makes it an
ordinary node again, ring and all. The ring's width is `guards.ring_width` in
`Art/manifest.json`. GDD §3 carries the ruling as a `[SOURCE §1, review]` note
beside the original sentence.

---

### Q32. ~~Do yellow route steps show their stamina cost?~~ — **answered 2026-09-23: no**

GDD §7.1 labels a yellow step "with the stamina cost, e.g. '-3'", and phase 3
drew a "-N" beside each one. Andrei, reviewing the map: *"Let us remove the
numbers showing stamina lost. The color coding already tells the player that
it's not free; they can figure out the rest."*

The route is now dots and a cross only. `previewPath` in `@adventure/core`
still reports each step's cost, since the engine charges it; only the label is
gone. GDD §7.1 carries the ruling as a `[SOURCE §4, review]` note.

---

### Q33. ~~What does the page call the stats?~~ — **answered 2026-09-23: speed and combat**

GDD §6 names them "plains/forest/mountain moving skill levels" and "fighting
skill", and phase 4's page said "plains movement" and "fighting". Andrei,
trying the hotseat game: rename them to "plains speed", "forest speed",
"mountains speed" and "Combat" "consistently throughout the interface".

The page now uses those words everywhere a player reads a stat: the stats
panel, the result card ("a combat guard of 5"), the turn log and the hints.
They come from one table, `STAT_LABEL` in `apps/web/src/page/journal.ts`. The
engine, the config and the rules documents keep `plains_move` and `fighting`,
since the rename is about what a player reads. GDD §6 carries the ruling as a
`[SOURCE §2, review]` note.

---

### Q34. ~~How does the page show whose figure is whose turn?~~ — **answered 2026-09-23: it blinks, then is highlighted**

GDD §7.2 says the current player's "character is highlighted on the map", and
phase 4 drew a ring under it that was easy to miss. Andrei: *"it is hard to
find your character on the map. Can we make it so it blinks when it's your
turn, and, once you clicked it to start planning your move, it stops blinking
and highlights instead."*

The figure and its ring now pulse while it is the player's turn, with a
ripple spreading on the ground under them, and once the player taps the
figure or presses Plan a move it holds still, the ring enlarged and circled
in gold, until End Turn or Rest. Cancel sets it blinking again. The ripple is
an addition he did not ask for and is one line to drop. GDD §7.2 carries the
ruling as a `[SOURCE §intro, review]` note.

### Q35. ~~Where does a POI's image stand?~~ — **answered 2026-09-23: against its node, a guardian on it**

Q31 put each image beside its node, on whichever side hid least, touching the
node's oval with its bounding box. Andrei found them too far away: *"let us
place POI images closer to the POIs themselves, close to or touching the node.
Guards, specifically, can be standing on the node itself, not centered on it
but intersecting at the base."*

Each sprite's picture is now measured in horizontal bands as it loads, so an
image comes in until the picture itself touches the oval rather than the
empty corner of its box. The rows marked `on_node` in `Art/manifest.json`, the
guardians, stand with their feet 60% of the way from the node's centre to its
rim, in one of the same seven directions. Where every such spot would cover a
neighbouring node or image, which happens on a crowded mountain (8 of the 19
on `adventure`), the guardian stands beside its node instead; asked, Andrei
kept that rule. Standing dressing (trees, fields, grass and rocks) never
covers a POI's picture or its icons. Asked whether that should cover the
trees or only the fields that prompted it, he answered *"let's have the POI
images always unobscured"*. GDD §3 carries the ruling as a
`[SOURCE §1, review]` note after Q31's.

### Q36. ~~How is a claimed POI drawn?~~ — **answered 2026-09-23: its picture does not change**

Phase 3 drew a claimed POI's picture 45% see-through, a default that was
never put to Andrei, and once the cottages were brightened the claimed ones
looked like ghosts. A darker solid version followed, again without asking.
Andrei: *"The claimed POIs should lose their icons, but the images DO NOT
CHANGE."* A claimed POI loses its reward icons, its guard's number and its
guard ring, and its picture is drawn exactly as before. GDD §4.5 carries the
ruling as a `[SOURCE §2, review]` note.

### Q37. ~~Should a hot seat game survive a page reload?~~ — **answered 2026-09-24: yes, postponed to multiplayer**

Phase 4 shipped without asking (Q22 above, and the plan's P3), so reloading or
closing the page loses the game in progress. It was item 38 on the list of
choices made without asking him. Andrei: *"reloading should not kill the game.
This one can be postponed, because with multiplayer the game [state] will be
persisted anyway."* Nothing is built for it now. It is recorded here so the
multiplayer work picks it up; the plan's phase 7 already expects a game to
survive a reload on both sides. *[Q56](#q56) 66 keeps a game on one
device in that browser, so a reload picks it up where it was.*

### Q38. ~~How does the page show what a POI gave?~~ — **answered 2026-09-24: unguarded floats up from the figure and fades, a guard fight waits for OK**

Phase 4 showed a card after every POI a turn ended on, and it stayed until OK,
unguarded claims included. That was never put to Andrei; it was item 2 on the
list of choices made without asking him. His rulings:

- *"the unguarded poi should produce a card that fades itself. The guarded
  POI produce a card with a die roll that has an ok button"*, and it stays 4
  seconds before it fades (his pick of 2, 4 or 6). The fade itself takes half
  a second, which he was told and did not change.
- *"the message for unguarded poi should be simpler, like 'plains speed
  +2'"*: the card reads only that, with no portrait or heading (his pick of
  text only, portrait and text, or icon and text).
- *"please remove the 'costs nothing' phrase in case of a failed die roll"*,
  from the card and, at his pick, from the turn log too. The rule itself is
  unchanged: a failed roll still has no other cost (GDD §8).
- Later the same night: *"can the disappearing card be smaller? i would
  prefer it if it was floating up from the figure as it lands on the POI"*.
  From a preview of three looks he picked the small card (the result card's
  light box and green top edge, shrunk, over a dark pill or bare text) and 2
  seconds over 4. So the unguarded notice now appears on the figure's head as
  the walk ends, fades in over a fifth of a second, drifts up about 40 pixels,
  stays 2 seconds and fades out over half a second. It keeps its size at any
  zoom and moves with the figure through a pan. The fade-in, the rise and
  following the figure were shown in the preview before he picked.

On the winning turn, an unguarded claim's notice fades before the end-of-game
card comes up. GDD §8 carries the ruling as a `[SOURCE §2, review]` note.

### Q39. ~~In what order does the page list the stats?~~ — **answered 2026-09-24: GDD §6's, gold last**

Phase 4 listed gold second, after stamina, where GDD §6 lists it last. That
was never put to Andrei; it was item 5 on the list. Andrei: *"please list gold
last"*, and at his pick in all three places that share the order: the stats
panel, the end-of-game table and the turn log. `STAT_ORDER` in
`apps/web/src/page/journal.ts` is the one list.

### Q40. ~~Does phase 5 change the start game panel?~~ — **answered 2026-09-24: yes, both controls now**

The plan split his fifth step in two: phase 5 had "an AI seat in hotseat" and
phase 8 had "AI seats at setup" and "AI settings". Andrei asked whether phase 5
would need changes to the start game panel, and on the choice between both
controls now, the seat only now, or both later he picked **both now**: the
hot seat start game panel gets a human or computer choice per seat and a
thinking time. Phase 8 carries those two controls into online games. The six
§11 values the plan tunes at the end of phase 5 come afterwards, as proposals
he rules on one at a time; this change tunes nothing.

### Q41. ~~How does the start game panel set up a computer seat?~~ — **answered 2026-09-24: as recommended**

Five details the ask left open, put to him with a mock and a recommendation
each. He took all five recommendations:

- Either seat or both can be the computer; with both, the game plays itself.
  Both seats start as Human, as before.
- Two buttons at the top of each seat, Human and Computer. The panel's opening
  line now reads "Two seats take turns on this screen, each played by a person
  or by the computer."
- Each computer seat has its own thinking time, shown in that seat.
- The thinking time is a box for whole seconds from 1 to 60, filled in with
  §11's 10. `THINKING_TIME_SECONDS` in the config holds the range. Start the
  game stays greyed out while a computer seat's box holds anything else.
- A computer seat's name and figurine are chosen as a person's are, and
  nothing in the game marks it as a computer except its thinking.

*Since [Q51](#q51) the panel is the one new game screen: it takes 2 to 5
seats, and since [Q53](#q53) it has no opening line.*

### Q42. ~~What shows during the computer's turn?~~ — **answered 2026-09-24: a filling bar, and its die card closes itself**

- While it thinks, the line above the buttons reads "<name> is thinking…" over
  a bar that fills across its thinking time. Its player card is highlighted and
  its figure blinks, as for anyone's turn, and the map still pans and zooms.
  Plan a move, Rest and End turn are hidden until it has moved; Find stays.
- Its move then plays out like a person's End turn: its route is drawn, the
  figure walks, an unguarded claim floats up and fades, and the die tumbles if
  it fights a guard.
- The recommendation was for that die card to wait for OK as a person's does.
  Andrei chose the other option: *"the computer's die panel closes itself,
  pressing OK is [not] necessary"*. It closes after 3 seconds. The OK button is
  still on it and closes it sooner. A person's die card still waits for OK.

### Q43. ~~When does a simulated player rest?~~ — **answered 2026-09-24: when it cannot take a single step**

§9 says a simulated player keeps moving toward its POI and says nothing about
resting, and stamina runs out often. Recommended and accepted: a simulated
player rests on any turn in which it cannot take a single step toward its
target, then carries on toward the same target. The computer's real move
follows the same rule, so it never ends a turn standing still for want of
stamina. `restWhenStuck()` in `packages/sim/src/rollout.ts`.

### Q44. ~~What stops a simulated game that cannot end?~~ — **answered 2026-09-24: 250 turns, then the one with more gold**

Q30's position, gold that nobody can take, would leave a game the computer
plays in its head running for ever. Andrei: *"we can end the simulation after
250 turns and give the victory to whatever player has more gold"*.
`SIMULATION_TURN_CAP` (250) counts turns from the position the computer is
thinking about. A game stopped there is scored like any other: the simulated
evaluation reads each player's share of the map's gold, so whoever holds more
comes out ahead.

This is for the games the computer plays in its head only; a real game still
has no turn limit, and Q30 stays open.

Measured afterwards, on six maps with 40 simulated games from each starting
point: of the games simulated from the opening, 16% reach 250 turns (the
median runs 181); from turn 50, 1%; from turns 100 and 150, none. Random play
is slow to finish early on, so near the opening the cap stops about a sixth of
what the computer imagines, and each of those is scored on the gold held at
turn 250.

### Q45. ~~Does a busy page cut the computer's thinking short?~~ — **answered 2026-09-24: yes, it moves when its seconds are up**

The computer thinks in 12 ms slices between the page's frames
(`apps/web/src/modes/computer.ts`), and its thinking time counts clock seconds
from the start of its turn. When the page stutters or freezes, part of that
time passes with no thinking done. In the headless browser used for checks,
which has no graphics card, the page froze for up to 17 seconds at each turn
change, a move got one or two slices, and the computer played almost at
random. Put to Andrei with two options: move when the seconds are up (weaker
on a slow page, but a turn never takes longer than the time set), or keep
thinking until it has had its full seconds (as strong, but a slow page makes
the turn run longer). Recommended and chosen: **as now**, which keeps Q20's
rule of thinking in seconds rather than for strength. Nothing changed.

### Q46. ~~How does the map come to the current player at the start of a turn?~~ — **answered 2026-09-24: it glides, keeps the zoom, and waits for a claim's notice**

Andrei: *"we need to center the map on the current player's figure at the
beginning of each turn, both human and AI"*. That covers people and the
computer, phones too, from the first turn on. Three details it left open, put
to him with a recommendation each:

- **Glide**, as recommended: the map slides to the figure over about half a
  second (`GLIDE_MS`), easing in and out. The Find button still jumps.
- **Keep the zoom**, over the recommendation to zoom in as Find does: only the
  map's position changes, so on the whole-map view it stays that far out,
  centred on the figure.
- **After the notice**, as recommended: when the move before ended with an
  unguarded claim, the map waits until that claim's notice has faded, since the
  notice rides on the figure that made the claim. A guard fight's die card sits
  at the top of the screen and does not hold it up.

Panning, zooming or pressing Find while it glides stops it where it is.
`glideTo` in `apps/web/src/page/MapView.tsx`, called from `GameScreen.tsx`.

### Q47. ~~How does the map follow a figure that walks out of view?~~ — **answered 2026-09-24: from near the edge, keeping pace, until someone moves the map**

Andrei: *"as the figures move, if they get out of view, the map should also pan
to follow them automatically"*. Every walk, a person's or the computer's, at
the zoom the view has. Three details it left open, each put to him with a
recommendation, and he took all three:

- **Near the edge:** following starts once the walking figure is within a
  fifth of the view from any edge (`FOLLOW_MARGIN_OF_VIEW`), so it never
  leaves the screen, rather than only after it has gone out of view.
- **Keep pace:** the map slides along with the figure, keeping it that far
  inside the edge until the walk ends, rather than gliding to re-center it.
- **Stop:** if someone drags, pinches, zooms or presses Find during a walk, the
  map stops following for the rest of that walk. The next turn's glide
  (Q46) still happens.

`followInto` in `apps/web/src/interaction/camera.ts`, applied on each frame of
a walk in `MapView.tsx`.

### Q48. ~~What does phase 6 leave open?~~ — **answered 2026-09-24: computers fill empty seats at Start, the rest as recommended**

Phase 6 (the server, accounts, the game list and the setup screen) left
seventeen details open. They were put to Andrei with a recommendation each on
a page he answers by number. On 12 he chose differently, *"the game master
should be able to start the game before all seats are filled. The unfilled
seats are played by the ai"*, which raised 14 to 17; for everything else he
said *"everything as recommended"*.

1. **Hot seat on the site:** a "Play on one device" button on the login page
   opens the hot seat start panel, unchanged, with no account needed.
2. **Usernames:** 3 to 20 letters, digits or underscores. Capitals don't make
   a different name, so "Andrei" and "andrei" are one account.
3. **Passwords:** at least 8 characters, nothing else required. There is no
   email address, so a forgotten password cannot be reset in v1.
4. **Logins** last 30 days on that browser, with a Log out button.
5. **The game list** has two parts. Your games: every game you are in,
   waiting or started. Open games: games still waiting for players, with the
   name, the game master, seats filled ("2 of 3") and an Ask to join button.
   Finished games are not listed. *[Q55](#q55) 36 keeps a finished game in Your
   games for 7 days.*
6. **Game names:** the creator types one, filled in as "<username>'s game".
7. **The game master plays**, always in seat 1. Later seats go in the order
   the game master accepts people (§6).
8. **The map:** the game master picks it with the hot seat panel's seed box
   and map preview; everyone else in the game sees it as it changes.
9. **Player count:** the game master picks 2 to 5, starting at 2, never below
   the seats already filled.
10. **Name and figure** are chosen when asking to join, the name filled in
    from the username, and can be changed until the start. A figure someone
    else in the game holds is greyed out, as on the hot seat panel.
11. **No, withdraw, leave, cancel:** a declined player sees "The game master
    declined your request" and may ask again; anyone can withdraw a request or
    leave before the start; the game master can cancel a game before it
    starts, which takes it off the list.
12. **Start** works with seats still empty, and a computer plays each empty
    seat. Seats go in acceptance order, so the computers take the last seats
    and start with the most stamina (§6). Everyone then sees the map with
    every figure on the starting node and a line saying online turns arrive
    in the next phase.
13. **The look:** login, register, the game list and the setup screen in the
    style of the hot seat start panel, with no new art.
14. **Computer seats** are "Computer 1", "Computer 2" and so on, each with a
    figure nobody holds, and the game master can change them before Start.
15. **Thinking time:** one box on the setup screen for all the computer seats,
    whole seconds from 1 to 60, starting at 10 as in hot seat (Q41).
16. **Starting alone:** the game master can start with nobody else joined and
    computers in every other seat.
17. **The computers' online turns move into phase 7**, so a game with
    computer seats plays to the end as soon as online turns work. Phase 8
    keeps the Web Worker, resigning to the computer and switching a seat
    between person and computer mid-game. *Since [Q56](#q56) 57, resigning to the
    computer is built in phase 7; handing a seat back stays in phase 8.*

*[Q51](#q51) changed 7, 12, 14 and 15 when the two setup screens became one:
the game master makes each seat Human or Computer, an accepted person takes
the first free Human seat instead of the next one in acceptance order, the
computer plays a Human seat still empty at Start, and each computer seat has
its own thinking time. 1 and 8 now open the same screen with the switch off
or on.*

### Q49. ~~Who gets a figure two seats want?~~ — **answered 2026-09-24: as recommended, with every clash detected and told**

Building Q48 turned up two clashes its answers left open. Andrei took both
recommendations, and added: *"What conflict resolution happens by default
doesn't matter as long as such races are properly detected and resolved and
the players are notified and allowed to act on it."*

18. **A person wants a figure a computer holds:** the person gets it, and the
    computer switches to the first figure nobody holds. There are six figures
    and at most five seats, so there always is one.
19. **Two people ask to join with the same figure:** a request holds no
    figure. Whoever the game master accepts first gets it; the other request
    stays, and its sender is asked to pick another before the game master can
    accept them.

What "detected, resolved and told" became (`packages/session/src/setup.ts`,
`apps/web/src/setup/SetupPanel.tsx`):

- A change the server refuses because someone else just took the figure says
  who: "Bea holds that figure now; pick another". The page shows it at the
  bottom of the map for a few seconds, and the figure is greyed from then on.
- A request whose figure a seated person now holds says so to its sender
  ("Bea has taken the figure you asked for. Pick another so the game master
  can accept you.") and to the game master, whose Accept waits with the same
  reason. Both read it off the setup state, so it survives a reload.
- Seats are named by a stable id (`SetupSeat.id`), not by number, since
  numbers move up as people join and leave. A change to a computer that has
  just made way for a person is refused, rather than landing on whichever
  computer holds that seat number now.
- A change to a request that crosses the game master's answer is refused
  ("the game master has already answered your request"), so an edit arriving
  after a "no" does not ask again.
- Someone whose request was still waiting when the game master pressed Start
  sees "This game started without you" over the map.

### Q50. ~~Can someone logged in play hot seat?~~ — **answered 2026-09-24: yes, from the game list too**

Q48 1 put "Play on one device" on the login page only, so someone already
logged in could reach hot seat only by logging out. Andrei took the
recommendation: the game list's top bar has the same button, beside Log out
(`apps/web/src/online/GameListScreen.tsx`). It opens the same `/hotseat` page,
unchanged, and keeps the login.

*Taken back 2026-09-24 by [Q51](#q51) 26: the game list has one New game
button instead, and turning its "Play online" switch off gives the game on one
device.*

<a id="q51"></a>
### Q51. ~~Can the hot seat and online setup screens be one?~~ — **answered 2026-09-24: yes, with a "Play online" switch**

Andrei: *"we now have two screens that look almost the same, one is for an
online game and another for hot seat. When there is only one human player, the
difference is only in where the game is persisted. Yet the screens differ,
e.g. the hotseat screen has 2 players hardcoded, and I'm afraid they will keep
deviating. Can we unify these screens, with a simple toggle that tells us
whether the game we create is stored?"* Ten details it left open were put to
him with a recommendation each. He answered *"recommended options for 21 to 30
look good, except the wording in 28, which should say "play online""*.

21. **Player count:** a game on one device takes 2 to 5 players, as a stored
    one does. This replaces Q22's two seats.
22. **Seats:** every seat has Human and Computer buttons. In a stored game
    seat 1 is always the game master's, and every other Human seat is kept
    for someone who asks to join: accepting puts them in the first free Human
    seat, and a request can be accepted only while one is free. A Human seat
    still empty at Start is played by the computer. This replaces Q48 7 and
    12's acceptance order.
23. **No two people on one device in a stored game** yet.
24. **Thinking time** is set per computer seat, under its figures, as on the
    hot seat panel (Q41). This replaces Q48 15's one box.
25. **The switch:** turning it on stores the game at once, lists it and
    changes the page's address. Turning it off before the start removes the
    game; if anyone has asked to join or taken a seat, the game master is
    asked first, and they are told the game was cancelled.
26. **Where it opens:** the game list has one New game button, which opens the
    screen with the switch on; it replaces Q50's button. The login page keeps
    "Play on one device", which opens the screen without the switch.
27. **Game name:** a box under the switch while it is on.
28. **Wording:** the switch reads "Play online", with "Others can ask to join,
    and it stays in your games." under it.
29. **The game page artifact** shows the same screen without the switch.
30. **Where it lands:** in the phase 6 pull request (#19).

Where it lives: `apps/web/src/setup/SetupPanel.tsx` is the one screen, with a
local panel (switch off) and an online panel (switch on); `local.ts` holds the
setup that lives on one device and converts it to and from a stored one. The
seat rules are `packages/session/src/setup.ts`: an open seat is a Human seat
nobody holds (`isOpenSeat`), `setup.setSeatControl` turns a seat Human or
Computer, `setup.rename` renames the game, and `lobby.create` takes the seats
and seed the page already has.

<a id="q52"></a>
### Q52. ~~How do four or five player cards fit beside the map?~~ — **answered 2026-09-24: they scroll**

Q51 21's five seats made the play screen's player cards taller than a
computer window: with 4 players under about 920 pixels tall, or 5 under about
1080, they pushed Plan a move, Rest and End turn off the bottom. Of three ways
put to him (scroll the cards, shrink the cards of players not on turn, or move
the buttons above the cards) Andrei took the recommended one: the cards scroll
in their own column when they don't fit, and the buttons stay where they are.
Two or three players, and phones, look as before. `.players` in
`apps/web/index.html`.

<a id="q53"></a>
### Q53. ~~Does the column show the current player's card when their turn starts?~~ — **answered 2026-09-24: yes, it glides there**

Once the cards scroll (Q52), player 5's card can sit out of view on their own
turn. Andrei took the recommendation: at the start of each turn the column
glides until the current player's card shows, as the map glides to their
figure (Q46). Only the column moves, and only when the card is out of view.
`Players` in `apps/web/src/page/Players.tsx`.

In the same review he asked for superfluous wording to go from the new game
screen: its opening line no longer adds "All start on the plains node where
the figures stand.", and a seat's heading reads "Seat 3 · starts with 50
stamina" without "moves third". Asked which other lines could go, he took
the recommendations: the screen has no opening line at all ("Each seat takes
its turn on this screen, played by a person or by the computer." is gone),
the game master's line is just "You are the game master.", and a kept seat's
line and the "1 to 60" beside the thinking time stay.

<a id="q54"></a>
### Q54. ~~How does a player who lost the connection get back into a game in progress?~~ — **answered 2026-09-25: as recommended, for phase 7**

Andrei: *"we need to think through the scenario when a player got
disconnected and needs to go back to the game in progress. how does that
work"*. What was already settled went on a page with five open details,
numbered on from phase 6's, and he asked how "away" would be known: there was
no heartbeat. He took every recommendation (*"the recommendations are
good"*), to be built in phase 7.

Already settled: the whole game lives on the server, an open page reconnects
by itself, a closed one reopens from Your games, and on opening the page gets
the whole game including each player's saved route. The game waits on an
absent player's turn (§12.4), the game master may force their planned move or
a rest at any time (§7.3), and a game master's absence stalls everything,
computer turns included.

31. **Away:** a player with no connection shows an "Away" tag on their card,
    and on their turn the line above the buttons reads "Waiting for Bea, who
    is away. The game master can move Bea on." A **heartbeat** decides it:
    each open page sends a tiny message every 20 seconds, answered by
    Cloudflare without waking the game (`setWebSocketAutoResponse`); while a
    game is in progress the server checks those times every 20 seconds, and a
    player whose pages have all been silent for a minute, or who closed the
    game, is away. The page also uses the missing answers to notice its own
    dead connection and reconnect.
32. **Missed turns:** the turn log shows every turn of the game, the ones
    played while a player was away included; the map shows where everyone is
    now, without replaying walks. The server keeps a record of each turn, so
    a reload does not empty anyone's log either.
33. **Game master away:** their card shows "Away", and whenever the game is
    waiting on them, computer turns included, the line reads "Waiting for the
    game master, Andrei, to come back."
34. **Your turn while not looking:** the browser tab's title reads "Your turn
    · Adventure" while it is your turn, and Your games says "Your turn" on
    that game. There are no emails.
35. **Two devices:** one person may have a game open on several devices;
    whichever acts first counts, and the others see the result.

<a id="q55"></a>
### Q55. ~~How long does a stored game stay on the site?~~ — **answered 2026-09-25: a lifetime set at creation, 3 days by default, up to 14**

Andrei: *"we don't want finished games to stick around polluting the view,
and we want to garbage collect abandoned games as well"*. Until now nothing
was ever deleted: a cancelled game left the list but kept its data, and games
that never started or that everyone left stayed for good. He took details 36
to 41 as recommended and added: *"I'd make the lifetime explicit when a game
is created, with probably a shorter default (few people want a game to last
more than 3 days), and a possibility to extend the lifetime to 14 days."* The
details that raised, 42 to 47, he also took as recommended. All of it is for
phase 7.

36. **Finished games** stay in Your games for 7 days, marked "Finished · Bea
    won", with Open to see the final map and turn log, then leave the list.
    This replaces Q48 5, which took a finished game off the list at once.
37. **Deletion:** a finished or cancelled game is deleted from the server 7
    days after it finished or was cancelled; its old address then says "This
    game has ended and been removed."
38. ~~Games that never start are cancelled after 7 days with no changes.~~
    Replaced by the lifetime (47).
39. ~~A game in progress with no turn for 30 days ends and is removed.~~
    Replaced by the lifetime (47).
40. **The game master can end a game in progress** with "End the game", which
    asks first. It ends without a winner, everyone sees "The game master
    ended this game.", and it is kept and deleted like a finished game.
41. **Built in phase 7**, with Q54.
42. **The lifetime counts from creation**, so a game that never starts also
    goes when its time is up.
43. **Chosen on the new game screen** while "Play online" is on, under the
    game name: "Game lasts" 1, 3, 7 or 14 days, starting at 3, changeable
    until Start.
44. **Extending:** the game master can extend it at any time before it ends,
    a day at a time, up to 14 days from creation; everyone sees the new end.
45. **Time running out mid-game:** the game ends and the player holding the
    most gold wins, a tie shared, as the computer's simulated games do at
    their turn limit (Q44). It then follows 36 and 37.
46. **Time left** shows in Your games, the open games list and on the game
    page ("Ends Sunday 14:00"); in the last 24 hours it reads "Ends in 5
    hours" and is highlighted.
47. **The lifetime replaces 38 and 39**, since every game ends within 14 days.

**Who deletes:** each game deletes itself. A game is its own Durable Object,
which sets a Cloudflare alarm (`setAlarm`) for when its lifetime runs out and
another for its deletion 7 days after it ends; the alarm wakes it even with
nobody connected, and it ends the game or deletes its storage and takes its
row off the lobby's list. Extending moves the alarm. No scheduled job runs.

<a id="q56"></a>
### Q56. ~~How does a game play online, turn by turn?~~ — **answered 2026-09-25: as recommended, except the map, which gets a Track button**

Andrei started phase 7 (*"we are ready to proceed to phase 7"*). What the
plan, Q54 and Q55 left open went on a page as details 48 to 71, each with a
recommendation. He answered: *"recommended choices are largely good,
establishing that a multiplayer game's ui works the same way as hotseat.
However, for planning a move we can either be in the "follow the active
players" mode, or in "plan your move" mode. can we make these modes explicit,
with a 'track' button that is actually a toggle — it unpresses itself when you
start panning, zooming and planning, and by pressing it you go back to
watching other playerd move"*. So every detail is as recommended except 52;
the Track button's own details are 72 to 77, answered as [Q57](#q57).

48. **Someone else on turn:** the map and cards as in hot seat, the figure on
    turn blinking. The line above the buttons reads "Bea is playing. You can
    plan your next move.", or for a computer "Computer 1 is thinking…" over
    its filling bar. Plan a move and Find are there; Rest and End turn appear
    on your turn.
49. **Planning out of turn** looks as on your own turn: your figure is
    highlighted and the route is coloured for your next turn, with your
    speeds' free steps refreshed. When your turn comes the route is drawn and
    End turn plays it.
50. **Only your own route is drawn**; everyone's saved route is kept on the
    server, since Move on (54) plays it.
51. **Another player's turn plays out as in hot seat**: their route drawn, the
    walk, the die, an unguarded claim floating up. Their fight card closes
    itself after 3 seconds as a computer's does (Q42); only your own waits for
    OK. A route you were planning steps aside while they walk and comes back.
52. ~~The map glides to whoever is on turn and follows walks, except while you
    have a route open.~~ **Changed:** an explicit Track toggle. While it is
    pressed the map follows the players on turn; panning, zooming or planning
    unpresses it; pressing it goes back to watching. The notice "Your turn" or
    "Bea's turn" stays. Its details are [Q57](#q57).
53. **Your planned move is the route you have drawn**, saved on the server as
    you draw it, so it survives a reload and shows on your other devices. End
    turn plays it and so does Move on; Cancel clears it, and a player moved on
    with no route rests (§7.3).
54. **Move on:** on another person's turn the game master has "Move Bea on",
    away or not, which asks "Play Bea's saved route now? With none saved, Bea
    rests." and plays exactly as Bea's own End turn or Rest. The turn log
    marks it "Moved on by the game master".
55. **Races** (Q49's rule): whichever reaches the server first is played. If
    Bea was first the game master sees "Bea ended the turn first."; Bea sees
    "The game master moved you on." whenever it happens, and her End turn then
    does nothing. The route the server held when Move on arrived is the one
    played.
56. **The end time** shows in the top bar for everyone ("Ends Sunday 14:00").
    For the game master it is a button opening a small panel with "Add a
    day", until 14 days from creation (Q55 44), and "End the game", which
    asks first (Q55 40).
57. **Resigning is built now.** Everyone in the game, the game master
    included, has "Resign" in the top bar, which asks first. The computer
    then plays the seat with 10 seconds' thinking, the card reads "Resigned ·
    the computer plays", and the person can still watch and post. Handing the
    seat back is the game master's and stays in phase 8 (§7.3). This replaces
    Q48 17's "resigning to the computer" in phase 8.
58. **The board** opens from a "Messages" button in the top bar beside Turn
    log, where the turn log opens; opening one closes the other.
59. **A post** shows the writer's figure, name and time ("Bea · 14:02", with
    the day if not today), oldest at the top, with a box and Send at the
    bottom; up to 500 characters. Everyone holding a seat can post from Start
    until the game is removed, after it ends too. The computer never posts.
    Posts cannot be edited or deleted.
60. **New posts:** while the board is closed its button counts the posts not
    yet seen on that device ("Messages 2"). No sound, nothing over the map.
61. **The end card** is hot seat's with "Your games" in place of "New game".
    A time-out reads "Time ran out. Bea held the most gold, 34 against 20.",
    or on a tie "Time ran out with Bea and Cal on 34 gold each."; a game the
    game master ended reads "The game master ended this game.", with the
    table and no winner.
62. **A game whose time runs out before it starts** is cancelled: it leaves
    the lists at once, and anyone opening it in the next 7 days reads "This
    game ran out of time before it started." Then it is deleted (Q55 37).
63. **Your games rows:** waiting, "Game master: Andrei · waiting for players,
    2 of 3 · Ends Sunday 14:00"; started, "Game master: Andrei · started ·
    Ends Sunday 14:00", with a highlighted "Your turn" at the front on your
    turn (Q54 34); finished, "Finished · Bea won", "Finished · Bea and Cal
    share the win" or "Ended by the game master". The end time is highlighted
    in its last 24 hours (Q55 46).
64. **Games already on the site** when phase 7 goes live get the 3-day
    default counted from that moment, so none disappears on the day.
65. **Online dice are drawn fresh** from Cloudflare's unpredictable random
    source, with no seed, and the online log's first line names only the map
    seed. Every roll is still in the log.
66. **A game on one device survives a reload** (Q37, postponed to here): it
    is kept in that browser, on the site and on the game page. New game still
    starts over, and another device does not see it.
67. **The last hour** counts minutes ("Ends in 40 minutes"); the highlight is
    bold, in the gold of the winner's card.
68. **Six days or more ahead** the end time adds the date: "Ends Sunday 4
    October 14:00".
69. **"Game lasts"** is a row under the game name like the Players row: "1
    day", "3 days", "7 days", "14 days", for the game master only; a length
    the game is already older than is greyed out.
70. **"Away"** sits on the card's second line after the seat: "Seat 2 ·
    Away", or "Turn 12 · playing now · Away".
71. **While the page is reconnecting** the line above the buttons reads
    "Reconnecting to the server…" and Rest and End turn are greyed out until
    it is back; a route can still be planned.

<a id="q57"></a>
### Q57. ~~How does the Track button work?~~ — **answered 2026-09-25: as recommended**

His answer to Q56 52 asked for the two ways of using the map to be explicit:
a Track button that is a toggle, unpressed by panning, zooming or planning,
and pressed to go back to watching the players move. What that left open went
on the same page as details 72 to 77, each with a recommendation. Andrei:
*"72 to 77, recommended choices look good"*.

72. **Where and how it looks:** with the map's own buttons at the bottom
    right, above "+", reading "Track". Pressed, it is filled in the blue of a
    picked option, as "Waypoint" is while it is on. It shows while the game
    is in progress.
73. **What unpresses it:** anything that moves the map or starts planning:
    dragging the map, the mouse wheel, pinching, "+", "−", "Whole map",
    "Find", tapping your figure or "Plan a move". A tap on the map that
    starts nothing leaves it pressed.
74. **While pressed** the map does what hot seat did: at the start of each
    turn it glides to the player on turn at the zoom it has (Q46), and it
    follows a walking figure that nears the edge (Q47). Pressing it glides
    the map at once to the player on turn, or to the figure that is walking.
75. **Your route** stays drawn and saved when you press Track (Q56 53):
    planning closes, and End turn still plays the route. Tapping your figure
    opens it again for changes, which unpresses Track.
76. **It presses itself** when you open a game and when you press End turn or
    Rest. Otherwise only you press it, so when your turn comes while you are
    planning, the map stays on your route.
77. **A game on one device has it too.** There it also presses itself at the
    start of every turn, since a new person is at the screen, which keeps hot
    seat moving the map as before.

`tracking` in `apps/web/src/page/GameScreen.tsx`; the button and the
following in `MapView.tsx`; `putDown` in
`apps/web/src/interaction/moveMode.ts` closes planning.

<a id="q58"></a>
### Q58. ~~How does the play screen fit a small screen?~~ — **answered 2026-09-25: as recommended**

Play-testing on his Galaxy Fold (folded about 340 × 690, open about 620 × 590)
the player cards left the map a strip. His direction: *"one row is definitely
the way to go on portrait screens, but shouldn't we change to side buttons in
landscape? We should also look for ways to save space on small screens. The
log message, for example, can fit to the right of the buttons."* The details
page put 78 to 85 to him with mock-ups, and 86 and 87, two side effects of the
fix for a computer's move lost to a dropped connection that had been built
without asking. Andrei: *"maps335, 321, and the last map for the phone turned
sideways are the way to go"* (78 and 80 to 85, as recommended and pictured),
*"for 86 and 87, yes, please proceed as recommended"* and *"yes, the row
should follow the turn, showing the active players card"* (79).

78. **One row of cards** on phone screens (narrower than 900): the row scrolls
    sideways, each card a little under half its width and never narrower than
    180, so two show whole and the edge of the next shows there are more. The
    cards themselves are unchanged.
79. **The row follows the turn:** at the start of each turn it slides so the
    card of the player on turn is in view, as the map glides to their figure
    (Q46).
80. **Landscape** is a phone screen at least a third wider than it is tall
    (4:3). The unfolded Fold, nearly square, keeps the one-row layout.
81. **In landscape** the cards are a column down the left, 300 wide, scrolling
    when they do not all fit, with the line and the buttons under them; the
    map takes the rest, and the top bar fits on one row.
82. **The line beside the buttons** on screens 560 to 899 wide: to the right
    of Rest, End turn and the others. Narrower screens keep it above them.
83. **The game's name and seed** sit on the same row as "Adventure" on
    phones, cut short with "…" when there is no room.
84. **One Menu button** on portrait phone screens opens Resign, Your games,
    Turn log and Messages as a list, and carries the count of unseen messages
    ("Menu 2"). The end time stays in the bar. In landscape the four buttons
    stay in the bar.
85. **The map's buttons in a row** on phone screens in both layouts: Track,
    "+", "−" and "Whole map" along the bottom right of the map, a little
    smaller.
86. **While a computer's move waits for the connection** the line reads
    "Reconnecting to the server…", as on your own turn (Q56 71), with the
    computer's route drawn.
87. **No notice for a computer's move** that could not be sent: "The
    connection to the server dropped. Try again once it is back." stays out,
    since there is nothing to try again.

Two details were settled while building 84 and 85 rather than asked first,
and shown to him with the screenshots of the result: the Menu's list opens
under the top bar at its right and closes when an item is pressed or anything
else is tapped, and on phones the notice sits above the new row of map
buttons, which it would otherwise cover. Andrei: *"the screenshots look good,
let's proceed"*.

The layout is CSS in `apps/web/index.html` (the play screen) and
`apps/web/src/online/site.css` (the top bar and Menu); 79 is in
`apps/web/src/page/Players.tsx`, 84 in `OnlineGameScreen.tsx`, 86 in
`TurnControls.tsx`, and 87 in `onlinePlay` in `apps/web/src/modes/play.ts`.

<a id="q59"></a>
### Q59. ~~How does the new art go in?~~ — **answered 2026-09-27: as recommended, except sizes, guard sizes and contours**

On 26 September Andrei sent eleven sheets of new art in the thread "New art
experiment": six player figures, plains dressing, forest trees, magic guards,
combat skill POIs (*"POIs that reward Combat skills"*, correcting his first
label), magic POIs, forest speed POIs, two sheets of combat guards for gold
(the second *"to add variety"*), plains gold castles, plains speed POIs and
mountain speed POIs. *"The images for mountains stay the same."* Of the plains
dressing: *"There will be no separate 'fields', they didn't look good to start
with. It may make sense to put the bushes in small clusters."* Where each goes
was settled by his labels; what that left open went on a details page as 88 to
105, each with a recommendation. He answered 90, 91 and 101 in his own words
and then *"the rest of the recommendations regarding the new art sound good to
me"*, 105 included.

88. **Tried on a branch of its own,** with a second game page carrying the new
    art; today's page stays as it is, and main and the live site keep today's
    art until he merges.
89. **Shadows dark and see-through,** as today's: the grey of each shadow
    becomes black at today's strength, keeping its shape and soft edge, the
    magic guards' solid shadows included. Sizes and positions are measured on
    the picture alone.
90. **Sizes, in his words:** *"let's make the buildings a little larger than
    shown (0.5 instead of 0.42), and the magic and combat POIs the same 0.5 as
    well. I may ask you to adjust that, but that would be my first guess."*
    So plains, forest and mountain speed POIs, magic POIs and combat skill
    POIs are 0.5; figures stay 0.45, trees 0.55 and castles 0.58.
91. **Guards:** *"for guards, let's keep all of them at 0.6"*, combat and
    magic alike.
92. **Plains dressing 0.2** for a typical piece, each keeping its size
    relative to the others as drawn.
93. **The new sheet replaces today's grass and rocks** as well as the fields.
94. **The bushes that cluster** are the five in the middle row of his sheet.
95. **A cluster** is 2 to 4 bushes, each picked at random from the bushes so a
    cluster mixes kinds, close enough to touch, those behind partly hidden by
    those in front, scattered rather than in a row. Every bush comes in a
    cluster; a bush that would stand on a road or a node is left out, and a
    cluster left with one bush is not placed.
96. **0.9 pieces for every plains node,** as today, each bush of a cluster
    counting as one, and every piece on the sheet equally likely to be picked.
97. **All 24 combat guards** stand on mountain and forest gold alike, one per
    POI, on its node as today (Q35); forest gold still borrows them (Q20).
98. **Plains gold is its castle alone,** as today; the red ring and number say
    it is guarded (Q31).
99. **Stamina POIs borrow the new red-roofed houses,** as they borrowed the
    cottages (Q20).
100. **No brightness or colour boost** on the new houses and magic buildings.
101. **No contours:** *"new art should not need any contours, hopefully it's
    visible enough on its own"*, guards included.
102. **The six new characters replace today's six,** in his sheet's order, so
    each seat's first choice is by position as today.
103. **Portraits are crops of the new figures,** head and shoulders, cut the
    same way until his head-and-shoulders set arrives (Q26).
104. **Replaced pictures are deleted** from `Art/` when the new art goes onto
    main; the repository's history keeps them.
105. **Stamina POIs grow to 0.5** with the houses they borrow.

His sheets are kept as supplied in `Art/originals/`, and
`Art/tools/pack_sheets.py` packs them into the game's sheets and atlases and
makes their shadows dark (89). Clusters are `clusters` on the plains dressing
in `Art/manifest.json`, laid out in `placeDressing` in
`apps/web/src/render/dressing.ts`. Four details the page did not settle were
built one way before he was asked, which the ask-first rule forbids; they are
[Q60](#q60), asked on the page as 106 to 109 and since answered.

<a id="q60"></a>
### Q60. ~~Four details of the new art found while building~~ — **answered 2026-09-27: as recommended, except 107, where three faces are centred**

Building [Q59](#q59) turned up four details its answers do not settle. Each
was built one way, and shown to Andrei on the game page and screenshots, before
he was asked; that breaks the rule to ask first, so none counted as settled
until he answered.
They are on the details page as 106 to 109, each with the built version as the
recommendation. On 27 September at 05:49 he answered: *"everything
recommended in 106 to 109 looks good, except for the portraits (107). Here
some of them (specifically the 2nd, 3rd and the 5th, counting from the left)
need to be shifted to the right so that the face appears in the center"*.

106. **The amber slime's shadow.** Every other shadow is found as grey that
    touches the clear canvas in the lower half of the picture, and made dark
    (89). The slime's is tinted orange and ringed by its own glow, so it is
    not found, and keeps the shadow it was drawn with, a faint brownish patch.
    Recommended: keep it as drawn. Or: its shadow is marked out by hand for
    that one picture in `Art/tools/pack_sheets.py` and made dark like the
    others.
107. **How much of a figure a portrait shows.** The crop's side was a third of
    the figure's height (`SIDE_FRACTION` 0.32 in
    `Art/tools/make_portrait_crops.py`), set for the first six figures; the
    new figures' heads are larger and a third shows a face alone.
    Recommended: half the figure's height (0.5), head and shoulders. Or: a
    third, as before. **Half, and the 2nd, 3rd and 5th figures' crops are
    centred on the face:** a backpack or basket beside their heads pulled the
    measured head centre off the face, so `FACE_X` in the tool sets their
    face centres by eye, between the eyes. The 1st, 4th and 6th are as they
    were.
108. **How close the bushes of a cluster stand.** 95 says close enough to
    touch, those behind partly hidden. As built, a quarter of a bush's width
    nearer than edge to edge (`CLUSTER_TOUCH` 0.75 in
    `apps/web/src/render/dressing.ts`). Recommended: as built. Or: just
    touching (1.0).
109. **How common bushes are.** 96 makes every piece of the sheet equally
    likely to be picked, each bush of a cluster counting as one piece. As
    built the chance is per pick, and a picked bush brings its whole cluster,
    so the 5 bushes of 25 pieces are about 4 pieces in 10 on the map (221 of
    582 over six seeds). Recommended: as built. Or: each piece on the map
    equally likely to be any of the 25, so bushes are 1 in 5.

<a id="q61"></a>
### Q61. ~~How do the reward icons become more visible?~~ — **answered 2026-09-27: as recommended, except the size and the players' cards, plus a beige fill**

On 27 September at 13:40 Andrei asked: *"we need to make reward icons more
visible. let us place the combat reward, the forest speed reward and the
mountains speed rewards on a white circle slightly larger than the icon, with
red contour for combat, green contour for forest speed, and black contour for
mountains speed. The plains speed, magic and gold already have round shapes,
so we can simply grow them slightly to make all icons the same size. Grow the
stamina icon to match this size as well, but don't add anything to it"*. What
that left open went on a details page as 110 to 118, each with a
recommendation, before anything was built. At 15:36 he answered: *"110, I
actually prefer them at 0.24. 115, let us leave the icons as today, they look
nicer that way. The rest of the recommendations sound good to me"*, and asked
for two more things: *"change the white in the circles to slightly beige, eg
RGB=(230, 220, 210)"* and *"add a beige-filled circles under the wagon wheel
icon as well, so the gaps between spikes and the center are of that color"*.

110. **Every icon is 0.24** of a road length across its longer side, up from
    0.18 (his number): a circled icon's disc, the wheel, magic and gold, and
    the heart, which is a little wider than tall, by its width.
111. **The picture spans about four fifths of its disc** (0.82), measured by
    the smallest circle round the picture.
112. **The crossed swords fit wholly inside their disc,** with the same room
    as the foot and the mountain, so they come out smaller than those two.
    Changed on 10-03 by [Q230](#q230): the swords now reach over the contour.
113. **The contour is 4% of the disc's width,** as thick as the black rims on
    the wheel, magic and gold.
114. **Each contour is its picture's own colour:** the swords' red `#b71b1c`,
    the foot's green `#1d8b28`, and black for the mountain.
115. **The players' cards and the end-of-game table keep today's icons,** in
    his words, the wheel included.
116. **Stacks overlap as today,** each further icon 0.42 of its width along
    and drawn over the one before.
117. **The guard's number keeps its size** and sits just after the row of
    icons, as today, so it moves right as the row gets wider.
118. **Pictures, trees and bushes keep clear of the bigger icons** by the
    rules they follow today, so on the same map a few trees and bushes stand
    elsewhere and now and then a POI picture stands on the other side of its
    node.

The discs are beige, `#e6dcd2`, his (230, 220, 210), where the page had
white. The wheel has a disc of the same beige under it, as wide as the wheel
and stopping inside its black rim, so the gaps between the spokes and the hub
show beige and nothing shows round the wheel. Nothing is added to magic, gold
or the heart.

The icon files are unchanged. The discs are drawn as the icons load, from
`icons.backing` in `Art/manifest.json` (`iconCanvas` in
`apps/web/src/render/pixi/textures.ts`), which is why the cards, which show
the files, keep today's icons.

### Q63. How do the sound effects work? — **answered 2026-09-28**

On 27 September at 17:05 Andrei asked: *"we need at least minimal sound
effects, for moving, picking up a reward, winning a battle and losing a
battle"*. The game made no sound before. What that left open went on a
details page as the sound details 126 to 141 (not the computer-player
thread's 126 to 131), each with a recommendation and, for 127 to 130, three
samples to choose from by ear, before anything was built. On 28 September at
00:22 he answered: *"My choices of sounds are: 127: B, 128: A, 129: B, 130: A.
131-140 as recommended. 141 - come to think of it, we need the resting sound
and the "new message" as well, for a complete minimal set. The others can
wait"*.

126. **The sounds are made here** by `Art/tools/make_sounds.py`, standard
    library only, and marked as placeholders. Not answered by number: all
    four of his picks are samples made that way. Each is a file under
    `Art/Sounds/` with a line under `sounds` in `Art/manifest.json`, so any
    of them can be replaced by dropping in a file.
127. **Moving: a wooden figure tapping the board** (B).
128. **Picking up a reward: two rising chimes** (A).
129. **A battle won: four rising chimes** (B).
130. **A battle lost: two falling horn notes,** the second sagging (A).
131. **A footstep each time the walking figure reaches the next node,** so a
    six-node walk is six steps, 0.22 seconds apart.
132. **One footstep on every terrain.**
133. **Three slightly different takes of the step, used in turn.**
134. **One pickup sound for every reward kind,** as the figure lands on an
    unguarded POI and its floating notice appears.
135. **A battle won plays only the battle-won sound,** not the pickup too.
136. **The battle sounds play when the die stops** and the card shows the
    result. The die tumbles silently.
137. **Combat and magic guards share the battle sounds.**
138. **Every turn the map plays out is heard:** your own, the other people's
    on one device, the computer's, and online the other players' turns as
    you watch them. Turns shown without a walk stay silent: those caught up
    after a dropped connection, and those already in the log when a game
    opens.
139. **A Sound button in the map's row of buttons, left of Track,** pressed
    while sound is on, as Track is while it follows. Sound starts on, and
    each device keeps its own choice.
140. **One fixed level, no slider.** The four are balanced, measured as a
    phone's speaker plays them, the footsteps quieter because they repeat.
    The device's volume sets how loud, and an iPhone's silent switch silences
    the game too.
141. **A rest and a new message get sounds too;** the other moments listed
    (the end of a game, "Your turn" online, button taps, the die rattle) stay
    silent for now.

What those two sounds needed, and two things the build turned up, went on
the same page as 142 to 146. At 01:29 he answered: *"142 - please use option
B; 143 - please use B as well. The rest are as recommended. Can the "Sound"
button use a volume / speaker icon or a webding symbol?"*

142. **A rest: a soft breath out** (B), as the rest is shown: the turn passes
    and the resting player's stamina goes up on their card. Every rest the
    map plays out is heard, as by 138. Staying put on a node is a move, not a
    rest, and makes no rest sound.
143. **A new message: two knocks on a door** (B; C, two rising plucks, was
    recommended).
144. **A message from someone else is heard as it arrives while the game is
    open,** whether the board is open or closed and whether the page is in
    front or behind another. Your own messages, and those already on the
    board when you open the game, make none; several arriving together, as
    after a dropped connection, make one sound. A phone may pause a page it
    has put behind another, and a paused page is silent until it is back.
145. **The Sound button stays after a game ends,** on one device and online,
    where Track goes.
146. **The button row on a folded Fold.** Recommended was A, less space round
    the buttons' words below 360 pixels wide; he asked instead whether the
    Sound button can show a speaker symbol. With a symbol in place of the
    word the row fits at 340 pixels. How it looks went on the page as the
    sound details 170 to 172 (the computer-player thread has 147 to 150),
    with pictures, and at 02:53 he answered: *"the recommendations for
    170-172 look good, please proceed"*.

170. **A speaker drawn into the game,** not a font's or the device's own
    emoji: Webdings is a Windows font that phones don't have, and each maker
    draws the emoji differently. It takes the colour of the button's words,
    dark, and blue while pressed, and looks the same everywhere.
171. **Sound off shows twice:** the speaker trades its two sound waves for a
    small cross, and the button is no longer pressed.
172. **The spacing stays as it was on every screen;** 146 A is not built. With
    the speaker the row fits a folded Fold with 18 pixels to spare.

The footsteps are timed by the sound's own clock from the moment the walk
starts, so they keep the walk's pace however smoothly the map draws
(`apps/web/src/sound/player.ts`, `apps/web/src/page/GameScreen.tsx`). A
browser lets a page make sound only once the person has tapped or typed on
it, so nothing plays before the first tap.

### Q66. ~~One K for the map and the computer?~~ — **answered 2026-09-28: two settings**

On 28 September Andrei asked for simulations of the computer player looking at
the 15 closest places instead of 10. `CLOSE_CANDIDATE_COUNT` was still the one
K of [Q19](#q19), read by §5.1's remoteness walk as well as §9's rollout and
tree, so changing it would also have moved every generated map. At 14:13 he
ruled: *"the maps should be kept as is; if we change the setting for the number
of the closest places, it should affect computer player only. I was in fact
thinking of lowering this number for map generation, so these two definitely
need to be separated"*, and at 14:14: *"yes, let's split it in a small
independent pr"*.

So §5.1's walk reads a new §11 row, `REMOTENESS_CANDIDATE_COUNT`, and
`CLOSE_CANDIDATE_COUNT` is the computer player's alone, for the rollout and the
tree together. Both are 10, so no map and no move changed:
`closestPoiCandidates` and `chooseWalkTarget` now take K from their caller
rather than reading it from the config.

<a id="q70"></a>
### Q70. ~~Does the map seed need its Draw button?~~ — **answered 2026-09-28: no, as recommended**

On 28 September, in the thread about a Rules button, Andrei asked: *"Can we get
rid of the "Draw" button? The map is drawn when you press enter in the seed
field, or when the seed field loses focus"*. Enter already drew the map;
leaving the field did not. Three details went to him with pictures, and at
19:35 he answered: *"225-227 the recommendations sound good"*.

225. **Both setup screens lose Draw:** the game on this device, and the game
     master's setup of an online game. Enter draws the seed typed, and so does
     leaving the field.
226. **A field left empty gets the current seed back** when it is left.
     Before, it stayed empty.
227. **Random pressed straight after typing draws only its own map,** not the
     typed seed first.

Random takes Draw's place. On a desktop nothing else moves. On a folded phone
(340 wide) the seed bar loses a row on both screens and the setup form under
the map gets the room; the map keeps its 180. Both screens use the one field in
`apps/web/src/page/SeedForm.tsx`.

<a id="q71"></a>
### Q71. ~~Where does a Rules button go?~~ — **answered 2026-09-28/29: a Menu on phones, none before a game starts, and the rulebook from the repo over the game**

On 28 September Andrei asked: *"I have the rules distilled from GDD.md in
https://claude.ai/code/artifact/9a233211-bc03-4a3d-af5c-ca9ade3eaca0 Is there
a convenient place in the UI to place a button that opens the rules page?"*
The first options all gave a phone's top bar a second row, and at 19:05 he
ruled them out: *"I don't like any of the "second row" options. It's ugly to
start with. And if it encroaches on the map size the game becomes
unplayable"*. At 19:50 he answered: *"220: yes, putting Rules in the menu is
the sensible option / 221: yes, except maybe the game start screen where the
only place for it is next to the word "Adventure". It may be the same style as
"Adventure" but on the right side / 222: no second row, we already ruled that
out"*, at 20:03: *"yes, 228-230 [...] the recommended options look good"*, and
at 20:05: *"223: lets try the new tab, I'll experiment with it on a real phone.
224: sure, let's look at it separately"*. The start screens' "Rules" in the
style of Adventure then turned out to add a row on common phones 390 to 430
wide (231), and on 29 September at 00:29 he ruled: *"Let us simply remove the
Rules button from the Start screens. Users don't need to read the rules before
the game in on."* Rules then opened his Claude Docs page by its address, and at
01:05 he asked for that to change: *"I don't like having this kind of outside
dependency. Can we source it from the same repo everything else is in"*. At
01:38 he answered: *"232-235 your recommendations are good"*, and at 02:35,
after pictures: *"looks good, proceed with recommended options"* (236 to 238).

220. **A Menu on phones:** on a desktop, and on a phone turned sideways, Rules
     is at the right end of the top bar. On a phone held upright each bar's
     buttons share one Menu button, as the online game's already did
     ([Q58](#q58), 84), with Rules last: the game on this device (New game,
     Turn log, and on the site Your games), the game list (New game, Log out)
     and the online game (Resign, Your games, Turn log, Messages).
221. **"Rules", in the bar buttons' style.**
222. **No second row** on a phone.
228. **The start screens** are those before a game starts: the setup of a game
     on this device, the login page, and an online game's setup for the game
     master and for players.
231. **No Rules on the start screens** (replacing 221's title style there, and
     229 and 230). They are as they were.
232. **The rulebook is `docs/RULEBOOK.md`,** copied from his page as it stood,
     and from now on changes to the rules go through a PR like everything
     else. The game no longer opens his page or any other address. The first
     such change is [Q75](#q75)'s starting stamina (30, 35, 40, 45, 50), which
     he asked for on 29 September at 03:32.
233. **Over the whole game, with a Close button** (replacing 223, the new tab).
     The game stays where it is underneath. The same on the game page and on
     the site.
234. **The game's own fonts and colours,** with headings in the style of the
     word Adventure.
235. **The rewards table keeps his words** for each icon ("Brown wagon wheel"),
     not the game's pictures.
236. **Closing it:** the Close button, Esc, or on a desktop a click outside it.
     While it is open the game's own keys do nothing, so Esc does not also put
     down a planned route.
237. **No date and byline** under the title: the line "Sep 27, 2026 ·
     @Andrei" from his page is left out of the file.
238. **The game doesn't pause** while the rulebook is open: a computer's turn,
     or another player's turn online, plays out behind it.

No bar is taller and no map smaller on any screen at the common sizes checked.
224, the online game master's bar that already takes two rows on a folded
phone (and on a phone turned sideways, where Rules follows Messages on the
second row), is to be looked at separately. The button and the rulebook's
window are in `apps/web/src/page/Rules.tsx`, the reading of the file in
`apps/web/src/page/rulebook.ts`, and the Menu in `apps/web/src/page/BarMenu.tsx`.

<a id="q72"></a>
### Q72. ~~How does the online game's bar keep one row?~~ — **answered 2026-09-29: the Menu on every phone, shorter end times on phones, the name cut short, and Games**

At 19:15 on 28 September, while placing Rules ([Q71](#q71)), Claude reported
that the online game master's bar already took two rows on a 340 px phone
because the end time is wide (224), and Andrei answered at 20:05: *"224: sure,
let's look at it separately"*. Looking at it on 29 September showed that the
bar's rows depend on the end time's words (*"Ends in 23 hours"*, *"Ends Friday
05:10"*, *"Ends Wednesday 14:00"*, *"Ends Wednesday 30 September 14:00"*), and
that for some of them Rules had added a second row on a phone turned sideways
and on a 1024 px wide desktop, which the check for Q71 had missed. At 18:45
Andrei answered: *"Yes to 280, 281 and 282. It looks like having the menu is
the safe choice and should be applied more widely"*.

280. **The Menu on a phone turned sideways too,** in the online game: Resign,
     Your games, Turn log, Messages and Rules go into Menu there as on a phone
     held upright.
281. **Shorter end times on a phone** (below 900 px wide), in the online
     game's bar: *"Ends Wed 14:00"*, *"Ends 30 Sep"* six days or more ahead
     (the time appears once it is closer), *"Ends in 45 min"* in the last hour,
     and *"Ends in 23 hours"* as before. Desktops and the game list keep the
     full words.
282. **The game's name and seed are cut short** with "…" in the online game's
     bar when it is full, as on phones, rather than pushing buttons to a second
     row (a 1024 px wide desktop).

283. **The Menu on every phone turned sideways:** the game on this device (New
     game, Turn log, on the site Your games, Rules) and the game list (New
     game, Log out, Rules) as well as the online game. They fitted on one row
     there already; this makes every phone work the same way.
284. **Your games in a Menu before a game starts,** on a phone: the site's
     "Play on one device" and an online game's setup, for the game master and
     for players. On a phone held upright the title, the end time and Menu
     share the first row and the seed field takes the next, so the game
     master's bar goes from three rows to two and a player's is one row.
285. **Desktops keep their buttons in the bar,** since every bar there is one
     row.

Where else the Menu goes (*"applied more widely"*) was asked as 283 to 285, and
at 19:28 he answered: *"proceed as recommended on 283-285"*. At 19:52 he asked
*"So the Menu on a phone before start has only one item, Your Games?"*, and at
19:55: *"Well, "Your games" beings one to the screen that shown both your games
and open games. So it can be safely called "Games", right?"* Asked as 286 and
287, at 19:56 he answered: *"Yes to both 286 and 287"*.

286. **"Games"** is the name of every button that opens the game list: in the
     online game's bar and Menu, before it starts and once it is finished, on
     the site's "Play on one device", and in the window at the end of an
     online game. The game list's own heading "Your games" stays, since it
     names the list of your own games.
287. **Games is a plain button before a game starts,** not a Menu holding
     only Games. It is about as narrow as Menu, so the bars keep the rows of
     284.

The Menu is `apps/web/src/page/BarMenu.tsx`, the words
`apps/web/src/online/ends.ts`, the online bar's rules
`apps/web/src/online/site.css`.

<a id="q75"></a>
### Q75. ~~How much more stamina for a later seat?~~ — **answered 2026-09-29: 5 instead of 10**

On 28 September Andrei asked for computer-only games with four players at 3 s
a move, to judge what stamina bonus for not moving first is fair. With §11's
increment of 10 (30, 40, 50, 60), the later seats ended with more gold: over 39
games seat 1 averaged 8.9 gold and seat 4 12.7. He then asked for the same
games with 5 (30, 35, 40, 45): over 100 games the seats won 22, 21, 27 and 20
outright, with 10 shared wins and average gold 10.6, 10.5, 12.0 and 10.8, a
spread luck gives about 3 times in 4. On 29 September he ruled: *"great, let's
make it so: 5 stamina instead of 10 for not going first"*.

So `STARTING_STAMINA_INCREMENT` is 5 in §11, and seats start with 30, 35, 40,
45 and 50. `STARTING_STAMINA_BASE` stays 30.

<a id="q80"></a>
### Q80. ~~How are sites marked so a player doesn't miss one by a space?~~ — **answered 2026-09-29: a road-brown dot in the middle of every site's node until it is claimed**

On 29 September at 01:39 Andrei asked: *"When I play i often miss a site by one
space because the map is a bit crowded. We need to mark sites better. THe
guarded ones are no problem since they have the colored outline. What can we do
to the other ones? I think even a dot, or a small cross in the middle can help.
Or change their outlines a little?"* An unguarded site's node was drawn exactly
like a plain node, with its picture beside it, so on a crowded map the node it
belongs to was easy to mistake for a neighbour. Five marks went to him in
pictures (a dot, a cross, a thicker outline, a white ring, a light fill). At
03:26 he answered: *"i like the dot in the middle. But then, we need to put it
on guarded sites as well, can you show me how it will look? And when a site is
claimed, the dot needs to disappear"*, at 03:41: *"i liked the way tapping
worked, not ready to change it now"*, and at 03:42: *"one more thing to
experiment with is the color of the dot: brown as the site outline, or the
color og the reward icon"*. At 05:07 he asked to see *"the dot size 0.55 color
of the roads (lighter brown)"*, and at 05:42 he ruled: *"The road color and
size 0.55 work. The dot goes away once the reward is claimed."*

260. **A dot in the middle of the node.**
261. **The brown of the roads,** the road brush's main colour (`#966a3e`),
     rather than the darker brown of the outline or the reward icon's colour.
262. **0.55 of the node's width across,** inside its black outline.
263. **Every site,** whatever its reward, stamina included.
264. **It goes when the site is claimed,** with the site's icons.
265. **Guarded sites get it too,** inside their guard's ring (his change to the
     recommendation that they stay as they were).
266. **Whatever covers a node today covers the dot:** figures, a planned
     route's markers and cross, the waypoint flag and the ring round the player
     whose turn it is.
268. **Tapping and clicking are unchanged:** a tap still picks the nearest node,
     or a site's picture.
269. **A guarded site's dot is the same road brown,** not its guard's colour.

267 (moving pictures and icons out for a wider outline) and 270 (the colour of
a stamina site's dot if dots took the reward's colour) fell away with the
choices above. Nothing else changed: the node, its outline, the guard's ring and
where each picture and icon stands are as they were. The dot's size and colour
are `nodes.site_dot` in `Art/manifest.json`; it is drawn with the nodes in
`apps/web/src/render/pixi/renderer.ts` from `siteDot` in
`apps/web/src/render/sceneModel.ts`.

<a id="q85"></a>
### Q85. How does the game master force a turn, resign a player, extend, end the game and delete a post? — **answered 2026-09-29: as recommended, except where Resign goes and a trash bin for Delete; 302 to 307 answered**

On 29 September at 07:41 Andrei asked: *"i think it's time to implement GM
actions: force a player's turn, force a player to resign, extend the game's
lifetime, end the game (with victory determined by current gold.) I thonk we
also need the ability to delete messages from the message board (for the case
when someone starts posting inappropriate content)"*. Three were already in
online games: Move on (Q56 54), Add a day (Q55 44) and End the game, which
ended with no winner (Q55 40). Details 290 to 301 went to him on a page with
pictures. At 12:40 he answered: *""Resign Bea" should go next to "Move Bea on".
This way you can only resign the current player, but that's OK."*, *"Please use
the trash bin icon instead of the word "Delete" for messages"* and *"The rest is
fine as recommended"*.

290. **Move on and Add a day stay as they are,** the 14-day limit included.
291. **End the game gives the win to the most gold,** a tie shared, as when
     time runs out. It replaces Q55 40's ending with no winner; there is one End
     the game button.
292. **Its question names the winner:** "End the game now? Bea wins with the
     most gold, 34." or "End the game now? Bea and Cal share the win on 34 gold
     each."
293. **Afterwards** the end card is titled as for any win and reads "The game
     master ended the game. Bea held the most gold, 34 against 20." or "The game
     master ended the game with Bea and Cal on 34 gold each."; Your games shows
     "Ended by the game master · Bea won" or "… · Bea and Cal share the win". A
     game ended before this, with no winner, still reads as it did.
294. **Resigning a player works like their own Resign** (Q56 57): the computer
     plays the seat from then on, thinking 10 seconds a move; figure, stats,
     gold and place in the turn order stay; the card reads "Resigned · the
     computer plays". Any seat a person still plays but the game master's own.
295. ~~In the panel under the end time.~~ **Changed:** "Resign Bea" goes beside
     "Move Bea on", so only the player on turn can be resigned from the page.
296. **The game master is asked first,** "Resign Bea? The computer plays Bea
     from now on.", and Bea is told "The game master resigned you. The computer
     plays Bea from now on." Everyone else sees it on her card.
297. **Bea can still watch and post,** as after her own Resign.
298. **Delete sits at the right end of each post's name line,** for the game
     master only, on every post including their own, and asks first: "Delete
     Bea's message? Its words are erased for everyone." **Changed:** a trash bin
     icon instead of the word Delete.
299. **A deleted post keeps its place, name and time,** and its words become
     "Deleted by the game master." in grey. They are erased from the server too,
     from the record that posted them, so a delete cannot be undone.
300. **The game master can delete from the start until the game is removed,**
     after it ends too, as posting works. A deleted post is not counted on the
     Messages button and makes no sound.
301. **The rulebook changes with it:** ending early gives the win to the most
     gold, and the game master's list gains Resign a player and Delete a
     message.

Raised by the two changes, and answered at 12:58: *"303 and 303, sounds
good. Then we can fold "find Bea" into under the new "Bea" button as well"*
(302 and 303):

302. **On phones there is no room for Resign Bea beside Move Bea on:** it wraps
     to a second row of buttons on the 340 folded phone and on sideways phones,
     and on a 390 phone while planning or with a longer name. **Answered:** on
     phones one "Bea ▾" button in place of Move Bea on, opening Move Bea on and
     Resign Bea above it, and Find Bea too. Desktop was to get them side by
     side; see 306.
303. **The trash bin** is drawn in the sound button's line style, 16 pixels, in
     the game's link blue. **Answered:** yes.

Raised by folding Find Bea into the button, and answered at 13:10: *"304 -
307, yes, looks good. Just to confirm: if I'm not a game master, I don't need
the Bea button, right? I still get "Find Bea' where it fits"*. Only the game
master has the Bea ▾ button; everyone else keeps Find Bea as before.

304. **Find Bea comes back on phones for the game master.** Phones have had no
     Find button since hot seat, to keep one row; inside the list it takes no
     room. Other players' phones, and the game master's own turn or a
     computer's, stay as they are. **Answered:** yes.
305. **The list reads Move Bea on, Resign Bea, Find Bea,** top to bottom, and
     Find Bea looks like the other two there. **Answered:** yes.
306. **Desktop gets the Bea ▾ button too,** so the game master's buttons are the
     same on every screen and stay on one row there with a long name while
     planning. **Answered:** yes.
307. **The list closes** on a choice, a second press of Bea ▾ or a press
     elsewhere, as the Menu list does (Q58 84), and when the turn passes.
     **Answered:** yes.

He also asked for the Turn log and Messages on a 1366×768 laptop to be looked
at: with three players they get a strip about 17 pixels tall under the buttons.

<a id="q86"></a>
### Q86. ~~What does the game do when the map cannot be drawn?~~ — **answered 2026-09-29: builds it again by itself, and says so with a Reload button if it still can't; 332 to 334 as recommended**

On 29 September at 13:26 Andrei started a new game on the preview site on his
phone and saw no map; it drew in the next game, and at 13:41 he judged it
*"something transient then, like unstable connection, and the code is not
resilient to that"*. Nothing rebuilt a map whose drawing surface the device
took away, and a failed start was dropped silently. At 13:48 he answered
330 and 331: *"330 and 331, yes, that looks good, let's add these checks"*.

330. **When the drawing surface is lost, the game rebuilds the map by itself
     as soon as it can.** **Answered:** yes.
331. **If the map still can't be drawn, the map area says "The map could not
     be drawn. Reload the page to try again." with a Reload button.**
     **Answered:** yes.

Raised by building them, and answered at 17:51: *"332-334 the
recommendations sound good"*:

332. **After a rebuild the map keeps the zoom and position the viewer had
     set,** rather than going back to the starting view. **Answered:** yes.
333. **While the message shows, the map buttons stay in their corner** and do
     nothing until the page is reloaded. **Answered:** yes.
334. **The timing:** a failed start is tried again after 1 second; a lost
     surface is rebuilt after 2 seconds, or at once if it comes back; the
     message shows on the third problem within 30 seconds. **Answered:** yes.

The drawing library froze the whole page when the surface was lost as it
started (a loop in Pixi 8.21.0's shader check never ended), so
`patches/pixi.js@8.21.0.patch` makes it fail with an error there instead. The
code is `apps/web/src/page/MapView.tsx` and `mapTrouble.ts` beside it.

<a id="q87"></a>
### Q87. Where do the Turn log and Messages go on a laptop? — **answered 2026-09-29: over the map's left edge beside the cards, closed until asked for, under the cards over the map (335)**

On 29 September at 12:41 Andrei asked for the squeezed Turn log and Messages
to be looked at (Q85 299). On a 1366×768 laptop with three to five players the
cards and turn buttons filled the left column and left them about 1 pixel, so
Messages seemed to do nothing; on 1920×1080 five players left 49. Hot seat's
log was squeezed the same way. Three ways to give them room went to him with
pictures, and at 18:04 he answered: *"Option A looks good on desktop/laptop,
let's make it so"*. At 18:12 he added *"But then turn log should not be on from
the start, because it gets in the way"*, which is 309.

308. **On desktop the Turn log and Messages open over the map's left edge,**
     beside the cards, the full height of the game and 360 pixels wide, with
     the × to close them, as they do on phones. The cards and buttons stay as
     they are. **Answered:** A. (B kept them in the column's bottom 280
     pixels with the cards scrolling above; C drew the cards as on phones.)
309. **The panel starts closed** when a game opens on desktop, as on phones.
     Turn log and Messages each open it and close it again, and so does the ×.
     Hot seat gets its Turn log button on desktop too. **Answered:** yes. This
     replaces [Q56](#q56) 58's desktop log that was always open, where Messages
     went back to the log.

Raised by building it:

335. **Which goes on top on a laptop, the open panel or a card over the map?**
     At 1366 wide the panel covers the left of the end-of-game card (about 130
     pixels) and of a turn's result (about 50); on 1920 they don't meet.
     Recommended: the card, whole, over the panel's edge until it fades or is
     closed. Otherwise the panel covers them, as it covers everything on
     phones. **Answered** at 18:34: *"Got it, of course the answer for 335 is
     Card on top"*. The cards, the rising claim notice and the notices at the
     map's foot show over the panel; the game master's end-time list and the
     Bea ▾ list stay over both.

<a id="q90"></a>
### Q90. ~~How does a game master delete a finished game?~~ — **answered 2026-09-29: as recommended, with the posts' trash bin**

On 29 September at 13:20 Andrei asked: *"In Your Games, can we have a Delete
button next to Open for finished games where you are the GM"*. Until then a
finished game left everyone's list only by itself, 7 days after it ended
([Q55](#q55) 37). Six details went to him with pictures, and at 13:39 he
answered: *"recommendations for 310 to 315 look good. Let's proceed with the
trash bin icon"*.

310. **Delete removes the game for everyone, straight away:** the removal a
     finished game otherwise has 7 days after it ends. It leaves every
     player's Your games, its map, turns and messages are deleted from the
     server, and its address says *"This game has ended and been removed."*
311. **It asks first,** with the OK / Cancel box End the game and Cancel use:
     *"Delete this game? It leaves everyone’s game list and cannot be opened
     again."*
312. **Every finished game where you are the game master,** however it ended:
     the gold ran out, the time ran out, or the game master ended it. Games
     waiting for players or still being played have none.
313. **Left of Open,** so every Open stays lined up at the right edge.
314. **The trash bin of posts ([Q85](#q85) 298 and 303),** in a button like
     Open (same height and border). The word Delete would have left a 340 px
     phone about 107 px for the name, too little for *"Andrei’s game"*.
315. **A name that doesn't fit ends in "…" on every row.** Until now a long
     name on a 340 px phone pushed the whole list past the right edge of the
     screen, because the list grew to fit the name.

Two details were built before he had ruled on them, and were then put to him.
At 13:49 he answered *"yes to both"*:

316. **The bin's hover label on desktop reads *"Delete"*,** as on posts.
     **Answered:** yes.
317. **The bin is greyed out while the list is reconnecting to the server,**
     as New game is. **Answered:** yes.

The rulebook says nothing about how long finished games are kept, so it is
unchanged. Delete goes through the game list's socket (`lobby.deleteGame`):
the lobby checks its row, and the game removes itself in
`GameSession.deleteFinished`, the same removal as the 7-day one.

<a id="q100"></a>
### Q100. ~~What do players read for a site and for a space?~~ — **answered 2026-09-29: site and space, as the rulebook says, never POI or node**

On 29 September at 18:53 Andrei wrote: *"I noticed that POI are still
mentioned in the turn log – but in user-facing communications we renamed them
to sites."* The turn log's lines that said POI now say site, and nothing else
changed with them. No other text players read said POI or "point of
interest"; the code keeps its names (`poiAt`, `poiRuntime` and so on).

370. **Four lines players read said node where the rulebook says space:** the
     turn log's *"Heading for a plains node."*, the move hints *"Tap the node
     to route through."* and *"…routes through a node on the way."*, and the
     guard fight card's *"…the gold stays on the node."* Recommended: space,
     only the word swapped. **Answered** at 19:14: *"please change nodes to
     spaces"*.

<a id="q105"></a>
### Q105. ~~How do the terrains get more roads between them?~~ — **answered 2026-09-29: put pruned roads back where two areas meet (A), 2 places to start, then 1; the rest as recommended**

On 29 September at 19:01 Andrei wrote: *"The generated maps often have too
little connectivity: only one link between plains and forest for example, or no
way to get from plains to forest at all except through mountains. We need to
loosen it up"*. Measured over 100 maps: 12% had no road between plains and
forest, 22% had two or fewer, and only 77% of forest spaces could be reached
from plains without stepping on a mountain (under 90% on a third of maps). The
cause is the order of §2.1: step 3 prunes the triangulation to a graph that is
nearly a tree, and step 4 grows terrain along its roads, so terrains meet
exactly where roads are fewest. Keeping more roads everywhere does not help: at
330 roads 61 maps in 100 fall under 30 dead ends and regenerate, and at 360 no
map can be made.

390. **How to loosen it.** A: after step 6, put back pruned triangulation roads
     where two terrain areas meet in too few places, terrain unchanged
     (recommended). B: grow terrain by nearness on the ground instead of along
     roads, which redraws every map and helps less (forest reachable 90.5%).
     **Answered** at 19:42: A.
391. **How many separate places two touching areas meet in** (roads sharing a
     space count as one): 2, 3 (recommended) or 4. **Answered:** *"let's start
     with 2, and make it a configurable constant that is easy to change to
     3"*: `BORDER_ROAD_PLACES` in `packages/config/src/defaults.ts`.
392. **Dead ends may take a put-back road while at least 30 remain**
     (`LEAF_COUNT.min`), preferring roads that join none. **Answered:** as
     recommended.
393. **A put-back road is at most 1.3 times the longest road the map kept**
     (`BORDER_ROAD_MAX_LENGTH`). **Answered:** as recommended.
394. **Two pieces of one terrain that touch on the ground but share no road
     are joined by one road** (`JOINED_PIECE_ROADS`). **Answered:** as
     recommended.
395. **Only areas of 5+ spaces get roads put back** (`BORDER_AREA_MIN_SIZE`),
     about 10 roads per map; areas of 3+ would put back about 13, every size
     about 18. Recommended: 5+. **Answered** at 20:26: as recommended.
396. **Which pruned road goes back:** with no crossing yet the shortest, then
     the one farthest from the border's existing crossings, so they spread
     along the border (recommended); or always the shortest, which often lands
     beside an existing crossing. Andrei asked whether the
     farthest roads would all land near the map's edge. They do not: over 100
     maps 14% of put-back roads lie within one road length of the edge (11%
     with the shortest road first), against 27% of spaces. "Farthest" is
     measured along the one border, from its own crossings, most borders end
     inside the map where a third terrain starts, and near the edge the pruned
     roads are long thin ones the 1.3 times limit rules out. **Answered** at
     20:31: *"OK, the 1.3x limit saves the day. I'm OK with the first option
     (farthest from the border's existing roads)"*.
397. **A valley's sides may take a put-back road** (recommended; about 1 in 5
     put-back roads touches a valley); or valleys keep only their own roads,
     which leaves 10% of maps with 2 or fewer plains–forest roads instead of
     8%. **Answered** at 20:26: as recommended.

With 2 places, over the same 100 maps: every map has at least 2 roads between
plains and forest, 98.6% of forest is reachable from plains without mountains,
maps carry 302 to 322 roads (310 on average) and dead ends fall from 39.6 to
35.8 per map. Terrain, spaces and their positions do not change, but the new
roads change which spaces are dead ends and how remote each site is, so a seed
gives a different map from before: on `adventure` 49 of 60 sites stay on the
same space and the rewards are dealt again over them. Routes get shorter, so
games end sooner: with the simple test player a 2-player game's median falls
from 59 rounds to 46 and a 4-player game's from 50 to 36. Online games already
started keep the map they were stored with; a hot seat game kept in the
browser is replayed from its seed, so one kept from before cannot resume. The
rulebook does not describe roads, so it is unchanged; the step is GDD §2.1
step 6b.

398. **One place instead of two.** On 29 September at 20:56, with 2 places
     merged (PR #38), Andrei wrote: *"i checked a few maps and it looks like 2
     connections per border may be already too much. We often had zero before;
     let's chane it to 1 first and see if that is enough"*. `BORDER_ROAD_PLACES`
     is now 1: only two areas that meet by no road at all get one put back, the
     shortest that qualifies, so 396's "farthest" no longer comes into play
     between different terrains. Over the same 100 maps: no map lacks a road
     between plains and forest (7% have exactly 1, 13% 2 or fewer), forest
     reachable from plains without mountains stays at 98.6%, maps carry 301 to
     314 roads (305 on average), dead ends average 37.8, 94% of sites stay on
     the space they had before step 6b, unguarded gold is 0.48% of gold sites,
     and the simple test player's median game is 49 rounds with 2 players and
     40 with 4 (59 and 50 before step 6b). A seed gives a different map again,
     so a hot seat game kept under 2 places cannot resume either.

### Q110. ~~Does stamina count in the estimated evaluation?~~ — **answered 2026-09-30: yes, 5 stamina as one skill point**

[SOURCE §9, chat] Andrei, 2026-09-30, while comparing the three evaluations
(details 410-429): "gold * game_progress + (total skill points + stamina / 5)
* (1 - game_progress), where game_progress is gold_claimed /
total_gold_in_the_game", normalised: "gold * game_progress /
total_gold_in_the_game + (total skill points + stamina / 5) * (1 -
game_progress) / total_skills_in_the_game".

Until then the estimate had no stamina in it: Q11 had left it out as "a
resource". `estimatedGoldAndSkillsEvaluator()` now adds stamina divided by
`STAMINA_PER_SKILL_POINT` (5, its own AI setting rather than
`REST_STAMINA_GAIN`) to the skill points. `total_skills` stays the skill units
on the map (Q24), 75 on every map today, so the term could in principle pass 1;
it stops at 1, which keeps every value between 0 and 1 as Q14 needs. The
game's computer players still use the simulated evaluation (Q18), so nothing in
play changes.

### Q111. ~~What is the estimate's progress?~~ — **answered 2026-09-30: skill and gold units claimed, over all of them**

[SOURCE §9, chat] Andrei, 2026-09-30, after the first comparison: "let's rerun
this with p defined as (skills and gold claimed) / (total skills and gold) so we
have continuous progress from the start".

Q18's `progress` was gold claimed over total gold, so it sat at 0 through an
opening of skill claims. It is now the skill and gold units anyone has claimed
over the 120 on a v1 map (75 skill, 45 gold). Stamina rewards are not counted;
a v1 map has none. Only the estimated evaluation reads it (and the hybrid
through it); the game's computer players still use the simulated one.

### Q112. ~~How far does the computer count a site?~~ — **answered 2026-09-30: by its own speeds, from the steps per terrain on the cheapest route (422-424 A, 426)**

[SOURCE §9, chat] Andrei, 2026-09-30: "go back to caching three numbers (# of
steps on each terrain) instead of one number (distance) and recalculating
distances based on current skills using the cached numbers. It bothers me that
the cached distances always consider mountains inaccessible when in reality by
the [end] of the game you can have lots of mountain speed". Then 422 A (count
the cheapest route's steps only; a second, fewest-steps route postponed), 423 A
(his 2026-09-28 formula: the least over n turns of 5n + the stamina still
needed after n turns of free steps), 424 A (for the computer's own choices and
every player in its imagined games).

Tested against the computer as it was: 19 of 20 wins at 3 s a move (+6.6 gold
a game), and 13 of 20 at 10 s on ten other maps (+3.5); 426: put it in the
game. Routes walked are unchanged, still the cheapest by weighted terrain cost;
only which sites count as the 10 closest changes. The remoteness walk and a
person's route preview keep weighted terrain cost. Equal distances keep the
weighted-terrain-cost order.

### Q113. ~~How does the computer score a game it imagines?~~ — **answered 2026-09-30: by its gold lead over the richest other player, (lead / (|lead| + 1) + 1) / 2 (417, 418, 429)**

[SOURCE §9, chat] Andrei, 2026-09-30: after picking the lead as the score
(417), "let us test "score the lead" first on its own", and for its form
(418), "let us try (lead/(abs(lead) + 1) +1)/2 , if that makes sense". After
the comparisons (427, 428), on 429: "let's merge #40 as is, and put lead score
in a separate pr".

Until then the computer scored each game it plays in its head by its own share
of the map's gold (§9's simulated evaluation, Q18). `computerEvaluator()` now
returns `simulatedLeadEvaluator('soft')`: the lead is its gold minus the
richest other player's when the imagined game ends, so level is 0.5, one gold
ahead 0.75 and two ahead 0.83, and the value stays between 0 and 1 as Q14
needs. The imagined games themselves are unchanged.

Tested, 20 games a run with the seats swapped: against the computer scoring its
own gold, 13 of 20 at 3 s a move (+4.1 gold a game) and 12 of 20 at 10 s on
ten other maps (+2.2); with both ranking sites by their own speeds (Q112), 12
of 20 at 3 s (+3.3) and 11 of 20 at 10 s (+2.2). All four together 48 of 80,
+2.9 ± 1.1 gold a game; the 10 s runs alone are within luck.

### Q115. ~~Which guards do forest sites get?~~ — **answered 2026-09-30: each forest gold site fighting or magic by a coin flip, magic drawn as the mountains' magic guardians (450-452 A)**

*Since [Q185](#q185) (2026-10-01) the chance is 100%: every forest gold site is magic-guarded.*

[SOURCE §4.4, chat] Andrei, 2026-09-30: "Magic doesn't play an important
enough role. Can you make it so the forest POI are assigned randomly either
magic or combat guards?" Then 450 A (only forest's 4 gold sites, the ones
guarded before, get the random guard; the other 16 stay unguarded), 451 A (a
coin flip for each site on its own, 50% magic, as the named constant
`FOREST_MAGIC_GUARD_CHANCE`; not exactly 2 of 4 on every map) and 452 A (a
magic-guarded forest site borrows the mountains' magic guardians, as its
fighting guards borrow the mountains' fighting ones).

Until then all four forest gold sites were fighting-guarded. A map now carries
0 to 4 magic-guarded forest gold sites: at 0.5, 2 on 3 maps in 8 and none on 1
in 16 (100 maps measured: 9 with none, 20 with 1, 34 with 2, 32 with 3, 5 with
4). Unchanged: guard strength (§5.2 never reads the type; forest guards run 1
to 6, mostly 2 or 3), forest's 5 gold on 4 sites, magic rewards (10 on 6 plains
sites), plains and mountain guards, the rulebook (it never says which terrain
has which guard). The coin flips are the map's last draws, so on every seed
only some forest gold guards and their pictures differ from before; over 100
seeds every road, reward, strength and other picture was identical. A hot seat
game kept on one device that fought at a forest gold site that turned magic may
not resume as it was; an online game keeps the map it was made with.

<a id="q120"></a>
### Q120. ~~What does clicking a player's card do?~~ — **answered 2026-09-30: finds the player, as the Find button did, which goes; the rest as recommended (470-475)**

[SOURCE chat, review] On 30 September at 20:52 Andrei wrote: *"Please make it
so that clicking on a player's card finds this player on the map"*. The
details were put to him with pictures of Bea's card clicked from the whole
map, on a laptop and a phone. At 22:05 he answered: *"the recommended choices
look good, except I don't think we need the "find" button any more. It was not
present on some screens anyway"*.

470. **How the map gets to the player.** A: it jumps there and zooms in to
     playing distance, as Find did (recommended). B: it glides there over half
     a second at the zoom it has, as at the start of a turn. C: it glides and
     zooms in. **Answered:** A. A figure part-way along a walk is found where
     it has got to.
471. **Marking the found figure.** A: no mark. B: for 2 seconds it stands on
     the yellow-edged ring of a figure being planned; the player on turn's
     figure already blinks and gets nothing more (recommended). **Answered:**
     B. The 2 seconds are `timing.foundMs` in `GameScreen.tsx`.
472. **How a card shows it can be clicked, on a laptop.** A: the pointer turns
     into a hand over it and the card looks the same (recommended). B: nothing
     changes. **Answered:** A.
473. **The Track button.** A: it unpresses, as with Find and moving the map
     yourself, since a pressed Track would pull the map back to a walking
     figure (recommended). B: it stays as it was. **Answered:** A.
474. **After the game ends.** A: cards still find players on the final map
     (recommended). B: only while the game is on. **Answered:** A.
475. **The Find button goes,** from every screen: under the turn buttons on a
     laptop (phones never showed it) and from the game master's "Bea ▾" list,
     which keeps Move Bea on and Resign Bea. A phone's panel stays as tall as
     it was on a computer's turn.

<a id="q125"></a>
### Q125. ~~What does End turn do when there is no guard to fight?~~ — **answered 2026-09-30: it rests, and so does Move on; 490-495 as recommended**

Andrei, 2026-09-30 at 20:53: *"Clicking 'Next Turn' with no guard to fight
makes no sense. Let us make it rest automatically in this case."* Until then
End turn with no route was a move of zero steps: on an unclaimed guarded site
another fight (§8), anywhere else nothing at all, not even stamina. Answered
at 21:46: *"The recommended options look good, please proceed"*. 494 and
495 answered 2026-10-01 at 00:59: *"the recommendations are good"*.

490. **Which End turns rest:** with no route, and also with a route whose
     first step this turn cannot pay; the route is kept for next turn
     (recommended); or only with no route. On an unclaimed guarded site End
     turn still stays and fights again. **Answered:** as recommended.
491. **The game master's Move on** does what End turn would, so a saved route
     whose first step cannot be paid rests too (recommended); or Move on
     unchanged. **Answered:** as recommended.
492. **The buttons:** Rest and End turn both stay, and the line above them
     says *"End turn with no route rests: +5 stamina."* (recommended); or Rest
     hidden while End turn would rest anyway. **Answered:** as recommended.
493. **The turn log:** an automatic rest reads like any rest, *"Rested: +5
     stamina"* (recommended); or it also says End turn made it one.
     **Answered:** as recommended.
494. The line above the buttons with a route whose first step
     cannot be paid, away from a guard. As built: *"Not even the first of
     these 4 steps is affordable this turn. End turn rests: +5 stamina, and
     keeps the route for next turn."* (recommended); or the wording before,
     *"…Rest gains 5 stamina; End turn walks nothing and keeps the route for
     next turn."*, which no longer says what End turn does. **Answered:** as
     recommended (as built).
495. The line when a player picks their own space as the
     destination, away from a guard. As built: *"Staying here this turn. End
     turn with no route rests: +5 stamina."*; *"Staying here this turn. End
     turn rests: +5 stamina."* (recommended); or the wording before,
     *"…End turn with no route stays put."*, which no longer says what End
     turn does. **Answered:** as recommended.

`endTurnActionFor` (`packages/core/src/rules/turn.ts`) decides it, for the
page's End turn, the server's `turn.end` and Move on (`moveOnActionFor`), and
never `applyAction`, so a zero-step move already played replays as it was: a
game kept on one device, and an online game's records. Computer players do
not change: they already rest on a turn they cannot take a step (Q43), and
stand still only on the guarded site they are after.

### Q135. ~~Do speeds and skills come back?~~ — **answered 2026-09-30 and 10-01: one empty site a turn, from the farther half, while fewer than 2 sites offer a skill (530-541)**

[SOURCE §4.5, chat] Andrei, 2026-09-30: "Already with 4 players, some
necessary skills like combat run out too quickly. They need to respawn. This is
especially true for combat and magic that are necessary for fighting guards.
Skills need to respawn where there are too few of it left, randomly at POIs
that were offering this skill before and are far from all players." Then 530 A
(the three speeds, combat and magic, each counted on its own; never gold or
stamina), 531 C with his "keep at least 2 of each skill on the map (instead of
3)" and, on 2026-10-01, "We need two *sites* with the skill at any time, not two
units of skill on the map" (`RESPAWN_SHORT_BELOW_SITES` 2, whatever the player
count or the sites' units), 532 A (one site
a turn, with the whole stack it started with), 533 A (drawn at random from the
farther half of the empty sites, `RESPAWN_FAR_SHARE` 0.5 rounded up, never one
a figure stands on), 534 A (far by the stamina cost of the cheapest route from
the nearest figure), 535 A (a site can come back again and again), 536 A (a
turn log line, "3 combat came back at a forest site."), 537 A (the computer's
imagined games include it), 538 A (the rulebook paragraph). Then "There has to be a respawn sound, and if
Track is pressed, we should bring the respawn site into view": 539 B (a far
bell, a placeholder in Art/Sounds/respawn.wav), 540 A (after the turn's walk,
die and claim notice) and 541 A (the map stays 1.5 s, `timing.respawnStayMs`).

The draw comes from the game's dice: online the server's stream, recorded with
the game as `picks`; on one device the die's seed. Games started before the
rule keep the old one: an online game holds the rules it was made with, and a
kept hot seat game says whether it had the rule. In six four-player computer
games at 3 s a move counting sites, all ended with a winner, 121 turns on
average against 148 on the same maps without the rule (125 counting units);
18 sites came back a game, mostly forest speed, combat and mountains speed
(plains speed 4 times in all, magic once), never two in one turn, the first on
turns 7 to 23. Claimed sites keep their picture (Q36).

Andrei, 2026-10-01: "let us cap the skills to 2 units when they respawn. The
idea is to provide a player who was late to the party with something to do,
not to create a cornucopia." A site that comes back offers at most
`RESPAWN_MAX_UNITS` (2), and one that held fewer gets those; the map's icons,
the turn log and the claim card show what it offers. Games started before the
cap bring whole stacks back. 543 A: the rulebook adds "but never more than 2"
to the sentence, and "at most 2 units" to the quick reference row.

Then, the same day, having played: "even capping regrown skills by 2 is too
much. It's not supposed to be easy when skills run out. Starving your
opponents of some skill should be one of the strategies. Let's change that cap
to one." `RESPAWN_MAX_UNITS` is 1, so every site that comes back offers 1 unit;
games started under the cap of 2 keep 2. 544 A: the rulebook says the site
"gets back 1 unit of it", and the quick reference row "with 1 unit".

Andrei, 2026-10-01, on the rulebook's sentences about how the site is picked
and that it can come back again: "These all are unnecessary details for the
players, the game engine takes care of them. THey need to be removed from the
rulebook -- but we also need to make sure they are preserved somewhere else."
The rulebook drops them; 545: GDD.md §4.5 keeps them.

*Since [Q190](#q190) (2026-10-02) speeds and skills are bought instead: games started since have none of this, and games started before keep it (757, 758).*

### Q140. ~~How are a player card's stats arranged, and how does gold stand out?~~ — **answered 2026-10-01: moving down the left, the rest down the right with gold last, gold's number deep red (550-553 A)**

[SOURCE §2, chat] Andrei, 2026-09-30: "On a player card, it would be nice to
arrange everything that has to do with moving (stamina + 3 speeds) in the left
column, and the rest in the right column, with gold going last. Also, can we
show the number for gold in red so one glance would be enough to see who has
how much of it". Then 550 A (the right column fills from the top: combat, magic,
gold, so its empty fourth place is beside mountains speed), 551 A (deep red
#b71b1c, the red of the circle round the combat icon on the map, and #ff7b72 on
a screen set to dark), 552 A (only the player cards; the end-of-game table and
gold written in sentences stay as they were) and 553 A (phones, upright and
sideways, keep their one row of seven icons, already in this order; only gold's
number turns red).

Only laptop and desktop cards, 900 wide and up, have two columns. Unchanged:
the stats' order, their words and icons, the free steps line and the cards'
height.

<a id="q145"></a>
### Q145. ~~Does a player have to tap their figure before choosing where to go?~~ — **answered 2026-10-01: no, not on their own turn; 570-576 as recommended**

Andrei, 2026-10-01 at 02:52: *"i don't see why i have to tap my figure at the
beginning of every move. everything works if it's already tapped"*. Until then,
on your turn a tap on a space with your figure not picked up only showed *"Tap
your figure, or Plan a move, before choosing where to go."* At 03:02: *"it's
good to have the figure blink until there's a route planned. as soon as i click
on a node and the route is being planned blinking can stop. if the route is
saved from previous planning we can blink for a short while and stop"*. The
details were put to him with pictures at laptop, 390 and 340 px, and he
answered 570 to 573 on their cards at 03:49 and 574 to 576 at 04:32.

570. **How a turn starts.** A: as before, the figure blinks and Plan a move
     shows; the first tap on a space picks the figure up and chooses that
     space (recommended). B: the figure starts picked up, still on its gold
     ring, with Cancel and Waypoint showing. Either way every tap on your turn
     does what it does once your figure is picked up, so a tap on another
     player's figure chooses their space instead of showing hot seat's notice.
     Track unpresses when a space is chosen, as when a figure is picked up,
     and End turn presses it again. **Answered:** A, in his 03:02 message and
     on its card.
571. **The line above the buttons at turn start.** A: *"Bea: tap where to go.
     End turn with no route rests: +5 stamina."*, on a guarded site *"…End
     turn with no route stays here and fights the guard again. Rest gains 5
     stamina."* (recommended). B: *"Bea: tap where to go (or Plan a move).
     …"*. C: the line before, *"Bea: tap your figure (or Plan a move), then
     where to go. …"*. **Answered:** A.
572. **Online, on someone else's turn.** A: as before, planning your next move
     starts with your figure or Plan a move, and a tap on a space alone shows
     the notice, since a stray tap would save a route that the game master's
     Move on would walk (recommended). B: a tap on a space plans at once.
     **Answered:** A.
573. **The rulebook,** under Planning a route. A: *"Choose where you want to
     go."* (recommended). B: *"Tap or click where you want to go."* It read
     *"Select your figure, then where you want to go."* **Answered:** A.
574. **How long the figure blinks on a route saved from the turn before,**
     counted from the start of the turn. A: 2 seconds, two blinks
     (recommended). B: 3 seconds. C: 1 second. **Answered:** A, as
     `timing.savedRouteBlinkMs` in `GameScreen.tsx`. The 2 seconds start when
     the map can glide to the player on turn (Q46), so they are not spent
     under an unguarded claim's notice or a site coming back (Q135).
575. **How the figure looks once that blink stops.** A: still on its gold
     ring, as after a tap on a space; only the look changes, so Track stays
     pressed and the figure counts as picked up only once tapped
     (recommended). B: like the other players' figures. **Answered:** A.
576. **Tapping your figure, or Plan a move, before any space is chosen.** A:
     the blink stops, as before (Q34) (recommended). B: it blinks on until a
     space is chosen. **Answered:** A, nothing changes.

`choose` in `apps/web/src/interaction/moveMode.ts` picks the figure up on the
planner's own turn, `GameScreen`'s `onTap` sends a tap on a space there, and
the line is `hint` in `TurnControls.tsx`, and `GameScreen`'s `cue` stops a
saved route's blink.

### Q155. ~~Does Rest keep the route?~~ — **answered 2026-10-01: yes, the route shown, and none after Cancel; the rulebook says so (610, 611 A)**

Andrei, 2026-10-01 at 05:12: *"it looks like clicking rest cancels the current
route, and it should not"*. On one device nothing saved a route until the turn
ended, so Rest dropped a route drawn or changed that turn and kept only one
saved from an earlier turn. Online the route is saved as it is drawn (Q56, 53)
and a rest already kept it. Rest on one device now carries the route shown, as
End turn's rest does (490), and it comes back at the player's next turn as any
saved route does. 610 and 611 answered at 05:24.

610. **Cancel, then Rest or End turn, on one device:** today a route saved from
     an earlier turn and then cancelled comes back at the next turn; online it
     is gone. After Cancel, Rest and End turn keep no route, as online
     (recommended); or the cancelled route comes back, as today.
     **Answered:** as recommended.
611. **The rulebook:** the Rest line ends with *"Your route is kept for next
     turn."* (recommended); or the rulebook stays as it is. **Answered:** as
     recommended.

### Q160. ~~How do maps grow for 4 and 5 players?~~ — **answered 2026-10-01: 40% larger, everything on them 1.4 ×, sites rounded to the nearest; the rest as recommended (630-635)**

Andrei, 2026-10-01 at 05:48: *"for four and five player games we need larger
maps. let's make them 40% larger. all numbers are currently divisible by 5 so
that should work out without any rounding. the number of [spaces] for each
terrain, number of [sites] and number of skill units and the gold offered
should all scale by 40%. I hope none of the current numbers like total 45 units
of gold are currently hard coded anywhere in the code. when a game is started
the map should redraw when one changes the number of players to 4 [or] 5 or
back to three or less."* Nothing in the game hard-codes a total: the win check,
the computer and everything else count gold and skills on the map. The rulebook's
quick reference said "Gold on the map: 45". Every unit total divides (gold 45
→ 63, speeds and skills 75 → 105, sites per terrain 35 / 28 / 21); six
per-reward site counts did not. Answered 06:57 to 07:01.

630. **Sites per reward:** plains 9.8, 8.4 and 2.8, forest 11.2, 11.2 and 5.6
     rounded to the nearest (10, 8, 3; 11, 11, 6), which keeps each terrain's
     total (recommended); or other numbers. **Answered:** nearest.
631. **Roads, dead ends and valleys:** 300 roads cannot join 336 spaces, so
     roads 420 and dead ends 42-63, valleys as today (recommended); or valleys
     3-6 of 7-17 spaces too. **Answered:** valleys as today.
632. **Zoom after a card tap and a phone's Plan a move:** as close as on today's
     map (recommended); or 2.2 × the whole-map view, about 15% farther out on
     the larger map. **Answered:** as close as today.
633. **Everything else** (stamina, rest, guards, skills coming back, the 10
     closest sites, border roads, terrain shares, thinking time) stays as today
     (recommended); or some change. **Answered:** keep all.
634. **The rulebook:** the Gold row reads "45, or 63 with 4 or 5 players" and
     The map gains *"With 4 or 5 players the map is 40% larger, with 40% more
     spaces, sites, rewards and gold."* (recommended); or only the Gold row.
     **Answered:** row and sentence.
635. **Setting up:** when the number of players crosses 3 and 4 the New game
     panel stays and the map behind it changes once drawn (recommended); or the
     drawing message shows first, as after a new seed. **Answered:** panel
     stays.

The same seed draws a different map at each size. Games already under way keep
their map: an online game holds the map it started with, and a game kept on one
device says which size it is on, one kept before maps grew being on today's.
The larger map takes about 0.5 s to draw against 0.3 s.

### Q165. ~~Can the seats be shuffled before the game starts?~~ — **answered 2026-10-01: yes, a Shuffle seats switch that draws every seat at Start; 650-656 as recommended**

Andrei, 2026-10-01 at 09:38: *"I'd like to be able to shuffle player seats
before the game starts. The game master does not necessarily need to be on
seat 1. It could be a toggle on the game start screen"*, and at 09:39: *"the
spec says the seats are assigned in the order requests are accepted but one
should be able to reshuffle them before the start."* Online the game master
always sat in seat 1 and the others in the order they were accepted; on one
device the seats went in the order set. In play nothing looks for the game
master by seat, so only the setup changes. Answered 10:58 to 11:00.

650. **How the seats are shuffled:** a Shuffle seats switch; with it on, the
     seats are drawn at random when Start is pressed, so nobody sees the order
     until the game begins (recommended); or a button that reorders the seat
     cards at once and can be pressed again. **Answered:** the switch.
651. **Its look:** under Players, like Play online's switch, "Shuffle seats"
     with *"Seats are drawn at random when the game starts."* under it
     (recommended); or a row "Seat order" with As listed and Shuffled.
     **Answered:** like Play online.
652. **Which games:** on one device and online alike (recommended); or online
     only. **Answered:** both.
653. **Seat cards while it is on:** "Seat 1 · starts with 30 stamina" and so
     on as today (recommended); or "Player 1 · seat drawn at the start".
     **Answered:** as today.
654. **Players who joined online:** the game master's line gains *"Seats are
     shuffled when the game starts."* (recommended); or nothing.
     **Answered:** the sentence.
655. **The next game:** the switch stays as set for the next New game and goes
     along when Play online is turned on or off; a freshly opened page starts
     with it off (recommended); or off at every New game. Either way New game
     lists the seats as set, not as drawn. **Answered:** stays as set.
656. **The rulebook:** Setting up reads *"Seat 1 moves first. With Shuffle
     seats on, the seats are drawn at random when the game starts, and each
     player starts with the stamina of the seat they draw. Otherwise seats go
     in the order set up, and online the game master is in seat 1."*, and The
     game master says the creator *"sits in seat 1 unless the seats are
     shuffled"* (recommended); or Setting up only. **Answered:** both places.

Each player starts with the stamina of the seat they draw (Q75). Online the
draw uses the server's die stream, so nobody can foresee or redraw it; on one
device it uses the browser's secure generator, and a game kept in the browser
keeps the order drawn.

### Q170. ~~How does the map become a floating island?~~ — **answered 2026-10-01: Andrei's brighter rock under the two front edges with a rim of stone tops, his sky behind the map as drawn, darkened at night, still as the map is dragged and growing a little as it is zoomed in; Whole map frames the map as before in games and the whole island on the New game screen (670-682)**

Andrei, 2026-10-01 at 16:05: *"I don't like the map floating in the void. Can
we add this extension to the bottom to create a Laputa-style gloating island?
And we can experiment with a blue background then"*, with a picture of a rock
wall in a V for the map's two front edges. At 16:21 he sent a brighter
version, at 16:22 *"For the background, I was thinking of a grey-blue cloudy
sky, not very bright"*, and at 16:34 a picture of that sky: *"We may need to
darken it for more contrast (or maybe not)"*. Until then the map stood on a
plain grey-blue (`--map-ground`). Answered 16:46 to 16:5x.

670. **Where the ground meets the rock:** a thin rim of the rock's stone tops
     shows below the ground's edge (recommended); or the ground runs straight
     to the cliff, the tops hidden. **Answered:** the rim. Set any lower, sky
     showed through gaps between the stones.
671. **His sky:** as drawn; 15% darker (recommended); or 30% darker.
     **Answered:** as drawn.
672. **What Whole map and the game's first view frame:** the whole island, rock
     included (recommended); or the map as before, the rock running off the
     bottom of a laptop's screen. **Answered:** the map as before. Nothing
     about the camera in games changed. At 16:53 he added: *"For the "New
     game" screen, it would be nice to show the whole island, as in
     recommended in 672"*, so there (hot seat and online) Whole map and the
     first view frame the rock down to its lowest point.
673. **A dark-mode screen:** his sky darkened for night (recommended); the
     same sky as on a light screen; or the dark grey as before.
     **Answered:** darkened for night, to 40% of its brightness; made lighter
     in 682.
674. **The New game screen:** island and sky there too (recommended); or as
     before. **Answered:** there too.
675. **Which rock:** the first, darker one with glowing cyan cracks; or the
     brighter one (recommended). **Answered:** the brighter one.
676. **When the map is dragged or zoomed:** the sky stays still behind it
     (recommended); or it moves a little with the map. **Answered** at 16:52:
     *"I am afraid that background that does not move at all will create an
     unnatural feeling. How expensive, peformance-wise, is to move the
     background a little? If it's not too much, I'd prefer that"*. It is
     cheap: the sky is one layer the browser slides, and the map is redrawn
     on every frame of a drag anyway. The amounts below were offered on a
     page that moves his sky behind the island (Island sky drift).
677. **How far the sky moves:** as far as the map moves at the whole-map view
     times still, 1/20, 1/10 (recommended) or 1/5, and less as the map is
     zoomed in, as a faraway sky would. To have room to move, the sky is
     drawn larger, so its clouds look about 6%, 12% or 25% bigger; dragged
     far off, it stops at its edge. **Answered:** 1/10 at 17:07, then at
     17:08 *"The sky should grow but it should not move up and down like
     today"* and at 17:09 *"Actually scratch that. Let's make it still, but
     growing with the zoom"*: still (`SKY_DRIFT` 0), so the sky is drawn at
     the box's size, as before.
678. **Zooming:** the sky grows a little as the map is zoomed in, by up to a
     tenth at 1/10 (recommended); or it keeps its size. **Answered** in the
     same words: it grows, by about a tenth at the closest zoom, as on the
     page, and never below its size at the whole-map view
     (`SKY_ZOOM_GROWTH`).
679. **Where the ground's front edge meets the rock** (17:11: *"Is there a way
     to blur the edge of the map so it blends better with the stone rim?"*;
     17:14: *"Or, another idea, put a stone edge on the map border"*): as
     before, the ground ending in a straight line above the rim; a soft edge,
     the rock's stone tops fading into the ground; or a stone border, the
     same stone tops drawn over the ground's edge (recommended). The back
     edges stay ground against sky. **Answered** at 18:41: the soft edge. The
     rock is drawn over the ground and its stone tops fade out over 24 of the
     picture's pixels above the edge (`fade` in `Art/manifest.json`).
680. **While the sky's picture loads** (asked at the coordinator's prompt, as
     the old grey-blue showed until then, on the map's box and the "Drawing
     the map" screen): the old grey-blue; the sky's own average blue,
     darkened at night like the sky, so the switch is barely seen
     (recommended); or the map waiting for the sky, so no switch is seen but
     the map comes later on a slow connection. **Answered** at 19:10: the
     sky's own blue, #809ab4 (`color` in `Art/manifest.json`).
681. **The map's side corners** (19:13, with a picture of the left corner:
     *"This detail around corners is rather ugly. I thin you need to extend
     the map less in that direction"*): the ground's corner stuck out past
     the rock's rounded end as a thin sheet over the sky. Offered: the rock
     about 4% larger, its left and right points moved 27 and 26 of its pixels
     in along its top edges so its ends reach past the corners; or the ground
     cut back at the side corners, the rock as before (recommended).
     **Answered** at 19:41: *"can we just have the rick and the map align in
     that direction? I mean the rock should extend in SW and SE directions but
     be aligned with the map edge in NW and NE"*. The rock keeps the moved
     points, so it reaches right up to the corners (about 4% larger), and is
     cut off flush there: nothing of it left of the left corner, right of the
     right one, or above the ground's back edges.
682. **The night sky's brightness** (19:48: *"I don't see the sky background
     in the preview, is it supposed to be there?"*; 19:50: *"I think Ihave the
     dark theme, and the clouds are so dark one cant really see them"*): at
     40% of its brightness (673) the clouds hardly showed. Offered: 40% as
     before, 55%, 70% (recommended) or 85%. **Answered** at 19:59: 70% (`shade`
     `dark` 0.3 in `Art/manifest.json`), also for the sky's blue while it
     loads.

The rock is his picture as drawn, stretched only so its top edges lie along
the map's front edges, which it already slopes along; 4 and 5 player maps get
the same rock at their size. Rock and sky are both inside the map's box, so a
phone's map loses no height. Both are in `Art/Island/`, named in
`Art/manifest.json`'s `island` section.

### Q175. ~~What is the game called?~~ — **answered 2026-10-01: Skyholm Adventures, and Skyholm where that doesn't fit; 690-693 as recommended**

Andrei, 2026-10-01 at 19:28: *"Since we are going with the floating island
theme, let's change the game's name to Skyholm Adventures. We need to change it
to that everywhere it fits, and just to Skyholm where it doesn't. The site
address can stay adventure.aburago.workers.dev for now"*. Players read
"Adventure" in the top bar's title on every screen, in the browser tab, and in
the rulebook's heading "Adventure Game — Rulebook"; readers of the repository
in the README's and the design document's titles. No art carries the name.
Answered 21:30, and 692 at 22:04.

690. **Which top bars show Skyholm:** Skyholm Adventures wherever it fits on
     the bar's rows, and Skyholm where it would push the bar onto another row,
     judged by the room each bar actually has (recommended). Measured, that is
     an online game's bar in play on a phone held upright, and its bar before
     the start on a 340 px phone; elsewhere the seed or "Logged in as" beside
     the name is cut shorter on phones. Or Skyholm in every bar on a phone held
     upright; or in every bar everywhere. **Answered:** where it fits.
691. **Browser tab titles:** the full name, "Skyholm Adventures", "Skyholm
     Adventures Hot Seat" and "Your turn · Skyholm Adventures" (recommended);
     or Skyholm. **Answered:** the full name.
692. **The documents' titles:** "Skyholm Adventures — Rulebook", the README's
     "Skyholm Adventures" and "Game Design Document — Skyholm Adventures"
     (recommended); or the design document keeps "Multiplayer Turn-Based
     Adventure Game". Sentences describing the kind of game stay either way.
     **Answered:** all three.
693. **Names nobody sees:** code packages (`@adventure/…`), the browser keys
     that keep saved games, logins and the sound setting, request headers, the
     Workers behind the site address, the repository, the `adventure` seed the
     tests use and past rulings here all keep their names (recommended); or
     packages, headers and keys renamed with saved games moved over.
     **Answered:** they keep their names.

### Q180. ~~What can be done about the trees crowding the map's edge?~~ — **answered 2026-10-01: a third of the trees past the outermost roads stay, and the rest are planted in the middle of the forest, as many as fit by today's rules (710, 711)**

Andrei, 2026-10-01 at 21:19, with a picture of the back edges against the
new sky: *"Trees are crowding too at the edge. Can we do something about
it?"*, and at 21:21: *"I would rather ask you to fit more in the middle"*.
Each forest gets a set number of trees (3.2 per forest space), and inside the forest
most spots are refused because a tree would stand on a road or a space or
hide one behind it. The strip between the outermost roads and the map's edge
has nothing to keep clear of, and along the back edges a tree hides nothing
behind it, so that strip took most of the trees: 188 of the 230 on seed
adventure. The floating island (Q170) placed no trees; its sky only made the
hedge stand out. Answered 21:59 and 22:09.

710. **How many of the trees past the outermost roads stay:** half; a third,
     in small groups with sky between them (recommended); a sixth; or none.
     **Answered:** a third. Each stays by that chance (`EDGE_TREES_KEPT` in
     `apps/web/src/render/dressing.ts`). All four edges alike; the two front
     edges rarely have any.
711. **The trees taken off the edge:** planted in the middle of the forest
     wherever a tree fits by today's rules (recommended); planted there and
     allowed to stand closer to roads, a tree's leaves possibly touching a
     road's side; or not planted, leaving the forest with fewer trees.
     **Answered:** planted by today's rules. On seed adventure 48 of the 120
     fit, so the middle goes from 42 trees to 90. Each tree taken off gets
     `MIDDLE_TRIES` (40) tries before it is dropped.

Andrei also asked, at 22:01, whether trees could hide a small piece of road;
letting a tree hide up to a road's width of road would fit 74 instead of 48
on seed adventure. Not built: he picked 711's first answer after asking.
Every other tree, bush and stone stays where it was.

### Q185. ~~Which guard does forest gold get now?~~ — **answered 2026-10-01: always magic, by the same chance turned to 100%; kept games keep their coin flips, and the rulebook says each terrain's guard (730, 731 A)**

[SOURCE §4.4, chat] Andrei, 2026-10-01: "After playing some more I think we
need to make all gold in the forests guarded by magic. Otherwise magic plays
too little role", then "it's a good idea to keep the logic that says forest
magic is decided by chance, just turn this chance all the way to 100%".

`FOREST_MAGIC_GUARD_CHANCE` (Q115) goes from 0.5 to 1, on the standard and the
larger map alike, so every guarded forest gold site is a magic guard drawn as
the mountains' magic guardians (452). Since the draws stay the map's last, on
every seed only forest gold guards change; strengths, rewards and every other
site are as before.

730. **A hot seat game kept before the change:** goes on with the coin-flip
     guards it began with, as games kept before the skill cap kept their rules
     (recommended); or its forest gold turns magic. **Answered:** keeps its
     guards. A kept game now records its chance; one without it is drawn at
     0.5. Online games keep the map they were made with either way.
731. **The rulebook:** after "Bigger gold stacks have stronger guards, up to
     10", *"Gold on plains is guarded by combat, in forests by magic, and in
     the mountains by either."* (recommended); or forests only; or no change.
     **Answered:** all three terrains.

### Q190. ~~Can speeds and skills be bought with gold?~~ — **answered 2026-10-02: yes, 1 gold a unit on your own turn, as many as you like, from a Buy panel with Cancel on every screen; it replaces speeds and skills coming back in new games; other players' purchases float up from the buyer's figure with a cash register (750-788)**

[SOURCE §2, §5, chat] Andrei, 2026-10-02 at 00:41: *"Players complain that if
they didn't get the right skill early on they are screwed for the rest of the
game. I have the following idea: allow players buy skills for gold, 1 to 1. We
won't need respawning skills then, this mechanism substitutes that. Please
suggest a convenient UI that wont clutter the view. Maybe have a little "+" sign
next to every skill? [...] As for computer players, we'll need new actions to
consider from every MCTS node, up to 5 of them. Similar to resting, it seems
prudent to introduce some pruning here, e.g. buying a skill is not available to
a computer player if that skill is within 1 turn reach from them (cached
distances to the skill site less or equal current speed), or 1 turn reach plus
some stamina."* Answered between 02:17 and 02:50.

750. **Where buying happens:** a + beside each skill on every card; one Buy
     button on the card of the player on turn, opening a panel with a + per
     skill; or the + on laptops and the panel on phones (recommended).
     **Answered:** the last, then at 02:42 *"a separate buy panel in all
     cases, and a cancel option on it. This way, if you misclick, you can
     always cancel"*: the Buy panel on every screen.
751. **Does buying use the turn:** no, any number during your turn
     (recommended); one a turn; or it takes the turn as resting does.
     **Answered:** any number.
752. **A speed bought counts this turn:** its free step is there at once
     (recommended). **Answered:** yes.
753. **What can be bought:** the five skills, the three speeds with combat and
     magic (recommended). **Answered:** never stamina.
754. **When:** only on your own turn, online too (recommended). **Answered:**
     own turn only.
755. **Undo and selling back:** neither (recommended). **Answered:** no
     selling back; undo became 765.
756. **The spent gold:** leaves the game, and a purchase runs the win check, as
     a claim does (recommended). **Answered:** yes.
757. **Speeds and skills coming back (Q135):** off for new games, the code kept
     (recommended). **Answered:** keep the code.
758. **Games already started:** keep the rules they began with, coming back
     included and no buying (recommended). **Answered:** whatever is
     convenient, so they keep their rules.
759. **When the computer considers a purchase:** not while a site offering the
     skill is within this turn's free steps; nor within them plus 5 stamina,
     capped by the stamina it holds (recommended, `BUY_SKIP_STAMINA`); or plus
     all its stamina. **Answered:** plus 5 stamina.
760. **The players the computer imagines:** never buy, as they never rest by
     choice (recommended). **Answered:** off.
761. **The computer's turn:** it thinks once, then buys and moves
     (recommended). **Answered:** yes.
762. **What others see:** a turn log line, no sound or notice (recommended).
     **Answered:** yes. *Changed at 07:02 by 773-786.*
763. **Which screens get the Buy button:** every screen that shows Menu,
     phones held sideways too (recommended). **Answered:** yes.
764. **"Playing now" on an upright phone:** "Turn N ·" and "Playing now" on two
     lines on every turn, clear of the Buy button, the card no taller
     (recommended). **Answered:** yes.
765. **Undoing a misclick:** answered by 750's change: Cancel on the panel.
766. **The panel stays open:** until Done, with every + greyed once the gold
     runs out (recommended); "Your gold" with its coin by Done, in the cards'
     gold red, replaces "you have 3 gold" in the heading (Andrei, 02:31).
     **Answered:** yes.
767. **Room for the laptop +:** moot after 750's change.
768. **Nothing is bought until Done:** each + adds to the panel, the tile's
     number going up with a blue +1 beside it and Your gold counting down;
     Cancel puts everything back and closes the panel; no −; Rest and End
     turn greyed while it is open (recommended). **Answered:** yes. And, at
     02:50, *"”1 +1” should still center on 1, not on plus"*: the number stays
     centred in its tile and the +1 hangs to its right.
769. **The log:** one line per Done, *"Bea bought 1 mountains speed and 1
     combat for 2 gold."* (recommended). **Answered:** yes.
770. **Where the panel opens on a laptop:** over the map, next to the card,
     level with its top (recommended). **Answered:** yes.
771. **Online, Done arriving after the turn has ended** (the game master moved
     the player on just as they pressed it): nothing is bought, and a notice at
     the bottom of the map says *"Your turn ended before the purchase arrived,
     so nothing was bought."* (recommended); or nothing is said. **Answered:**
     as recommended, 03:28.
772. **The log when a purchase ends the game** (the turn has no move): the
     headline *"Bought, and the game ended"* above the 769 line and who won
     (recommended); or the 769 line as the headline. **Answered:** as
     recommended, 03:28.

The rulebook draft was approved at 02:45 with the panel sentence in place of
the + signs.

At 06:58 Andrei asked *"How do I see it when other players buy something?"*,
and at 07:02, told it was 762's log line: *"We need to change that. Their
purchase panel should open, with the purchases they made, and stay open for
some time, e.g. 2 seconds. It also would be nice if a purchase got completed
with some sound, e.g. a cash register sound"*. At 07:25 he sent the cash
register he had in mind, and at 07:26 offered *"another option is to have a
small panel floating up similar to when you claim a reward."* At 07:45:
*"Basically the purchase notice works the same way as claiming a reward, but
happens before the walk, not after"*.

773. **Who sees it:** *"online, everyone but the buyer. Hotseat, only
     computer's purchases."* (07:30).
774. **What it looks like:** the buyer's Buy panel opening on their card, or
     a notice floating up from their figure like a claim's. **Answered:**
     *"Let's go with a gloating* [floating] *notice"* (07:45).
775. **How long it stays:** *"same timing as a regular claim"* (07:45): it
     fades in, stays 2 seconds and fades out.
776. **A computer's walk:** *"a computer's walk waits until the purchase
     notice closes (whatever form we decide on)"* (07:30).
777. **The sound:** his own cash register, not a placeholder; *"as
     recommended"* (07:45). It is `purchase` in Art/manifest.json.
778. **When it is heard:** by the buyer as they press Done; by everyone else
     as the notice appears (recommended). **Answered:** yes, 07:30.
779. **Several purchases in one turn:** one after another (recommended).
     **Answered:** yes, 07:30, *"especially if we go with a floating notice.
     Purchases of the same skill can be combined, e.g. Purchased Magic +2"*.
780. **Purchases caught up online** (missed while the connection was down):
     in the log, no notice and no sound (recommended). **Answered:** yes,
     07:30.
781. **The rulebook:** unchanged, as it says nothing about what players see
     (recommended). **Answered:** confirmed, 07:30.
782. **The panel over the map on a phone:** moot with 774's floating notice.
783. **Who supplies the sound:** answered by 777, his own file.
784. **A buyer off screen:** the notice rides on the figure, so it is missed
     when the figure is out of view, as a claim's is: taken from 07:45's
     *"works the same way as claiming"*, and said so to him.
785. **One notice per skill, or one per Done listing every skill:**
     **Answered:** one per skill, one after the other, *"otherwise the text
     becomes too long"* (07:50). Each comes with the sound (778).
786. **Capital or lowercase:** **Answered:** lowercase, *"like the claim
     notice (as recommended)"* (07:50). And at 07:55: *"Maybe "Bought", not
     "Purchased", for a shorter card"*: the notice reads *"Bought magic
     +2"*.
787. **The sound with several notices:** each notice plays its own cash
     register (as built), or only the first. **Answered:** as built, 13:39,
     *"787 and 788 look good"*.
788. **A purchase that ends the game:** the end card waits for its notices
     (as built). **Answered:** as built, 13:39.

### Q200. ~~Should players start with gold?~~ — **answered 2026-10-02: yes, 5 each, in games started from now on (790-792)**

[SOURCE §6, chat] Andrei, 2026-10-02 at 14:57: *"Now that players can buy
skills for gold, it makes sense to starts them with 5 gold to enable a variety
of strategies"*. Every seat gets the same 5, as he wrote; it is
`STARTING_GOLD`. Nothing that decides the winner moves: the win check compares
a lead with the gold left on the map, and the same 5 each changes no lead. The
computer follows the buying rules as they are, so it may spend some of its 5
early. Asked at 15:10 with a picture; at 15:22, *"790 to 792: looks good"*.

790. **Which games:** only games started from now on, while games already
     under way keep starting at 0, as with buying (recommended).
     **Answered:** yes.
791. **The rulebook:** *"Every player starts with 5 gold. The other stats
     (the three speeds, combat and magic) start at 0."*, plus a Quick
     reference row "Starting gold: 5" (recommended). **Answered:** yes.
792. **The New game screen's seat line:** A, as today, *"Seat 2 · starts with
     35 stamina"*, since it shows what differs between seats (recommended);
     or B, *"... and 5 gold"*. **Answered:** A.

### Q210. Which route do players take? — **stage 1 answered 2026-10-02: the best for their speeds, drawn for people and walked by the computer's real moves; stage 2 answered: its search's own choices too; stage 3 answered: the games it imagines walk it, counted along a route traced once (810-826)**

[SOURCE §4, §9, chat] Andrei, 2026-10-02 at 18:12: *"it bothers me that the
game shows to me the path that is not optimal based on my current skills. How
hard is it to make the players, including computer players, take the optimal
path by default"*. This is the second route [Q112](#q112)'s 422 A postponed. At
18:52 he set the order: *"1. Keep simulated games as they are, but switch the
actual paths players walk to the most efficient 2. Build MCTS nodes with the
most efficient paths, but leave the simulated games as they are 3. Switch
simulated games to the strategy above"*, the strategy being: *"Most of the time
it does not matter what path the simulated player takes. We an quickly
calculate how soon it arrives to the destination based on our cached distance
in steps for each terrain. If it arrives there, the path did not matter. It is
only in case where some other player overtakes it and claims the target POI
first we need to calculate the path and figure out where it is on it."*
Answered at 18:56.

810. **What counts as best:** his Q112 formula on the route itself, free steps
     costing nothing and a turn counting as 5 stamina (recommended); the least
     stamina on this turn's walk; or the fewest turns with the stamina held
     now. **Answered:** as recommended.
811. **Two routes equally good:** the one cheaper by terrain alone, today's
     route whenever it is one of them (recommended); or the one with fewer
     steps. **Answered:** as recommended.
812. **With a waypoint:** each leg the best for the player's speeds
     (recommended); or waypoint routes as before. **Answered:** as
     recommended.
813. **Buying a speed with a route drawn:** the route is picked again for the
     new speeds, a waypoint kept (recommended); or it stays and is only
     recoloured. **Answered:** as recommended.
814. **Where the computer uses it:** settled by his three stages above.
815. **Games already under way:** they get it too, no rule changing
     (recommended); or new games only. **Answered:** as recommended.
816. **The rulebook:** *"drop the details on how the route is calculated. THe
     players only need to know that we picked for them what we think is the
     best"*: it says the game draws the route it thinks is best for you. How
     it is picked is in GDD.md §7.
817. **Comparing stage 1's computer with today's at 3 s:** *"B is good enough,
     you are not changing how computers decide the next move"*: no comparison
     for stage 1; one PR per stage.
818. **Track when a purchase picks a route brought back again:** A, Track
     unpresses, as when you change a route yourself; or B, Track stays
     pressed, as a route brought back leaves it (575; recommended). Either way
     the new route is saved online. **Answered** at 19:27: *"818: B, the
     rulebook wording is OK"*.
819. **A bug found while checking 818, on the live site since buying
     ([Q190](#q190)):** on one device, a route drawn and put down with Track
     jumped back to the route saved last turn when anything was bought. A,
     fix it in this PR, so the route drawn stays (recommended); B, its own PR;
     C, leave it. **Answered** at 20:04: *"sure, let's fix it"*: A. The same
     cause brought last turn's route back after Cancel and a purchase, against
     610; that is fixed too.
820. **Stage 2, where the search counts the best route:** A, all four places
     its own choices look at routes: which 10 sites are choices, whether
     resting is weighed, which purchases are skipped, and its own walk to a
     choice (recommended); B, only the ranking and its own walk. Andrei,
     21:59: *"the first three items don't need the path, and can use the
     distance provided by the formula, right? It's only the walk that needs
     the actual path"*. Confirmed: ranking and the buy check already read
     only the cached steps per terrain, and the rest check can, since the
     walk arrives this turn exactly when the player holds Σ cost × max(steps
     − free steps, 0) stamina. All three count the best route's steps, the
     route the computer walks. 22:00: *"yes, please go ahead"*.
821. **Comparing stage 2 at 3 s before it merges:** A, 20 games, 2 computers,
     3 s a move, seats swapped, against the computer before it, reporting
     wins, gold margins and games imagined per move (recommended); B, none.
     **Answered:** A.

Stage 3, asked 2026-10-02 at 22:58 after *"go ahead merge it and let's go to
stage 3"* (22:51), answered at 23:34 and 23:36:

822. **Which sites imagined players head for:** the 10 closest by the best
     route for their speeds, like the search's own choices (recommended, and
     the costly part: on its own it cut games imagined per move from 1,800 to
     700 at turn 1); or the 10 closest along the cheapest route as before, only
     the walk changing. **Answered:** B.
823. **How an imagined walk is counted:** the best route traced once when a
     player picks its site and its turns counted along it in order, as a real
     walk goes, the figure not moved step by step but placed when it arrives,
     when a turn ends on a site on the way, or when someone takes its site
     first (recommended); or his
     shortcut as written, arrival from the steps per terrain and the route
     traced only when overtaken. On a turn that ends short the order of the
     terrain decides where the walk stops: a step that cannot be paid stops it
     even with free steps after it. On 8 maps the totals gave a different
     arrival turn in 10% to 27% of trips, mostly a turn early, and left out
     the 1.4% to 2.6% of claims made where a turn ends on a site on the way;
     and tracing a route costs about as much as counting it. 23:34: *"The
     "shortcut" is simply lazy evaluation of the path; we do that only when
     needed. Are you saying that picking the path is simply not costly enough
     to bother?"* Yes, and the totals alone do not give the arrival. 23:36:
     **Answered:** A, *"let's proceed with 823 A and lo[o]k at the numbers"*.
824. **Games where skills come back** (started before buying), whose returning
     skill goes far from every figure: they keep the imagined games of before
     (recommended), or get stage 3 too. **Answered:** *"whatever is the most
     convenient, there arent too many old games"*. Stage 3 places every figure
     after every turn and brings skills back as a played turn does, so these
     games get it too with nothing added.
825. **Comparing stage 3 at 3 s before it merges:** 20 games, 2 computers,
     seats swapped, against the computer before it, reporting wins, gold
     margins and games imagined per move (recommended); or none. **Answered:**
     A, *"of course"*.
826. **Where an imagined figure is placed**, asked 2026-10-03 at 00:13
     because it was built before asking (823 had said only at the moments it
     names): A, after every turn, where that turn's count ends (as built,
     recommended); or B, only when it arrives, stops on a site or is
     overtaken, the walk keeping its place and stamina in between. Both find
     the same route and count every turn the same way, so every imagined game
     comes out the same; B imagines about 1-2% more games per move, but needs
     stamina kept in two places, a second way to end a turn, the old walk for
     games where skills come back, and leaves positions stale for any later
     rule that reads them. 01:34: *"there are no older games"*. 01:43:
     **Answered:** A, *"Please proceed as recommended"*.

Stage 1, as built: `bestRoute` and `bestRouteVia` (`packages/core`), from
`RouteTable.routesFrom`, every route no other route beats on all three
terrains' step counts. The move planner draws it; a purchase that changes the
planner's speeds picks the route shown again, as choosing its destination
again would. A route brought back and not picked up stays down when that
happens, so Track stays as it was, and online the page saves the new route
(818 B). A route put down with Track, or nothing after Cancel, stays as it is
when something is bought, until the turn ends or, online, the saved route
changes (819 A). The computer's real move (`firstTurnOf`) walks it.

Stage 2, as built: `bestRouteSteps` gives the best route's steps per terrain
and score from the cached route lists, tracing nothing. The computer's search
ranks its choices by it (`closestByBestRoute`), checks what it reaches this
turn and which purchases to skip by those steps (`stepsReachability`,
`buyBranches`), and walks the best route along its own tree edges
(`MctsOptions.edgeRoute`). The games it imagines, and the other seats' turns
inside a tree edge, still rank and walk the cheapest route (stage 3).

Tested (821 A), 20 games with the seats swapped at 3 s a move on ten maps
(seeds stage2-0 to stage2-9), against the same computer with its search
counting the cheapest route as before: 10 wins each, none shared, +2.1 ± 2.4
gold a game for stage 2, within luck. Games imagined per move 5,647 against
5,322, so counting the best route did not slow the search.

Stage 3, as built: the players in the games the computer imagines, the other
seats inside its own tree edges included, still pick among the 10 closest
along the cheapest route (`closestBySpeeds`, 822 B) and walk the best route
for their speeds, traced once when they pick (`bestRoute`). Each turn is
counted along it by §7's rules (`countWalk`) and played with
`applyCountedTurn`, which places the figure where the count ends and then does
what a played turn does there: fight or take an unclaimed site, check for a
win after gold, bring a short skill back, hand over. Counted along the
cheapest route, an imagined game is exactly the one `applyAction` would play;
600 of them on real maps came out identical, every claim, roll and rest. The
route is not picked again on later turns, as the computer's real move does;
the search's own walk along a tree edge is still played turn by turn (stage
2). The figure is placed where every turn's count ends, not only at the
moments 823 named (826 A): that costs little, and games where skills come back
need every figure's place (824).

Tested (825 A), 20 games with the seats swapped at 3 s a move on ten maps
(seeds stage3-0 to stage3-9), against the same computer with its imagined
players walking the cheapest route turn by turn as before: stage 3 won 8, the
computer before it 11, one shared; +0.7 ± 2.1 gold a game for stage 3, within
luck. Games imagined per move 10,207 against 9,882.

### Q220. ~~Should the rock's green match the map's?~~ — **answered 2026-10-03: the rock's moss takes the forest's green, darker, and the map stays as it is; the stone tops over the map get a graded blur (830-833)**

Andrei, 2026-10-02 at 22:49: *"The green on the background rocks and roots
that extend down from the "skyholm" does not quite match what is prominently
used in the map. Can we make them agree a little more?"* The moss and ivy on
his rock ([Q170](#q170)) are a yellow olive (hue about 54), while the forest's
ground and trees are a cooler grass green (hue about 96). The plains ground is
sand, and its few tufts and bushes already share the rock's olive, so the
forest's green is the map's only large green.

830. **Which greens move:** the rock's halfway to the forest's; the rock's all
     the way (recommended); or both halfway, every forest turning a little
     more yellow. **Answered** at 23:19: *"I like "rock all the way" but I
     think the rock's green is too bright, it needs to be darker"*.
831. **How much darker:** 15%, close to the forest ground; 25%, between the
     ground and the trees (recommended); or 35%, as deep as the trees.
     **Answered** at 00:00 on 10-03: 25% darker.

The rock's greens turn 42 degrees of hue towards the forest's, keep three
quarters of their saturation and are darkened by a quarter (`greens` in
`Art/manifest.json`, applied as the picture loads, so the PNG stays as he
supplied it). The stone and roots, greyish pixels and the palest sunlit spots
stay as drawn; those spots, turned and darkened, had shown as grey-green
specks on the stone. Nothing on the map changes.

At 02:21 he added: *"The colors blend really well now. Looking at the
transition though I wonder if the stones underneath could be blurred where
they show under the map as well, to create smoother trasition"*.

832. **How strong a blur:** light, medium (recommended) or strong, the whole
     strip where the stone tops fade over the map blurred evenly. **Answered**
     at 02:47: *"No, this doesn't work at all. Somehow I see the edge of the
     map as a line again, and that's pretty bad"*. Blurred stone met sharp
     stone right on the ground's edge and drew it as a line.
833. **A graded blur instead:** no blur, PR #65 going in with the greens
     alone; graded, medium (recommended); or graded, strong. The stone stays
     sharp on the ground's edge, as before, and is blurred more the higher it
     rises over the map, fully at the top of the fade. **Answered** at 03:12:
     graded, medium (`blur` 6 of the picture's pixels in `Art/manifest.json`).

### Q227. ~~Where on the plains do players start?~~ — **answered 2026-10-03: on the deepest plains space whose sites within 5 steps average less than 0.1 remoteness, in games started from now on (873-878)**

Andrei, 2026-10-03 at 06:45, asked to start away from the forest and the
mountains; at 13:46 he named the worry, big forest speed or magic stacks near
the start. PR #66 tried a start in the forest's farther half, then a start and
the remoteness walks deep in the plains, then half of remoteness the distance
from the start ("simply unplayable", 14:43: the speeds piled up in a far
corner). Each idea after that was measured rather than built. At 20:21 he
asked for *"remoteness of a space as the average of all sites within 5 steps
from it"*; on 200 maps per size, the deepest space below 0.1 by it lay 8.2
road steps from the forest and mountains (10.2 on the larger map), and a
forest speed stack of 3 or more lay within 5 steps of it on 10% of maps,
against 22% (18%) for today's random start. At 20:46: *"change the starting
place to go to the deepest plains space with remoteness less than 0.1. We
don't need any changes in how remoteness is calculated etc. It would probably
make sense to abandon #66 and make that change in a new PR"*. #66 was closed.

873. **Several spaces equally deep** (on about half the maps): the least
     remote of them (recommended), or one at random from the map's seed.
     **Answered** at 20:53: the least remote.
874. **No space below 0.1** (none of 400 maps measured): the least remote
     plains space (recommended), or a random one as before. **Answered**: the
     least remote.
875. **The rulebook:** drop "random" (recommended), or describe the rule.
     **Answered**: drop "random"; the rule is §6 of GDD.md.
876. **A space's remoteness:** the average remoteness of the sites within 5
     road steps (recommended). **Answered**: yes.
877. **Less than 0.1 or 0.1 or less:** **answered** *"does not matter"*; less
     than, as he wrote.
878. **Sites of every terrain count, the start is never a site, and depth is
     road steps to the nearest forest or mountain space** (recommended).
     **Answered**: yes.

And *"please make 0.1 a config setting"*: `start.MAX_REMOTENESS` (0.1), with
`start.NEARBY_STEPS` (5) beside it. Games started before keep the random start
they began on.

### Q230. ~~Should the swords stick out of their disc?~~ — **answered 2026-10-03: yes, as the 27 September option, just over the contour (880-882)**

Andrei, 2026-10-03 at 21:01: *"I remember when we were choosing the rewards
icons there was an option for the crossed swords icon with the swords slightly
sticking out of the frame. I rejected it then but I think we need to switch to
it; the current icon at low res looks too much like a simple red circle with a
cross"*. That option was the second choice under 112 in [Q61](#q61). Before
anything was built, today's icon and two sizes were pictured side by side at
the whole-map view, a middle zoom and the play zoom.

880. **How far the swords stick out:** A, the 27 September option, as big as
     the foot, tips and handles just over the contour (recommended); or B,
     about 45% bigger than inside the disc, tips further out. **Answered** at
     22:13: *"880 I actually prefer B"*; then, with B built, at 23:55: *"i am
     comparing this with other icons, and you're right, it sticks out too
     much. let us change the andwer of 880 to A"*.
881. **Stacks:** each disc is drawn over the tips of the swords on the disc
     before it, where they overlap (recommended). **Answered**: as
     recommended.
882. **The players' cards, the end-of-game table and the Buy panel** show the
     swords without a disc, so they stay as they are (recommended).
     **Answered**: as recommended.

The smallest circle round the swords now spans 1.06 of their disc's width
(`pictures` in `icons.backing`, `Art/manifest.json`), where every circled icon
had 0.82, so the swords are 1.29 times as big as before, as big as the foot,
and their tips reach 3% of the disc's width past its edge. The tips stay inside the disc's
square, so the icon takes the same room on the map and nothing moves. The
disc, its contour, the foot and the mountain are unchanged.

### Q235. ~~When are the route lists worked out?~~ — **answered 2026-10-04: in the background while the game is set up, on the page that thinks for the computers, and on between its moves (890-895)**

[SOURCE §9, chat] Andrei, 2026-10-03 at 21:08, in the thread on Q210: *"We are
caching the list of possible paths from one point to another, right? The
question is, while building the next path. are we using this cache?"* Each
space's list of routes (`RouteTable.routesFrom`) is worked out once a game, the
first time a route starts there, but not from a neighbour's list. Measured on
main: about 4 ms a space and 0.6 s a game on the standard map, about 12 ms a
space and 3.8 s a game on the larger one, nearly all in the computer's first
moves, so on the larger map its first move spent nearly 90% of 3 s on them. At
21:25: *"The best routes from the next space don't all pass through the first
one, true, but some of them do, and if I understand the algorithm right, that
part can be reused. Am I right?"* Yes: a best route that steps onto the
neighbour goes on along one of the neighbour's best routes, and a space whose
neighbours all have lists needs no search. About 40% of a space's best routes
go through any one neighbour (75% through the busiest). At 21:28: *"yes let's
add some background processing first. THere's plenty of time when the game is
being set up, but the map and the starting place are already established"*.
Asked at 21:30 and 21:31; answered 2026-10-04 at 04:40, *"the recommendations
look good please proceed"*:

890. **Which page, and when:** only the page that thinks for the computers (the
     hot seat page, or online the game master's), from the moment setup has
     the map and at least one seat is a computer, nearest the starting place
     first (recommended); or every page. **Answered:** as recommended.
891. **If Start comes before it is done, or a game is opened part way
     through:** keep working between moves, nearest the figures first, the
     computer working out what it needs while it thinks, as today
     (recommended); or only during setup. **Answered:** as recommended.
892. **Checking it:** the computer-against-computer games also work out every
     list before the first move, and the games imagined on the computer's
     first two moves are reported before and after, for 2 and 5 players
     (recommended); or that and 20 games at 3 s. **Answered:** as recommended.
893. **Anything shown while it runs:** nothing (recommended); or a line on the
     setup screen. **Answered:** as recommended.
894. **Phones:** the same as everywhere (recommended); or phones skip it.
     **Answered:** as recommended.
895. **Seats nobody holds** in an online game being set up, which the
     computer plays if the game starts that way: they count as computer seats
     for starting the lists (recommended), so nearly every online game's
     game master works them out while setting up; or only seats set to
     Computer. Asked 2026-10-04 at 04:58, after 890 was built. At 06:29 he
     asked whether that means every online game; yes, on the game master's
     page only, and if people fill every seat it stops, a few seconds of work
     unused. At 06:31 he asked whether it is noticeable; each list takes
     about 1 to 2 ms here and at most 28 ms, and runs only while the browser
     is idle. **Answered** at 06:33: *"That sounds reasonable, Please proceed
     with 895 as recommended"*.

As built: `workOutRouteLists` (`apps/web/src/modes/computer.ts`) works out one
list at a time while the browser is idle, from the setup screen's map and from
the game's own computer once it starts, and stops while the computer thinks.
An online game's map comes back from the server as a copy of the one the game
master's page drew, so `shareRouteTable` (`packages/core`) lets the copy read
the lists already worked out. The balancing harness calls `workOutAllRoutes`
before a computer's first move. Reusing a neighbour's routes is not built.

Tested (892 A) on 8 maps per size at 3 s a move, the computers' games imagined
per move before and after. Working out every list took 0.1 to 0.5 s on the
standard map and 0.2 to 1.5 s on the larger one. With 2 players the first move
went from 2,658 games on average (2,223 at worst) to 2,910 (2,686), +9%; with
5 players from 1,019 (514 at worst) to 1,418 (1,277), +39%. Later moves were
the same within noise. Results in `/mnt/project-files/best-route/route-lists/`.

### Q240. ~~How do stamina sites come to the plains?~~ — **answered 2026-10-04: like every other plains reward, 5 sites and 10 units (7 and 14 on the larger map), each unit 5 stamina, pictures 0.45 of a road, in games started from now on (900-907)**

Andrei, 2026-10-03 at 21:32, with a sheet of 12 pictures (a well, a fountain,
an apple tree, a campfire, a barrel, a statue, a bench, a tent, a picnic
table, a waterfall pool, a hot spring, a herb garden): *"I'd like to add
stamina rewarding sites to plains. [...] I am thinking of adding 5 sites,
rewarding 10 stamina units total (and each stamina unit adds 5 stamina).
[...] Stamina sites follow the same rules any other reward type does."* The
details were asked at 22:18 with pictures and numbers from 600 maps per size,
and answered at 00:03, 00:04 and 02:50 on 10-04.

900. **Where the 5 sites go:** like every other plains reward, the plains
     getting 30 sites instead of 25 and 5 drawn for stamina (recommended), or
     only in the deep plains. **Answered**: A, like every other reward. A
     stamina site lay within 5 steps of the start on 60% of maps (57% on the
     larger map).
901. **"Same rules":** unguarded; 1 unit a site and the other 5 leaning toward
     the more remote sites, usually 3-2-2-2-1 or 3-3-2-1-1; one of the 12
     pictures for each site, drawn from the seed (recommended). **Answered**: A.
902. **4-5 player maps:** 7 sites with 14 units, the usual 1.4 × (recommended),
     or 5 with 10. **Answered**: A.
903. **Spare dead ends** (each already a 1-unit stamina site, on 10 of 600
     maps, any terrain): stamina sites in every way, 5 stamina a unit and the
     new pictures (recommended), or left at 1 stamina with a borrowed house.
     **Answered**: A.
904. **Picture size:** asked at 0.5 of a road's length, like the houses; he
     answered *"slightly smaller, so a bench or a campfire doesn't look as big
     as a house"*, then asked between 0.5, 0.45, 0.4 (recommended) and 0.35.
     **Answered** at 02:50: 0.45, a tenth smaller than the houses.
905. **Hearts on the map:** one white heart a unit (recommended). **Answered**:
     A.
906. **Words players read:** the stamina a site gives, "took 10 stamina", "the
     10 stamina site (plains)" (recommended), or the units. **Answered**: A.
907. **Rulebook:** the stamina row reads "5 stamina for each heart, paid for
     steps beyond your free ones", and the quick reference gains "Stamina
     site | 5 stamina for each heart" (recommended). **Answered**: A.

Stated without a choice, unchallenged: games already started keep the map
they began with (their stamina units worth 1); 5 sites, 10 units and 5
stamina a unit are named settings (the stamina row of `REWARD_TABLE`,
`pois.STAMINA_PER_UNIT`); with 5 more plains sites a seed draws a different
map than before; computer players take stamina sites by the same rules, and
how they think does not change.

---

### Q250. ~~Which rewards go on which terrain?~~ — **answered 2026-10-04: as Andrei laid out, every reward keeping its amount and its sites; the moved magic gold guarded by the usual rule; every reward keeping its pictures; the rulebook's short line; the softer forest plan rerun on a few games (920-924); then forest stamina 6 sites with 10 units and plains magic gold 5 sites with 8 gold, his own numbers, and on 4-5 player maps 9 stamina sites with 14 units and 7 magic gold sites with 11 gold (925, 926)**

Andrei, 2026-10-04 at 08:08: *"we seem to have found a simple super strategy:
buy forest speed +4 and go to the forest. We need to change the allocation of
resources between terrains. [...] Plains get: plains speed rewards, forest
speed rewards, mountain speed rewards, the gold guarded by magic that used to
be in the forest before, the two "fortresses", large gold piles guarded by
combat. Forests get: magic rewards, combat rewards, stamina rewards. Mountains
stay as they are now."* The super strategy was the Buying skills thread's
softer forest plan (a computer seat buys forest speed +4 on its first turn and
heads for the forest): from every seat on 8 maps whose forest was one piece it
won 15 and shared 1 of 24 games, against 8 wins for the same seats playing
normally. The details were asked at 08:20 with pictures and numbers from 300
maps per size, and answered between 11:47 and 11:57.

920. **Amounts:** every reward keeps its units and its number of sites and only
     moves terrain, so the plains have 31 sites instead of 30 and the forest 19
     instead of 20 (44 and 26 instead of 42 and 28 on the larger map)
     (recommended), or some amounts change. **Answered**: A.
921. **Guards on the magic gold:** the rule all gold follows, bigger piles and
     less remote sites guarded more strongly (recommended), or other
     strengths. Plains sites are less remote than forest ones, so these guards
     come out about 1 stronger: a 1 gold pile's mostly 3 instead of 2, a 2 gold
     pile's 5 instead of 4. **Answered**: A.
922. **Pictures:** each reward keeps its own on its new ground: the forts of
     mountains speed and the guardians of the magic gold on the plains, the
     magic houses and the stamina pictures in the forest (recommended), or new
     sheets from him later. **Answered**: A.
923. **Rulebook:** "Gold on plains is guarded by combat, in forests by magic,
     and in the mountains by either" becomes "There is no gold in forests. On
     the plains and in the mountains, gold is guarded by combat or magic."
     (recommended), or a longer line saying the plains' big piles are guarded
     by combat and their small ones by magic. **Answered**: A.
924. **Checking it:** the Buying skills thread reruns the softer forest plan on
     the new maps (recommended), or no runs. **Answered** in his words: *"i
     dont think the softer forest plan makes any sense in the new config, but
     yes, we can rerun it on a few games"*: 6 games, 2 maps from every seat.

At 12:14, after the 11:48 reminder of the sites and units on the plains and in
the forest: *"you know, we can fill forests up to their usual 20 sites, by
changing stamina to 6/10. And on plains, gold with magic guards can grow to
5/8"*. So the forest is back to 20 sites, the plains have 32, and a 2-3 player
map has 48 gold instead of 45 (the rulebook's quick reference says so). He
named the 2-3 player numbers only, so the 4-5 player ones were asked:

925. **Stamina in the forest on 4-5 player maps:** 9 sites with 14 units, which
     keeps the forest at its usual 28 sites (recommended), or 8 sites with 14
     units, the plain 1.4 times, leaving it at 27. **Answered**: A.
926. **Magic gold on the plains on 4-5 player maps:** 7 sites with 11 gold, 1.4
     times as usual, so the plains have 45 sites and the map 67 gold instead of
     63 (recommended), or other numbers. **Answered**: A.

Measured over 300 maps per size as built (in road steps from the start to the
nearest site): magic 5 → 13, stamina 5 → 13, mountains speed 12 → 4,
magic-guarded gold 14 → 5; combat stays 12, plains and forest speed 3-4. The
magic gold's guards: a 1 gold pile mostly 3 (2.2 → 3.0 on average), a 2 gold
pile 5.6 (4.1 before), and about one pile in twelve now holds 3 gold, guarded 8
on average. The start rule (Q227) finds a plains space under 0.1 on 299 of 300
2-3 player maps (297 before) and on every 4-5 player one.

Stated without a choice, unchallenged: games already started keep the map
they began with, online because the map carries its rules, on one device
because the kept game records whether its rewards had moved; with the sites
moved and added a seed draws a different map than before. Engine details:
since no forest row has gold any more, `FOREST_MAGIC_GUARD_CHANCE` only
reaches maps from before, through `REWARD_TABLE_BEFORE_MOVE`.

---

## C. Decisions I made that are *implementation*, not design

Listed so you can veto any that read as design to you.

| Decision | Why it isn't a design call |
|---|---|
| `MAX_GENERATION_ATTEMPTS = 50` | §2.1 says "regenerate" with no bound; an unbounded loop hangs. Lives in `EngineeringConfig`, never merged into `GameConfig`. |
| Separate server-side die stream from the public map seed | §1's no-hidden-information is about map, POIs and rewards, all of which clients get in full. A shared seed would let a client precompute rolls. |
| Seats allocated in GM acceptance order | §6 explicitly delegates this: "whatever is most convenient to implement — expected default: order the game master accepts join requests". *Since [Q51](#q51) 22 an accepted person takes the first free Human seat the game master kept.* |
| `PlayerStats` typed as `Record<RewardKind, number>` | §6's seven stats are exactly §4.1's seven kinds. Typing them as one thing makes claiming a reward a single addition and stops the lists drifting. |
| Remoteness computed inside step 7, between POI placement and reward assignment | Forced by data flow: §4.3 step 3 consumes remoteness, and remoteness depends only on POI positions. |
| sfc32 PRNG, string seeds | §1.3 requires reproducibility, not a specific algorithm. |
| `Poi.artVariant` as an opaque stable index | §3 says a POI has an image and leaves which one to the art. Since phase 3 it picks sprite `artVariant mod count` from the sheet `Art/manifest.json` names for the POI, so no sheet's sprite count is baked into the generator. |
| `POISSON_RADIUS_FACTOR` recalibrated 0.85 → 0.815 | An `EngineeringConfig` knob, documented as existing purely "for making step 1 hit its node budget". 0.85 was a guess made before there was a sampler; measured, it yields ~220 nodes against §11's `MAP_NODE_COUNT` of 240. 0.815 centres the yield on 240. No §11 value changed. |
| `POISSON_RADIUS_FACTOR` 0.808 on the larger map (Q160) | The same knob, calibrated the same way: 0.815 yields about 333 spaces against the larger map's 336, 0.808 averages 336 over 400 seeds. |
| Farthest-point seed placement in §2.1 step 4, on nodes of degree ≥ 3 | §2.1 fixes the seed *count* (1 or 2 per terrain) and says nothing about placement. On a near-tree graph a seed down a branch is walled in after a few nodes and its terrain never reaches its share; measured, this choice cuts the share error from ~9 points per terrain to ~3. |
| Surplus leaves drawn by shuffle | §3 forces every leaf to be a POI and §4.2 fixes how many POIs a terrain's table rows get; nothing says *which* leaves fall inside the quota when a terrain has more leaves than it. Drawn from the map's own stream. |
| Growing terrain by *trading* when a region is walled in (Q28) | §2.1 asks for the shares and says nothing about how to reach them. A region enclosed by a terrain already at its share cannot take a node without pushing that terrain under; the two-step trade keeps both at their targets and still reduces the total deviation, so the pass terminates. |
| A `BoardPost`'s id and timestamp are stamped by the caller, not by `applyAction` | The engine is pure and has no clock — `Clock` is a session-layer port for exactly this reason — and a replayed game must rebuild the identical board. |
| `game_won` replaces `turn_ended`, rather than following it | §7's hand-over is to the next seat; a finished game has none. The turn does not advance and the event list says why. |
| `createGameState` lives in `@adventure/core`, not in `SetupFlow` | §6's starting stats are a rule. Three consumers need a game before they can play one — setup, hotseat and every rollout — and three copies would be three chances to disagree. |
| A guarded POI draws from the `DiceSource` once per attempt, and nothing else draws at all | §8 rolls "if guarded"; drawing per turn instead would make a replay's rolls depend on how many turns had no guard in them. |
| A walk stops at the first step it cannot pay for | §7 says "as far as it gets this turn". Stepping over an unaffordable node to reach a free one further along is not movement. |
| `GenerationObserver` on `generateMap` | Diagnostics only, for `tools/balance`. §11 wants compactness measured both after Smooth and after Carve Valleys, and `valleyNodes` is draft-only — neither belongs in the `GameMap` that Q15 sends to every client. |
