# Open items routed around in the architecture pass

Every unresolved item that actually shaped a decision in the code, what I did
about it, and where the seam lives. Two categories:

- **Routed around** — the architecture stays coherent without an answer. There
  is a named interface or a `pending` config entry, it has *no default*, and
  reading it throws with a GDD reference attached.
- **Asking** — I could not proceed honestly without you, or I found a gap or a
  discrepancy that isn't in GDD.md §12 and that you should see.

Nothing below was resolved by picking something reasonable.

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

### Q1. What exactly is a POI's per-walk remoteness score? (§5.1) — **blocking**

§5.1 fixes the walk, the distance metric and the normalisation, but not the
score itself. Three readings are all consistent with the text, and they produce
materially different remoteness fields:

1. the cumulative walk cost when the POI was first reached;
2. the cost of the single leg that reached it;
3. its ordinal position in the visit sequence.

"Distance for 'closest' and for **walk-segment lengths** uses the same weighted
terrain cost" suggests cost rather than ordinal, but doesn't separate (1) from (2).

This is load-bearing: remoteness feeds both guard strength (§5.2) and reward
stacking (§4.3), so getting it wrong silently mis-balances every map.

**Routed as:** `RemotenessScorer` is injected into `computeRemoteness`;
`defaultRemotenessScorer()` throws rather than shipping a guess.
`packages/sim/src/remoteness.ts`

### Q2. How does §5.2's proportionality become an actual guard strength? — **blocking**

`guard_strength + remoteness × REMOTENESS_WEIGHT ∝ reward` is a proportionality,
and the pipeline forces the direction of the derivation (§4.3 fixes gold amounts
first, so guard strength is the unknown). Missing: the constant of
proportionality, the rounding, and what happens outside `GUARD_STRENGTH` (2–10).

Taking §5.2's own anchor literally — 1 gold at remoteness 1 ↔ guard 4 at
remoteness 0, both giving 4 — implies a scale of 4 per gold unit, which sends a
10-gold POI to strength 40. So something has to give: clamp at 10, a non-linear
scale, or a cap on gold per POI. Which one is a design call.

Related: the anchor describes "1 gold **unguarded**", but §4.4 says every gold
POI is guarded and `GUARD_STRENGTH_MIN` is 2, so strength 0 isn't reachable. I
read the anchor as an illustration of relative difficulty rather than an
assignment rule, but flagging in case it was meant literally.

**Routed as:** `pending.GUARD_STRENGTH_SCALE` (throws on read);
`guardStrengthFor()` takes the scale as a parameter.
`packages/mapgen/src/rewards/guards.ts`

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

### Q12. Where do players start on the map? (§6) — **blocking**

I can't find this anywhere. §6 specifies seat order, per-seat starting stamina
and fixed turn order; §5.1's "random plains position" is about balancing walks,
not players. But a game can't begin without a starting node per player.

Sub-questions, whichever way you go: same node for everyone or different ones?
Plains only? Away from POIs? Deterministic from the map seed?

**Routed as:** `PlayerState.position` exists; `SetupFlow.start()` throws with
this note. `packages/session/src/setup.ts`

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
