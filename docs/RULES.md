# Game rules as the code has them

A short orientation for a new contributor: the turn and rollout rules the
packages actually encode, and where each one lives. It is a reading of the
code, not a new authority — **[`GDD.md`](../GDD.md) remains the single source of
truth**, and every rule below traces back to a GDD section, cited as `§n`. If
this file and the GDD ever disagree, the GDD wins and this file is wrong.

One thing to know before reading: after the architecture pass, much of the
engine is deliberately unimplemented. Rules that are pure bookkeeping (victory,
allowance refresh, tree expansion, rollout termination, remoteness scoring) are
real code; rules about walking a path or resolving a guard live as contracts on
functions that still throw `NotImplementedError` with the GDD section to
implement against. The rules are decided either way — see
[`docs/OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md) for how each was settled.

## The shape of a game

Two to five players share one map of ~240 nodes across plains, forest and
mountain terrain. Sixty of those nodes are POIs holding rewards; gold is the
only thing anyone wins with. Nothing is hidden — the whole map, every POI and
every reward is visible to everyone from the start (§1).

Every player has seven uncapped stats, one per reward kind: plains / forest /
mountain moving skill, fighting, magic, gold and stamina. Claiming a reward of
kind K with N units simply adds N to stat K — the stat block is typed as
`Record<RewardKind, number>` so the two lists cannot drift apart
(`packages/core/src/player.ts`).

**Setup.** Seats are allocated in the order the game master accepts join
requests, and turn order is frozen when the game starts and never changes
afterwards (§2, §6.1). Every player starts on the *same* node: a random plains
node that is not a POI (`chooseStartingNode`, `packages/core/src/gamemap.ts`).
Stamina is the one stat that does not start at zero — seat *n* starts with
`STARTING_STAMINA_BASE + (n − 1) × STARTING_STAMINA_INCREMENT`, i.e. 30, 40, 50…
(`startingStaminaForSeat`, `packages/config/src/index.ts`).

**Winning.** Checked each time a POI holding gold is claimed. A lone leader wins
when their lead over the *runner-up* strictly exceeds the gold still unclaimed
on the map. Players tied at the top win together, but only once no unclaimed
gold remains — a lead of zero can only win when the threshold it must beat is
also zero (§1, `checkVictory` in `packages/core/src/rules/victory.ts`).

## A turn

A player does exactly one of two things (`TurnAction`,
`packages/core/src/action.ts`):

- **Move**, then interact automatically if the turn ends on a POI; or
- **Rest**, gaining `REST_STAMINA_GAIN` (5) stamina, with no movement and no
  interaction.

Then the turn ends and play passes to the next seat, whose allowance refreshes.
Resigned players are not skipped — an AI takes over their seat and keeps playing
(§7.3). The whole sequence is one pure function, `applyAction`
(`packages/core/src/rules/turn.ts`): it is the only writer of `GameState`, and
the session layer, the AI and the balancing harness all drive the game through
it, which is what lets MCTS search real game states rather than an approximation.

**A zero-length move is legal, and is not the same as resting.** Standing still
with an empty path still ends the turn on the POI, so interaction re-triggers
and you get another roll at the guard; resting explicitly involves no
interaction. A player camped on a guarded POI therefore chooses each turn
between another attempt and recovering stamina, never both.

### Movement

A moving skill of level N lets a player step onto N nodes of that terrain per
turn for free. Each terrain has its own independent allowance and all three
refresh every turn — the allowance simply *is* the skill level (§7,
`refreshAllowance` in `packages/core/src/rules/movement.ts`).

Beyond the free allowance, stamina pays: 1 plains / 2 forest / 3 mountain per
node. Cost is charged for **entering** a node, so the terrain that matters is
the destination's, not the one being left. Allowance is consumed in path order,
per terrain.

The GDD's worked example (§8) is the reference behaviour: stamina 14,
plains-move 3, forest-move 1, mountain-move 0, standing on plains. Three plains
steps are free; a fourth costs 1 stamina, leaving 13; then one forest step is
free because forest-move is 1.

A player commits a path and the character walks to the destination **or as far
as it gets this turn**; the unwalked remainder is saved as next turn's planned
path and can still be changed (§7.1). The client's coloured path preview
(green = free, yellow = costs stamina, grey = unreachable) comes from
`previewPath`, deliberately the same function family as `resolveMovement`, so
what a player is shown and what the server commits cannot disagree. Grey means
"not this turn", never "impossible" — resting always restores stamina.

**One distance metric, everywhere.** That same 1 / 2 / 3 weighted terrain cost is
the only distance in the design: the UI's shortest path, the remoteness walk
(§5.1) and the AI's POI targeting (§9) all use it, from
`packages/core/src/path.ts`. There is no second cost function in the repo, and
shortest-path ties break deterministically so two clients, the server and a
replay all draw the identical path.

### Arriving at a POI

Interaction is automatic on arrival (§8,
`packages/core/src/rules/interaction.ts`):

- Unguarded → the reward is taken.
- Guarded → roll 1d6; if `roll + the matching skill (fighting or magic) >
  guard_strength`, the reward is taken. Otherwise it stays on the node and
  **the roll costs nothing else** — there is no penalty field because there is
  no penalty.

Either outcome ends the turn. A claimed reward is consumed and the node
thereafter behaves like any ordinary node of its terrain (§4.5).

Three things the engine deliberately does *not* track: any player may attempt a
guarded POI on their turn, not just whoever failed first; players may leave and
return, or stay put; and any number of players may share a node. So there is no
per-player attempt history and no occupancy check anywhere.

The die is never rolled inside the engine. `applyAction` takes a `DiceSource`,
so the session layer supplies an authoritative server-side stream (kept separate
from the public map seed, so clients cannot precompute rolls) and MCTS supplies
its own.

## Rollouts

"Rollout" means the simulation phase of the AI's MCTS search (§9), not a game.
It matters to contributors well beyond the AI package, because a rollout plays
through the real rules: every turn of a rollout goes through `applyAction`, with
allowance, stamina, guard rolls and turn order applying exactly as in a live
game.

**Every seat is simulated by the same policy** — human-controlled players
included. There is no separate opponent model; the rollout plays whichever seat
is active, in turn order. The `subject` on a `RolloutCursor` only says whose
gold gets read at the end.

**Choosing a target is a macro-action.** The simulated player commits to a POI
and keeps moving toward it across as many turns as it takes, making no new
decision on the way. It ends on exactly three conditions (`macroAdvanceToTarget`
in `packages/sim/src/rollout.ts`): `arrived` (with interaction resolved),
`target_claimed_by_other` (the commitment lapses and the caller picks again), or
`terminal`. Tree expansion uses the same macro-action semantics, so one tree
edge and one rollout leg mean the same thing and node values compose — and the
tree stays shallow enough to search within the time budget, because a node is a
real decision point rather than a single step.

**Targets are the `CLOSE_CANDIDATE_COUNT` closest eligible POIs, picked
uniformly at random.** Ranking is by the weighted terrain cost above, and the
whole thing — rank, then pick uniformly among the nearest K — is written once in
`packages/sim/src/candidates.ts` and shared by three callers: the remoteness
walk (§5.1, over *unvisited* POIs), the rollout policy (§9, over *unclaimed*
POIs) and tree expansion (also unclaimed). They share the one K as well, so
tuning `CLOSE_CANDIDATE_COUNT` moves all three together; what differs is
eligibility, and what each does with the ranked list.

**A rollout stops when no gold rewards are left on the map.** That is the rule,
and it is specifically *not* "all POIs claimed": a rollout ends with skill and
stamina POIs still sitting on the map, which is the point — gold is the only
thing anyone wins with, so a state with none left is already decided, and
simulating the tail buys the search nothing while costing real time against the
10-second budget. `goldExhaustedTermination` also stops on a finished game,
since §1's win condition can fire earlier, when a leader's lead already exceeds
what remains. Termination sits behind an interface because a turn or depth cap
is the obvious lever if rollouts prove slow, and it would change what the
backpropagated value means (`packages/sim/src/rollout.ts`).

**What comes back.** There are three kinds of node evaluation, and they are
worth keeping apart (`packages/ai/src/policies/evaluators.ts`):

- **simulated** — the subject's gold once the rollout above has run to gold
  exhaustion. `simulatedRolloutEvaluator()`. This is §9's specified default
  and the one v1 uses; the other two are there to experiment with.
- **estimated** — no rollout at all: the subject's gold and skills as they stand
  at the node being evaluated, weighted by how far the game has run, so skills
  count for most at the opening and gold for everything at the end.
  `estimatedGoldAndSkillsEvaluator()`; the formula is in the register.
- **hybrid** — the average of the two, composed from them rather than
  reimplementing either. `hybridGoldAndSkillsEvaluator()`.

Every evaluator returns a value in [0, 1], which is what makes
`MCTS_EXPLORATION_CONSTANT` = √2 right: UCB1's derivation assumes that range, so
changing one means revisiting the other. They do not all reach that range the
same way — simulated divides gold by the total gold on the map, estimated adds
two ratios under weights that sum to 1 — so what a new evaluator has to
preserve is the range itself, not a particular divisor.

**Around the rollout**, the search selects with UCT, expands one untried branch
at a time through `applyAction`, and returns the most-visited child of the root
("robust child") once `MCTS_TIME_BUDGET_PER_MOVE` (10 s) is spent. Branches at a
node are those same `CLOSE_CANDIDATE_COUNT` closest unclaimed POIs, *recomputed
against that node's state*,
plus a rest branch, added only when fewer than `MIN_REACHABLE_NODES_FOR_REST`
(3) of those targets are reachable this turn — which is exactly when a player is
stamina-bound and resting is worth searching. `search()` returns only the
**first turn** of the chosen branch, since the session layer commits one turn at
a time; the rest of the macro-action is re-derived next turn
(`packages/ai/src/mcts.ts`, `packages/ai/src/policies/tree.ts`).

## Where the rules live

| Rule | File |
|---|---|
| Turn sequence, turn order | `packages/core/src/rules/turn.ts` |
| Allowance, stamina, path walking | `packages/core/src/rules/movement.ts` |
| Automatic interaction, guard rolls | `packages/core/src/rules/interaction.ts` |
| Victory and unclaimed gold | `packages/core/src/rules/victory.ts` |
| The action space | `packages/core/src/action.ts` |
| Distance metric, path preview | `packages/core/src/path.ts` |
| Target ranking and choice (shared) | `packages/sim/src/candidates.ts`, `walk.ts` |
| Rollout, macro-actions, termination | `packages/sim/src/rollout.ts` |
| Remoteness walk and scoring | `packages/sim/src/remoteness.ts` |
| Tree policy, branches, evaluators | `packages/ai/src/` |
| Every constant named above | `packages/config/src/defaults.ts` |

Two standing rules for changing any of this: constants never get hard-coded —
they live in `@adventure/config` — and nothing in the GDD gets "improved".
Stated formulas and numbers are transcribed as-is, including the ones that look
like starting points; they are values the designer intends to tune.
