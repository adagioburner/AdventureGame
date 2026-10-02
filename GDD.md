# Game Design Document — Skyholm Adventures

Status: v1 design, consolidated from `Annotated_Design_Document.md` (the traceability record — original text plus every clarification, in full, with typo/naming history preserved). This file is the clean version for implementation: typo corrections, superseded terminology, and clarifications that only confirmed an already-obvious reading have been left out. **Every statement is still tagged with its provenance** — `[SOURCE §x]`, `[SOURCE §x, chat]`, `[SOURCE §x, review]`, `[INFERRED]`, or `[OPEN]` — so nothing here is invented. `[SOURCE §x, review]` is a decision the designer made reviewing a pull request, superseding or extending what §x said; the superseded text is kept alongside it, tagged as it was. `[OPEN]` items are genuinely undecided; do not fill them in. See §12 before writing code that touches those areas.

---

## 1. Overview

[SOURCE §intro] A multiplayer turn-based adventure game, supporting AI players alongside humans, playable online or via a hotseat mode (§7.2).

[SOURCE chat, review] **The game is called Skyholm Adventures.** Andrei, 2026-10-01: "Since we are going with the floating island theme, let's change the game's name to Skyholm Adventures. We need to change it to that everywhere it fits, and just to Skyholm where it doesn't. The site address can stay adventure.aburago.workers.dev for now". The top bar's title reads Skyholm Adventures, or Skyholm where the full name would push the bar onto another row; browser tabs carry the full name. Names no player sees (code packages, browser storage keys, the Workers behind the address, the repository) keep the old one. Registered as Q175.

[SOURCE §2] There is no hidden information: the entire map, all POIs, and all rewards are visible to every player at all times.

[SOURCE §2] The goal of the game is to collect gold. A player wins once their gold lead over every other player exceeds the amount of gold still unclaimed on the map [SOURCE §2, chat: evaluated each time a POI with gold is claimed]; a tie for the win results in shared victory.

---

## 2. Map Generation

[SOURCE §1] The map is a planar graph, ~240 nodes and ~300 edges, rendered as small ovals connected by road/path-styled edges, in isometric view [SOURCE §6].

[SOURCE §1] The map is divided into three terrain types — plains (light brown), forests (green), mountains (grey) — each with matching eye-candy dressing (mountains, trees, grass texture, bushes, rocks) and matching node color.

[SOURCE §1] Terrain regions are generally rounded (low perimeter-to-area ratio), except plains, which may extend long single-node-wide "valleys" into forest or mountain territory.

[SOURCE §1.3, chat] The map's coordinate space has no required real-world scale — players always view it zoomed in. Use any convenient large coordinate space (e.g. 1,000,000 units) and set the initial camera zoom so the whole map is visible on screen at game start.

### 2.1 Generation pipeline

[SOURCE §1.3] Steps run in this exact order, every one drawing from a single seeded PRNG so a map is fully reproducible from `(seed, params)` — needed for debugging, replays, and the balancing harness:

1. **Sample positions** — Poisson-disc sampling over the map rectangle, ~240 points.
2. **Triangulate** — Delaunay triangulation over the points (planar by construction; planarity never needs re-checking).
3. **Prune to budget** — remove edges longest-first, with jitter, down to 300 edges; reject any removal that disconnects the graph or pushes leaf count outside 30–45.
4. **Seed terrain regions** — 1 or 2 seeds per terrain (plains, forest, mountain); grow by flood fill biased toward nodes with more same-terrain neighbours, until area shares are approximately 45% plains / 30% forest / 25% mountain.
5. **Smooth** — flip isolated nodes to their majority-neighbour terrain until `compactness = boundary² / area` falls below `COMPACTNESS_MAX` [SOURCE §1.3, chat: circle reference = 4π ≈ 13; `COMPACTNESS_MAX` starts at 25].
6. **Carve valleys** — convert 2–4 narrow (1-node-wide) fingers of 5–12 nodes from the plains boundary into neighbouring regions; these nodes are exempted from the Smooth step (there is only the one Smooth pass, above — Carve Valleys runs once, after it).
6b. **Join borders** [SOURCE §2.1, chat] — put pruned triangulation edges back where two terrain areas of at least `BORDER_AREA_MIN_SIZE` nodes meet in fewer than `BORDER_ROAD_PLACES` separate places (edges sharing a node count as one place): no edge longer than `BORDER_ROAD_MAX_LENGTH` times the longest edge step 3 kept, none that shares a node with a crossing the pair already has, the first one the shortest and each later one the farthest from the pair's existing crossings; an edge that joins a leaf only while at least `LEAF_COUNT_MIN` leaves remain. Two pieces of one terrain that touch in the triangulation but share no edge are joined by `JOINED_PIECE_ROADS` edges the same way. Terrain is unchanged, and every added edge comes from step 2, so the graph stays planar (OPEN_QUESTIONS Q105).
7. **Place POIs** — node selection and reward assignment; see §3 and §4.
8. **Validate** — reject and regenerate the whole map if: disconnected, or leaf count outside 30–45.

> [SOURCE §2.1, review] **The area shares in step 4 are a property of the finished map, not of the draft step 4 hands on.** Carve Valleys converts nodes out of forest and mountain into plains, so measuring the shares before it runs lets the finished map drift a long way from 45 / 30 / 25 — over 40 seeds the finished mountain share ran from 6.4% to 31.0%, and one seed finished 65 / 26 / 9. Step 6 therefore ends by growing whatever terrain is now short back into plains, leaving the carved fingers and the plains node each one opens from untouched. The same growth also finishes step 4, whose flood fill cannot reach the shares on its own: a region on a graph this sparse is routinely sealed off, every neighbouring node already claimed, while it is still far short. Because §4.2 fixes the POI count per terrain, a terrain that loses nodes also crowds its POIs — the skew that made this visible had two thirds of every mountain node carrying a POI.

> [SOURCE §2.1, chat] **Why step 6b.** Step 3 leaves a graph that is nearly a tree and step 4 grows terrain along it, so terrains meet exactly where edges are fewest: over 100 maps 12% had no plains–forest edge at all, and only 77% of forest nodes could be reached from plains without entering mountain. Pruning to more edges instead fails the leaf test (at 330 edges most maps regenerate, at 360 none can be made). With step 6b at `BORDER_ROAD_PLACES` = 1 a map carries ~300–315 edges.

> [SOURCE §1.3, chat] Compactness is *not* re-checked at the Validate step: Carve Valleys deliberately reduces compactness along the plains boundary immediately before this step runs, so re-checking it here would fail generation almost every time. Compactness is already enforced inside the Smooth step itself (step 5 loops until it's satisfied).

---

## 3. Points of Interest (POIs)

[SOURCE §1] Some nodes are POIs. A POI has: a reward (§4), optionally a guard (§4.4), and an eye-candy image of the place or — if guarded — of the guardian, with a red (fighting) or purple (magic) contour.

[SOURCE §1, review] **The red or purple goes on the POI's node, not round the guardian's image.** Andrei, reviewing the phase 3 map on 2026-09-23: "the guards should not have red or purple contours; instead, the nodes should." A guarded POI's node keeps the black outline every node has and gains a ring in its guard's colour just outside it ("let's keep the regular black one inside it as well", same day); once the POI is claimed its node is drawn as an ordinary one (§4.5). The image stands beside its node rather than on it, on whichever side covers no road and no other POI. Registered as Q31.

[SOURCE §1, review] **Every image stands right against its node, and a guardian stands on it.** Andrei, the same evening: "let us place POI images closer to the POIs themselves, close to or touching the node. Guards, specifically, can be standing on the node itself, not centered on it but intersecting at the base". An image other than a guardian touches its node's oval, measured on the picture itself rather than its bounding box, without covering it. A guardian stands with its feet on the back part of its node, off the centre, so the front of the node, the guard's colour and the reward in front of it stay in view. Where every spot on its node would cover a neighbouring node or image, it stands beside its node like the others. No dressing ever covers a POI's image: "let's have the POI images always unobscured". This revises the Q31 note above only as far as where the image stands, and is registered as Q35.

[SOURCE §1, review] **Every POI's node has a dot in the middle until the POI is claimed.** Andrei, 2026-09-29: "When I play i often miss a site by one space because the map is a bit crowded. We need to mark sites better." He chose "the dot in the middle", on guarded POIs as well, and "when a site is claimed, the dot needs to disappear"; its size and colour: "The road color and size 0.55 work." The dot is 0.55 of the node's width across, in the main brown of the roads, inside the black outline (and inside a guarded node's ring); whatever covers a node covers it too. Picking a node by tap or click is unchanged. Registered as Q80.

[SOURCE §1] POI placement: distributed randomly at approximately equal distances from each other; every leaf node of the graph must be a POI (no dead ends); leaf nodes are assigned POI status first, remaining POIs distributed randomly among the rest.

[SOURCE §1] POI counts: **25 on plains, 20 in forests, 15 in mountains** (total 60).

[SOURCE §1.1, chat] **A POI's reward is always exactly one kind** — reward kinds (§4.1) are never mixed on the same POI. A POI can still hold multiple *units* of its one kind (a stack, e.g. "plains movement +3").

---

## 4. Rewards

### 4.1 Reward kinds and icons

[SOURCE §1] Seven reward kinds, one icon each:

| Reward | Icon |
|---|---|
| Plains moving skill | brown wagon wheel |
| Forest moving skill | green foot |
| Mountain moving skill | black mountain |
| Fighting skill | red crossed swords |
| Magic skill | purple 4-pointed star |
| Gold | yellow gold coin |
| Stamina | white heart |

[SOURCE §1] A stack of N same-kind units on one POI shows N (possibly overlapping) icons.

[INFERRED §6] The seven icon image assets Andrei supplied match this table with no discrepancies. Two arrived under names that did not describe them; they are now `Art/Icons/<reward kind>.png`, one per row above (see Q20).

### 4.2 Reward totals per terrain

Three things per kind, all needed by the assignment algorithm in §4.3: the total reward **units** of that kind on the terrain, how many **POIs** on that terrain are dedicated to that kind (these must sum to the terrain's total POI count, since every POI gets exactly one kind, §3), and — for gold specifically — its **guard type**. Where a terrain's gold has more than one guard type (mountain only), the POI-count and unit-total are further split per guard type, since each guard type is effectively its own sub-kind for the §4.3 algorithm.

[SOURCE §1.1] / [SOURCE §1.1, chat]

| Terrain | Kind | Guard | Total units | POIs of this kind |
|---|---|---|---|---|
| Plains (25 POIs) | Plains moving skill | none | 20 | 10 |
| | Forest moving skill | none | 15 | 7 |
| | Magic skill | none | 10 | 6 |
| | Gold (informally "cities") | fighting | 10 | 2 |
| Forest (20 POIs) | Mountain moving skill | none | 15 | 8 |
| | Fighting skill | none | 15 | 8 |
| | Gold | magic by `FOREST_MAGIC_GUARD_CHANCE` (1: always), else fighting (Q115, Q185) | 5 | 4 |
| Mountain (15 POIs) | Gold | fighting | 20 | 10 |
| | Gold | magic | 10 | 5 |

[SOURCE §4.2, Q160] With 4 or 5 players the map is 40% larger (§11's larger map): every row's units are 1.4 × the above, and its POIs 1.4 × rounded to the nearest whole number (630), so each terrain still has exactly 1.4 × its POIs.

| Terrain | Kind | Guard | Total units | POIs of this kind |
|---|---|---|---|---|
| Plains (35 POIs) | Plains moving skill | none | 28 | 14 |
| | Forest moving skill | none | 21 | 10 |
| | Magic skill | none | 14 | 8 |
| | Gold | fighting | 14 | 3 |
| Forest (28 POIs) | Mountain moving skill | none | 21 | 11 |
| | Fighting skill | none | 21 | 11 |
| | Gold | magic by `FOREST_MAGIC_GUARD_CHANCE` (1: always), else fighting (Q115, Q185) | 7 | 6 |
| Mountain (21 POIs) | Gold | fighting | 28 | 14 |
| | Gold | magic | 14 | 7 |

### 4.3 Reward assignment algorithm

[SOURCE §1.3, chat] Run per terrain, per row of the §4.2 table (i.e. per kind, or per kind+guard-type where gold is split by guard type):

1. **Assign kind (and, for gold, guard type) to POIs.** Partition the terrain's POIs into groups sized by the "POIs of this kind" column (e.g. on plains: 10 POIs → plains-movement, 7 → forest-movement, 6 → magic, 2 → gold/fighting-guarded; all 25 plains POIs accounted for, no overlap. On mountain: 10 POIs → gold/fighting-guarded, 5 → gold/magic-guarded).
2. **Give every POI 1 guaranteed unit** of its assigned kind.
3. **Distribute the remaining units** of that row's total (total units − POIs of this kind, from §4.2) one at a time, to a randomly chosen POI within the same group, weighted so each POI's chance is inversely proportional to `(its current count of this type − (remoteness − 1) × REMOTENESS_WEIGHT_FOR_DISTRIBUTION)`. Default `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` = **2** (distinct from `REMOTENESS_WEIGHT` in §5.2) — intentionally: weight decreases as a POI's own count grows, and increases the more remote the POI is, so extra units gravitate toward remote, lightly-stacked POIs.
4. **Swap pairs toward remoteness.** [SOURCE §4.3, review] Draw `REWARD_SWAP_PASSES × (POIs in the row)` pairs of POIs from within the same group, and swap the two POIs' unit counts whenever the larger stack is sitting on the less remote of the two. Default `REWARD_SWAP_PASSES` = **5**. This is a repair pass, not a sort: it is not run to completion, and the map keeps the variety a full ordering would take out.

Since remoteness ∈ [0,1], `(remoteness − 1) ∈ [−1, 0]`, so step 3's denominator is always `current_count + (1 − remoteness) × REMOTENESS_WEIGHT_FOR_DISTRIBUTION` — current_count (≥1, from the guaranteed baseline) plus a non-negative term. It's always ≥ 1, for any non-negative value of `REMOTENESS_WEIGHT_FOR_DISTRIBUTION`, so the earlier non-positive-denominator problem no longer applies at all, regardless of how that constant is tuned later.

[SOURCE §4.3, review] Why step 4 exists. Step 3's weighting leans the right way but only weakly — measured over 200 generated maps, the bigger of two stacks in the same row was the more remote one **57.1%** of the time, and raising `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` saturates near 65% however far it is pushed, because step 3 is a *random draw* and §4.2 hands most rows barely more spare units than POIs (plains movement: 20 units over 10 POIs). Andrei's ruling: "we can distribute rewards without much regard for remoteness, and then for a number of times consider pairs of POIs with the same type of reward and swap their rewards if they do not correlate with their remoteness — we don't have to do complete ordering", with **90%** named as a satisfactory level of agreement. Measured, same 200 maps: 2 passes → 86.8%, **3 passes → 91.8%**, 5 → 96.3%, 10 → 99.3%. Three passes clears 90% across a batch; five clears it on all but one map in 200 read one at a time, which is why the default is 5. A swap exchanges two stacks inside one row, so every §4.2 total, every row's POI count and step 2's guaranteed unit all survive it untouched.

### 4.4 Guards

[SOURCE §1] A reward may (not must) be guarded: shown as a red number (fighting-gated) or purple number (magic-gated) beside the node, indicating guard strength, range **2–10**.

[SOURCE §1.1, chat] In v1, only gold rewards are guarded — every gold POI on every terrain is guarded, none are exempt. Guard type by terrain (per §4.2): plains' 2 gold POIs are all fighting-guarded; mountain's 15 gold POIs split 10 fighting-guarded / 5 magic-guarded. The engine should not hard-code "gold only" — guarding should work on any reward kind — this is a v1 content choice, not an engine constraint.

[SOURCE §4.4, chat] Forest's 4 gold POIs are each guarded by magic with chance `FOREST_MAGIC_GUARD_CHANCE` and by fighting otherwise, a coin flip for each POI on its own, so a map carries anywhere from none to all four magic-guarded (Q115). Andrei, 2026-09-30: "Magic doesn't play an important enough role. Can you make it so the forest POI are assigned randomly either magic or combat guards?" The POIs stay one §4.2 row (fighting), so its POI count and units are unchanged, and §5.2's strength never reads the guard type. The flips are the map's last draws, after every POI's picture, so on any seed only these guards differ from the map before the change.

[SOURCE §4.4, chat] Since Q185 the chance is 1: every forest gold POI is magic-guarded. Andrei, 2026-10-01: "After playing some more I think we need to make all gold in the forests guarded by magic. Otherwise magic plays too little role", and "it's a good idea to keep the logic that says forest magic is decided by chance, just turn this chance all the way to 100%". A hot seat game kept from the coin-flip days goes on with the guards it began with (730 A).

### 4.5 Consumption

[SOURCE §2] A POI's reward is consumed once claimed; the node then behaves like an ordinary node of its terrain type for the rest of the game, or, in a game started before speeds and skills could be bought (§7, Q190), until the reward comes back (below).

[SOURCE §4.5, chat] **Speeds and skills come back** (Q135), only in games started before they could be bought: buying replaces it for every game started since, and the code stays for the games started before (§7, Q190, 757 and 758). Andrei, 2026-09-30: "Already with 4 players, some necessary skills like combat run out too quickly. They need to respawn. This is especially true for combat and magic that are necessary for fighting guards. Skills need to respawn where there are too few of it left, randomly at POIs that were offering this skill before and are far from all players." At the end of every turn, each of the five skills (the three moving skills, fighting, magic) is counted on its own; while fewer than `RESPAWN_SHORT_BELOW_SITES` unclaimed POIs offer it, whatever their units, one claimed POI that held it gets its reward back, but no more than `RESPAWN_MAX_UNITS` units of it, one POI per turn (Andrei, 2026-10-01: "let us cap the skills to 2 units when they respawn. The idea is to provide a player who was late to the party with something to do, not to create a cornucopia"; later that day, having played: "even capping regrown skills by 2 is too much. It's not supposed to be easy when skills run out. Starving your opponents of some skill should be one of the strategies. Let's change that cap to one."). It is drawn at random from the farther half (`RESPAWN_FAR_SHARE`, rounded up) of those POIs, by the stamina cost of the cheapest route from the nearest figure, never one a figure stands on, and a POI can come back again and again. The rulebook leaves out how that POI is picked and that it can come back again (Andrei, 2026-10-01: "These all are unnecessary details for the players, the game engine takes care of them. THey need to be removed from the rulebook -- but we also need to make sure they are preserved somewhere else"; 545). Gold and stamina never come back. Andrei, 2026-10-01: "We need two *sites* with the skill at any time, not two units of skill on the map". Games started before the rule keep the old one. It is not silent: Andrei, 2026-09-30, "There has to be a respawn sound, and if Track is pressed, we should bring the respawn site into view". Once the turn's walk, die and claim notice are done, the POI's icons come back with a far bell; with Track pressed the map first glides there, as at the start of a turn, and stays 1.5 seconds before gliding on to the player on turn (539 B, 540 A, 541 A).

[SOURCE §2, review] **A claimed POI's image does not change.** Andrei, 2026-09-23: "The claimed POIs should lose their icons, but the images DO NOT CHANGE." Its reward icons, guard strength and guard ring go; its picture stays exactly as it was. Registered as Q36.

---

## 5. Balancing

[SOURCE §1.2] Reward difficulty balances guard strength against remoteness.

### 5.1 Remoteness

[SOURCE §1.2] Computed via simulated random walks: start at a random plains position, repeatedly move to one of the `REMOTENESS_CANDIDATE_COUNT` closest unvisited POIs (chosen at random among them), until every POI has been visited once per walk. Distance for "closest" and for walk-segment lengths uses the same weighted terrain cost as movement: 1 plains / 2 forest / 3 mountain per step [SOURCE §1.2, chat: the one distance metric used throughout the design — also for the UI's shortest-path display, §7, and the AI's own POI targeting, §9]. [2026-09-30, Q112] The AI still walks these cheapest routes, but ranks the sites at their ends by its own speeds (§9). [2026-10-02, Q210] The route drawn for a person and the route a computer's real move walks are the best for the player's speeds instead (§7.1); the computer's search and the games it imagines still use these cheapest routes. Run `REMOTENESS_SIMULATION_RUNS` walks, normalize the resulting per-POI scores to **[0, 1]**.

[SOURCE §1.2, chat] `CLOSE_CANDIDATE_COUNT` = **10**, raised from 5 once §9's MCTS tree began pruning to this same constant: "we don't want to risk pruning out good moves early on". [SOURCE §5.1, review] The walk's K is now its own setting, `REMOTENESS_CANDIDATE_COUNT` = **10**, and `CLOSE_CANDIDATE_COUNT` is the computer player's alone (§9's rollout and tree): "if we change the setting for the number of the closest places, it should affect computer player only [...] these two definitely need to be separated" (Q66). `REMOTENESS_SIMULATION_RUNS` = **100** (expected to change if 100 proves too imprecise or too slow). This random-walk code is shared with the AI player's MCTS rollout policy (§9).

### 5.2 Guard-strength / remoteness formula

[SOURCE §1.2, chat] `guard_strength + remoteness × REMOTENESS_WEIGHT ∝ reward`, where `reward` is the gold amount being protected (v1 guards gold only, §4.4).

`REMOTENESS_WEIGHT` starting value: **4** (anchor: 1 gold unguarded at max mountain remoteness ≈1, vs. guard 4 on plains at min remoteness ≈0 — both config values, tuned later by play-testing).

---

## 6. Player Stats & Setup

[SOURCE §2] Per-player stats, uncapped: stamina, plains/forest/mountain moving skill levels, fighting skill, magic skill, gold. Displayed for every player to see, next to name and avatar.

[SOURCE §2, review] **On screen the moving skills are "plains speed", "forest speed" and "mountains speed", and fighting is "combat".** Andrei, trying the hotseat game on 2026-09-23: rename them "consistently throughout the interface". The rules and the code keep their names (`plains_move`, `fighting`, a `fighting` guard); only the words a player reads changed. Registered as Q33.

[SOURCE §2, review] **On a laptop card the moving stats are the left column, and gold's number is red.** Andrei, 2026-09-30: "On a player card, it would be nice to arrange everything that has to do with moving (stamina + 3 speeds) in the left column, and the rest in the right column, with gold going last. Also, can we show the number for gold in red so one glance would be enough to see who has how much of it". From 900 wide the left column is stamina, plains speed, forest speed and mountains speed, and the right one combat, magic and gold from the top. Gold's number is deep red on every card; phones keep their one row of icons, already in this order. The end-of-game table is unchanged (Q140).

[SOURCE §2, chat] Player count: **2–5** (config, not a hard limit). Turn order fixed at game start, never changes thereafter (order determined by whatever is most convenient to implement — expected default: order the game master accepts join requests, §6.1).

[SOURCE §2, chat] Starting stamina by seat: `STARTING_STAMINA_BASE` (default 30) + (seat − 1) × `STARTING_STAMINA_INCREMENT` (default 5).

[SOURCE §2, chat] **Every player starts with `STARTING_GOLD` (5) gold, the same for every seat.** Andrei, 2026-10-02: "Now that players can buy skills for gold, it makes sense to starts them with 5 gold to enable a variety of strategies" (Q200). Only games started since get it: a game started before keeps its players starting on none to the end, online because its map carries the config it was made with, on one device because the kept game records the gold its players started with (790). The New game screen's seat line still names only the starting stamina, which is what differs between seats (792). Nothing that decides the winner moves: the win check compares a lead with the gold left on the map, and 5 each changes no lead.

[SOURCE §2, chat] **The increment is 5, not 10** (Andrei, 2026-09-29, after 4-seat computer games at 3 s a move: with 10 the later seats ended with more gold; with 5 the four seats came out even). Registered as Q75.

### 6.1 Setup flow

[SOURCE §3] A setup screen lets the game master choose player count, lets other players join, and lets the game master accept or reject them. Each player picks a name and avatar.

[SOURCE §3, chat] The game master is the person who created the game on the game's web portal. This role cannot be transferred to anyone else in v1.

[SOURCE §3] Logged-in users see a list of in-progress games and can join one or start a new one.

[SOURCE §3, chat] v1 authentication: username + password. **Architecture requirement:** design the auth layer so stronger security can be swapped in later without a rewrite.

[SOURCE §3, review] **The game master may start before every seat is filled; computers play the empty seats.** Andrei, 2026-09-24: "the game master should be able to start the game before all seats are filled. The unfilled seats are played by the ai." The game master plays, in seat 1 unless the seats are shuffled (Q165). They are named "Computer 1", "Computer 2" and so on, each with a free figure, and each has its own thinking time on the setup screen (1 to 60 seconds, starting at 10); the game master may change their names and figures before Start, and may start with nobody else joined. The rest of the setup screen, the game list and the account rules are the sixteen details he took as recommended. Registered as Q48. A person may take a figure a computer holds, and the computer switches to a free one; a join request holds no figure, so the first of two people asking for one figure to be accepted gets it and the other picks again. Andrei: "What conflict resolution happens by default doesn't matter as long as such races are properly detected and resolved and the players are notified and allowed to act on it." Registered as Q49.

[SOURCE chat, review] **One setup screen for a game on one device and a stored game, with a "Play online" switch.** Andrei, 2026-09-24: "Can we unify these screens, with a simple toggle that tells us whether the game we create is stored?" Both take 2 to 5 players and give every seat Human and Computer buttons and its own thinking time. With the switch on, the game is stored and listed at once and has a name; seat 1 is the game master's, every other Human seat is kept for someone who asks to join, an accepted person takes the first free one, and the computer plays any Human seat still empty at Start. Turning it off before the start removes the game, asking the game master first if anyone has asked to join, and telling those people it was cancelled. The game list has one New game button that opens the screen with the switch on; the login page's "Play on one device" opens it without the switch. The switch reads "Play online", with "Others can ask to join, and it stays in your games." under it. Registered as Q51.

[SOURCE chat, review] **Shuffle seats.** Andrei, 2026-10-01: "I'd like to be able to shuffle player seats before the game starts. The game master does not necessarily need to be on seat 1. It could be a toggle on the game start screen", and "the spec says the seats are assigned in the order requests are accepted but one should be able to reshuffle them before the start." A "Shuffle seats" switch under Players, like Play online's, with "Seats are drawn at random when the game starts." under it, on one device and online alike. With it on, every seat, the game master's too, is drawn at random when Start is pressed, and each player starts with the stamina of the seat they draw. The seat cards keep their seat numbers until then; online, players who joined read "Seats are shuffled when the game starts." after the game master's name. The switch stays as set for the next New game and goes along with Play online, and New game lists the seats as set, not as drawn. Registered as Q165.

[INFERRED §3] Hosting/infrastructure is explicitly left open. See §12.

---

## 7. Turn Structure & Movement

[SOURCE §2] A turn is: move, then (if the turn ends on a POI) interact automatically; or rest instead (gain `REST_STAMINA_GAIN` stamina, default 5, config — no movement/interaction).

[SOURCE §2] Movement allowance: a moving skill of level N lets a player step onto N nodes of that terrain type per turn for free; the allowance refreshes every turn and each terrain has its own independent allowance. Beyond the free allowance, stamina is spent: 1 (plains) / 2 (forest) / 3 (mountain) per node.

[SOURCE §2, chat, 2026-10-02] **Buying speeds and skills** (Q190). Andrei: "Players complain that if they didn't get the right skill early on they are screwed for the rest of the game. I have the following idea: allow players buy skills for gold, 1 to 1. We won't need respawning skills then, this mechanism substitutes that." On their own turn, before moving or resting, a player may buy any number of units of the five skills (the three moving skills, fighting, magic), never stamina or gold, for `BUY_GOLD_PER_UNIT` gold a unit (751, 753, 754). A moving skill bought gives its free step this turn too (752). Nothing bought can be sold back (755). The gold leaves the game, and a purchase runs the win check: if spending it puts another player's lead past all the gold left on the map, that player wins at once (756). A purchase is not a turn; the turn goes on. Speeds and skills no longer come back in games started with buying (757, §4.5), and games started before keep the rules they began with (758).

The Buy button on the card of the player on turn opens the buy panel over the map: next to the card, level with its top, where the cards stand beside the map, and across the top of the map on an upright phone (750 as changed by Andrei on 2026-10-02, "a separate buy panel in all cases, and a cancel option on it. This way, if you misclick, you can always cancel"; 770). Each skill's + adds one unit to the panel only: the tile's number goes up, with the units added in blue beside it, and "Your gold" by Done counts down. Done buys them all as one purchase and Cancel puts everything back; only those two close the panel; a + greys out once the gold left would not pay for another unit; there is no −; Rest and End turn are greyed while the panel is open (766, 768). Each Done is one turn log line, such as "Bea bought 1 mountains speed and 1 combat for 2 gold." (769); a purchase that ends the game has an entry of its own headed "Bought, and the game ended" (772). Other players see a purchase as it happens (Andrei, 2026-10-02: "Basically the purchase notice works the same way as claiming a reward, but happens before the walk, not after"; 773-786, replacing 762's log line alone): a notice floats up from the buyer's figure for each speed or skill bought, such as "Bought magic +2", with units of a skill counted together, one after another in the cards' order, each with the claim notice's timing and with the cash register Andrei supplied. Online every page but the buyer's shows it; on one device, only a computer's purchases. The buyer hears the cash register as they press Done, without a notice. A computer's walk waits until its last purchase notice has faded, and so does the end of the game when a purchase ended it. Like a claim's, the notice is missed when the buyer's figure is out of view. Purchases caught up online, or already in the log when a game opens, have neither notice nor sound. Online, a Done that arrives after the turn has ended buys nothing, and the player is told "Your turn ended before the purchase arrived, so nothing was bought." (771). Sideways phones have the Buy button too (763), and on an upright phone the card's "Turn N ·" and "Playing now" stand on two lines, clear of it (764). The computer thinks once a turn, then makes its purchases as one and plays its move (761; §9).

### 7.1 Online UI

[SOURCE §4] Click-drag to pan, `+`/`-` to zoom. Clicking the player's own highlighted character enters moving mode; clicking a destination node highlights the shortest path (weighted terrain cost, §5.1) with a thick dotted line and an isometric cross at the destination. Shift-click sets an intermediate waypoint when more than one path exists.

[SOURCE §4, chat, 2026-10-02] **The route drawn is the best for the player's speeds** (Q210). Andrei: "it bothers me that the game shows to me the path that is not optimal based on my current skills. How hard is it to make the players, including computer players, take the optimal path by default". The route highlighted, and the route a computer's real move walks, is the one with the least effective distance for the player's speeds: the least over n ≥ 1 turns of 5n + the stamina still needed after n turns of free steps, the Q112 formula of §9 applied to the route's own steps per terrain (810 A). Only routes that no other route beats on all three terrains' step counts can be best, so those are what the search keeps (`RouteTable.routesFrom`). A route only as good as the cheapest by weighted terrain cost leaves that one drawn, and among routes equally good the cheaper by weighted terrain cost wins, so a player with no speeds sees exactly the route they did (811 A). With a waypoint, each leg is the best on its own (812 A). Buying a speed picks the route shown again for the new speeds, a waypoint still ahead kept, as choosing its destination again would (813 A); a route brought back from the turn before stays down when that happens, so Track stays as it was, and online the new route is saved (818 B). Games under way get it too, no rule having changed (815 A). The rulebook says only that the game draws the route it thinks is best (816). Andrei set three stages for the computer: its real moves first (this), then the choices its search weighs, then the games it imagines, which will work out arrival from the steps per terrain and trace a route only when another player claims the target first.

[SOURCE §4] Path coloring: green = covered by current skill allowance, yellow = costs stamina (labeled with the stamina cost, e.g. "-3"), grey = unreachable, including the destination cross if unreachable. [SOURCE §4, chat] Coloring reflects only what's achievable *this turn*; it recalculates each new turn as skill allowances refresh — grey never means permanently impossible, since resting always restores stamina.

[SOURCE §4, review] **Yellow steps carry no number.** Andrei, reviewing the phase 3 map on 2026-09-23: "Let us remove the numbers showing stamina lost. The color coding already tells the player that it's not free; they can figure out the rest." This drops the "-3" label above; the colours are unchanged. Registered as Q32.

[SOURCE §4] "End Turn" commits the last-shown path; the character walks to the destination or as far as it gets this turn. Players may plan their next move out of turn while others play; clicking "End Turn" then executes it in one click. An unfinished path is saved for the next turn and can still be changed.

[SOURCE §4] A message board lets human players post messages visible to everyone. [OPEN] Its persistence/scope (per-game vs. cross-game, retention) is not specified.

### 7.2 Hotseat mode

[SOURCE §intro, chat] The same computer sequentially shows the game controls for all hotseat participants in turn order. The current player's name and avatar are prominently displayed, and their character is highlighted on the map. Unlike online play, there is **no out-of-turn planning** in hotseat mode — the §7.1 "plan your move while others play" feature does not apply.

[SOURCE §intro, review] **The current player's character blinks until they pick it up, then is highlighted.** Andrei, trying the hotseat game on 2026-09-23: "it is hard to find your character on the map. Can we make it so it blinks when it's your turn, and, once you clicked it to start planning your move, it stops blinking and highlights instead." Registered as Q34.

[SOURCE §5, review] **Either hot seat seat, or both, can be played by the computer (§9).** Andrei, 2026-09-24, asked that phase 5 bring this to the start game panel rather than wait for multiplayer (Q40). Each seat has Human and Computer buttons, both starting on Human; a computer seat has its own thinking time, whole seconds from 1 to 60, starting at §11's 10; its name and figurine are picked as a person's are (Q41). On its turn the line above the buttons reads "<name> is thinking…" over a bar that fills across the thinking time, its figure blinks, and Plan a move, Rest and End turn are hidden until it has moved; the move then plays out like a person's End turn. Its die card closes by itself after 3 seconds: "the computer's die panel closes itself, pressing OK is [not] necessary" (Q42). Since Q51 (§6.1) a hot seat game takes 2 to 5 seats, set up on the same screen as a stored game with its "Play online" switch off.

[SOURCE chat, review] **Each turn starts with the map on the current player's figure.** Andrei, 2026-09-24: "we need to center the map on the current player's figure at the beginning of each turn, both human and AI". The map glides there over about half a second at the zoom it already has, from the first turn on; after an unguarded claim it waits until the claim's notice has faded (Q46).

[SOURCE chat, review] **The map follows a walking figure that nears the edge.** Andrei, 2026-09-24: "as the figures move, if they get out of view, the map should also pan to follow them automatically". Once a walking figure is within a fifth of the view from an edge, the map keeps pace with it, so it never leaves the screen; if someone pans or zooms during the walk, the map stops following for the rest of that walk (Q47).

[SOURCE chat, review] **A Track button says whether the map follows the players on turn.** Andrei, 2026-09-25: "for planning a move we can either be in the "follow the active players" mode, or in "plan your move" mode. can we make these modes explicit, with a 'track' button that is actually a toggle — it unpresses itself when you start panning, zooming and planning, and by pressing it you go back to watching other playerd move". The glide at the start of a turn and the following of a walk happen only while Track is pressed. It sits above the map's "+" (on a phone, in the row with it, Q58) and is filled as Waypoint is when on. Dragging, the wheel, pinching, "+", "−", "Whole map", a player's card (Q120; Find until then), tapping your figure, Plan a move or changing a route unpresses it. Pressing it closes planning, keeping the route drawn and saved for End turn, and glides the map to the figure walking or else the player on turn. It is pressed when a game opens and presses itself at End turn and Rest; on one device it also presses itself at the start of every turn, which keeps hot seat moving the map as before (Q57).

[SOURCE chat, review] **On a phone the play screen keeps the map large.** Andrei, trying online play on his folding phone on 2026-09-25: "one row is definitely the way to go on portrait screens, but shouldn't we change to side buttons in landscape? We should also look for ways to save space on small screens. The log message, for example, can fit to the right of the buttons." On screens narrower than 900 the player cards are one row that scrolls sideways, each a little under half its width and at least 180 wide, and at the start of each turn it slides to the card of the player on turn ("yes, the row should follow the turn, showing the active players card"). A screen at least a third wider than it is tall puts the cards in a 300-wide column down the left instead, with the line and the buttons under them and the map beside. From 560 wide the line sits to the right of the buttons. The game's name and seed share the top bar's first row; on a portrait phone Resign, Your games, Turn log and Messages sit behind one Menu button that carries the unseen message count; and Track, "+", "−" and "Whole map" are a row along the map's bottom right (Q58). The same layout serves a game on one device.

[SOURCE chat, review] **On desktop the Turn log and Messages open over the map beside the cards.** Andrei, 2026-09-29: "Option A looks good on desktop/laptop, let's make it so" and "But then turn log should not be on from the start, because it gets in the way". From 900 wide they open over the map's left edge, beside the player cards, the full height of the game and 360 wide, and close with their own button or the ×; they start closed, and hot seat has its Turn log button there too. A result, a notice or the end of the game shows whole over the open panel's edge (Andrei: "of course the answer for 335 is Card on top") (Q87).

[SOURCE chat, review] **Clicking a player's card finds that player on the map.** Andrei, 2026-09-30: "Please make it so that clicking on a player's card finds this player on the map", and "I don't think we need the "find" button any more". Any card, for any seat, during the game and after it ends: the map jumps to the figure, wherever it is on a walk, and zooms in to playing distance if it is further out; Track unpresses; and for 2 seconds the figure stands on the yellow-edged ring of a figure being planned, except the player on turn's, which already blinks. On a laptop the pointer is a hand over a card. The Find button is gone from every screen, and from the game master's "Bea ▾" list (Q120).

[SOURCE chat, review] **On your own turn a tap on a space plans at once.** Andrei, 2026-10-01: "i don't see why i have to tap my figure at the beginning of every move. everything works if it's already tapped", and "it's good to have the figure blink until there's a route planned. as soon as i click on a node and the route is being planned blinking can stop. if the route is saved from previous planning we can blink for a short while and stop". The figure still blinks at the start of the turn; the first tap on a space, or on another player's figure, picks it up and chooses that space, as tapping the figure and then the space did, and tapping the figure or Plan a move still works. Over a route saved from the turn before it blinks for 2 seconds, then stands still on the gold ring of a route planned. The line above the buttons reads "Bea: tap where to go." Online, planning on someone else's turn still starts with your figure or Plan a move (Q145).

### 7.3 Game master controls

[SOURCE §4] If a player takes too long, the game master can force their currently-planned move (or force a rest, if none was planned). [SOURCE §4, chat] No fixed time threshold — entirely at the game master's discretion.

[SOURCE §4] A human player may resign at any time; an AI takes over so play continues. The game master may switch any player between human and AI control at will. [SOURCE §4, chat] Only the game master can hand control back to a human after a resignation — not self-service by the player.

[SOURCE chat, review] **The game master can also resign a player, end the game on gold and delete a post.** Andrei, 2026-09-29: "i think it's time to implement GM actions: force a player's turn, force a player to resign, extend the game's lifetime, end the game (with victory determined by current gold.) I thonk we also need the ability to delete messages from the message board (for the case when someone starts posting inappropriate content)". Resigning a player works as the player's own resignation, for the player on turn: on another person's turn the game master has one "Bea ▾" button, on every screen, whose list holds Move Bea on and Resign Bea (Find Bea left it with the Find button, Q120). Ending the game gives the win to the most gold, a tie shared, as when time runs out; it replaces the earlier ending with no winner. A deleted post keeps its place, author and time, reads "Deleted by the game master.", and its words are erased from the stored game (Q85).

---

## 8. POI Interaction & Combat Resolution

[SOURCE §2] On arrival at a POI, interaction is automatic. If unguarded, the reward is simply taken. If guarded: roll 1d6; if `roll + relevant skill (fighting or magic, matching the guard's color) > guard_strength`, the reward is taken; otherwise the reward stays on the node and the roll has no other cost. Either outcome ends the turn.

[SOURCE §2, review] **An unguarded POI's result fades by itself; a guard fight's waits for OK.** Andrei, 2026-09-24: "the unguarded poi should produce a card that fades itself. The guarded POI produce a card with a die roll that has an ok button", and "the message for unguarded poi should be simpler, like 'plains speed +2'". Later that night: "can the disappearing card be smaller? i would prefer it if it was floating up from the figure as it lands on the POI". The unguarded notice is a small card that reads only what was taken, as "plains speed +2", rises from the figure's head, stays 2 seconds and fades; a failed roll's card and turn log no longer add that losing costs nothing else, though the rule above is unchanged. Registered as Q38.

[SOURCE §2, chat] Any player may attempt a guarded POI on their turn — not only the one who first failed. A player may leave and return later, or remain stationed on the node. Multiple players may occupy the same node simultaneously, without restriction.

[SOURCE §2] Worked example: stamina 14, plains-move 3, forest-move 1, mountain-move 0, fighting 2, standing on a plains node. Moves 3 plains nodes free, a 4th plains node costs 1 stamina (13 left), then 1 forest node free. Stops on a POI guarded at strength 5 (red). Rolls a 4, +2 fighting = 6 > 5: reward taken, turn ends.

---

## 9. AI Players

[SOURCE §5] Implemented via MCTS.

[SOURCE §5, chat] Rollout/simulation policy: choose a random target among the `CLOSE_CANDIDATE_COUNT` closest POIs, using the same weighted-terrain-cost random-walk code as §5.1.

[SOURCE §5, chat, 2026-09-30] **Closest by the player's own speeds** (Q112). For the computer's own choices (§12.2) and for every player in the games it imagines, a site's distance is `min over n ≥ 1 turns of 5n + stamina(n)`, where `stamina(n)` is the stamina still needed after n turns of free steps: 1 × (plains steps − n × plains speed) + 2 × (forest steps − n × forest speed) + 3 × (mountain steps − n × mountain speed), each part only when above 0, and 5 is `REST_STAMINA_GAIN`. The steps per terrain are counted along the cheapest route by weighted terrain cost, the route its imagined players walk; its real move walks the best route for its speeds (Q210, §7.1). Andrei: "It bothers me that the cached distances always consider mountains inaccessible when in reality by the [end] of the game you can have lots of mountain speed." The remoteness walk (§5.1) keeps weighted terrain cost.

[SOURCE §5, review] Backpropagated value: there are **three kinds of node evaluation**, and the tree-node evaluation function must be easily swappable between them.

| Evaluation | What it reads | Value |
|---|---|---|
| **Simulated** | the rolled-out state | "We simulate random moves until all gold is exhausted" (§9's rollout policy above), then take the simulated player's gold. |
| **Estimated** | the node being evaluated | Current gold plus current skills, with no rollout at all, weighted by how far the game has run. |
| **Hybrid** | both | The average of the estimated value and the simulated one. |

[SOURCE §5, review] **v1 uses the simulated evaluation**; estimated and hybrid are there to experiment with afterwards.

[SOURCE §5, chat, 2026-09-30] **The simulated game is scored by the lead** (Q113). The computer scores each game it imagines by its gold lead over the richest other player when that game ends, `(lead / (|lead| + 1) + 1) / 2`, instead of by its own gold: level is 0.5, one gold ahead 0.75, two ahead 0.83, and the score stays between 0 and 1. Andrei: "let us try (lead/(abs(lead) + 1) +1)/2 , if that makes sense". The imagined games themselves are unchanged.

[SOURCE §5, review] The estimate's weight between gold and skills is not a tuned constant — it moves with the game, because "skills are important at the beginning of the game, and are worthless at the end":

```
value = gold/total_gold × progress + (skills + stamina/5)/total_skills × (1 − progress)
        progress = skill and gold units claimed by all players / (total_skills + total_gold)
```

At the opening almost no gold is claimed, so `progress` ≈ 0 and the skill term carries the value; by the end `progress` ≈ 1 and only gold counts. `skills` is the **sum of the player's skill levels** [SOURCE §5, chat], not a count of the skills they hold. [SOURCE §5, chat, 2026-09-30] Stamina counts with them, 5 stamina (`STAMINA_PER_SKILL_POINT`) as one skill point; `total_skills` is the skill units on the map, and the skill term stops at 1 so the value stays between 0 and 1 (Q110). [SOURCE §5, chat, 2026-09-30] `progress` counts skill units with the gold, "so we have continuous progress from the start" (Q111); it was gold alone.

> This supersedes the earlier form of the experiment, `average(gold after simulation, gold now + (number of skills) × balancing_constant, at the node being evaluated)` [SOURCE §5, chat]. Its two halves became the hybrid and the estimated evaluation respectively, and `balancing_constant` is gone — what it tuned by hand is now `progress`, which the game state supplies.

[SOURCE §5, chat] Time budget per AI move: starting value **10 seconds**.

[SOURCE §5, review] **A simulated player rests when it cannot take a single step** toward its target, then carries on toward it; the computer's real move follows the same rule (Q43).

[SOURCE §5, chat, 2026-10-02] **The computer buys too** (Q190). Andrei: "we'll need new actions to consider from every MCTS node, up to 5 of them. Similar to resting, it seems prudent to introduce some pruning here, e.g. buying a skill is not available to a computer player if that skill is within 1 turn reach from them (cached distances to the skill site less or equal current speed), or 1 turn reach plus some stamina." Every node of the computer's own tree gets a branch for each skill it can pay for, buying one unit and staying in the same turn, so a few buys followed by a move or a rest are one turn. A skill has no buy branch while an unclaimed site offering it can be reached this turn for at most `BUY_SKIP_STAMINA` stamina past the free steps, and no more than the stamina the player holds (759); the steps are counted along the cached cheapest route, as `stamina(1)` above. The players it imagines in its simulated games never buy (760). It thinks once a turn, then plays the buys on its best line as one purchase, then its move (761).

[SOURCE §5, review] **A simulated game also ends after 250 turns.** Andrei, 2026-09-24: "we can end the simulation after 250 turns and give the victory to whatever player has more gold." The turns are counted from the position the computer is thinking about, and a game stopped there is scored like any other, by the gold each player holds. This covers the games the computer plays in its head, not real games (Q44).

> [OPEN] The tree/selection policy (e.g. the exploration-vs-exploitation formula) is unspecified. See §12.

---

## 10. Required Art Assets

[SOURCE §6]
- 7 reward icons (table in §4.1)
- Eye-candy symbols per terrain type (trees, mountains, etc.), isometric
- Terrain textures (all 3 types) + road/path brush pattern
- Per-POI images (huts, mills, wells, etc.) + guardian images for protected POIs (creatures, warriors, mages), isometric
- Character figurine images to choose from at setup
- Die-roll animation
- Visual elements for showing a prospective move (path highlight, cross, waypoint marker)

[SOURCE §6] Rendering: isometric view throughout; non-interactive dressing (eye candy) are billboard sprites pasted onto the map by the engine.

---

## 11. Configuration Parameters

Every constant below must live in a config file/module, not be hard-coded.

| Parameter | Default | Status |
|---|---|---|
| `MAP_NODE_COUNT` | ~240 | fixed target |
| `MAP_EDGE_COUNT` | ~300 | fixed target |
| `MAP_COORDINATE_SPACE` | e.g. 1,000,000 units | arbitrary, implementer's choice |
| `LEAF_COUNT_MIN` / `MAX` | 30 / 45 | fixed |
| `TERRAIN_AREA_SHARE` (plains/forest/mountain) | 45% / 30% / 25% | approximate target, measured on the finished map [SOURCE §2.1, review] |
| `COMPACTNESS_MAX` | 25 | tunable (play-test) |
| `VALLEY_COUNT` | 2–4 | fixed |
| `VALLEY_WIDTH` | 1 node | fixed |
| `VALLEY_LENGTH` | 5–12 nodes | fixed |
| `BORDER_ROAD_PLACES` | 1 | tunable — separate places two touching terrain areas meet, §2.1 step 6b; started at 2, lowered to 1 after Andrei looked at maps (Q105, 398) |
| `BORDER_AREA_MIN_SIZE` | 5 nodes | tunable — smallest area step 6b joins (Q105, 395) |
| `BORDER_ROAD_MAX_LENGTH` | 1.3 × longest kept edge | tunable — step 6b (Q105, 393) |
| `JOINED_PIECE_ROADS` | 1 | tunable — step 6b, pieces of one terrain (Q105, 394) |
| `POI_COUNT` (plains/forest/mountain) | 25 / 20 / 15 | fixed target |
| `GUARD_STRENGTH_MIN` / `MAX` | 2 / 10 | fixed (revisit later) |
| `REMOTENESS_WEIGHT` | 4 | tunable (play-test) — guard/remoteness balance, §5.2 |
| `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` | 2 | tunable (play-test) — reward stacking, §4.3 |
| `REWARD_SWAP_PASSES` | 5 | tunable (play-test) — reward/remoteness agreement, §4.3 step 4 [SOURCE §4.3, review] |
| `FOREST_MAGIC_GUARD_CHANCE` | 1 | tunable — chance each forest gold POI is magic-guarded rather than fighting-guarded, §4.4; 0.5 from Q115, 1 since Q185 |
| `BUY_GOLD_PER_UNIT` | 1 | tunable — the gold one bought unit of a skill costs, §7 (Q190: "1 to 1") |
| `RESPAWN_SHORT_BELOW_SITES` | 2 | tunable — only in games started before buying (Q190, 757); a skill comes back while fewer than this many unclaimed POIs offer it, §4.5 (Q135; asked as 3 units, set by Andrei to 2 sites) |
| `RESPAWN_FAR_SHARE` | 0.5 | tunable — the farthest share of a skill's empty POIs it comes back to, §4.5 (Q135) |
| `RESPAWN_MAX_UNITS` | 1 | tunable — the most units a POI that comes back offers; one that held fewer gets those, §4.5 (Q135, Andrei 2026-10-01: 2, then 1) |
| `CLOSE_CANDIDATE_COUNT` | 10 | tunable — the computer player's K, for §9's rollout and §9's tree |
| `REMOTENESS_CANDIDATE_COUNT` | 10 | tunable — §5.1's walk, while a map is generated (Q66) |
| `REMOTENESS_SIMULATION_RUNS` | 100 | tunable |
| `STAMINA_COST` (plains/forest/mountain) | 1 / 2 / 3 | fixed |
| `REST_STAMINA_GAIN` | 5 | tunable |
| `STARTING_STAMINA_BASE` | 30 | tunable |
| `STARTING_STAMINA_INCREMENT` | 5 | tunable (Q75; was 10) |
| `STARTING_GOLD` | 5 | tunable — the gold every player starts with, §6 (Q200); none in games started before |
| `PLAYER_COUNT_MIN` / `MAX` | 2 / 5 | tunable, not a hard limit |
| `GUARD_DIE` | d6 | fixed |
| `MCTS_TIME_BUDGET_PER_MOVE` | 10 seconds | tunable; per computer seat on the setup screen, 1 to 60 seconds [SOURCE §5, review] |
| `SIMULATION_TURN_CAP` | 250 turns | the most turns one simulated game runs, §9 [SOURCE §5, review] |
| `STAMINA_PER_SKILL_POINT` | 5 | tunable — stamina worth one skill point in §9's estimated evaluation (Q110) |
| `BUY_SKIP_STAMINA` | 5 | tunable — the computer has no buy branch for a skill a site offers within this much stamina past its free steps this turn, capped by the stamina it holds, §9 (Q190, 759) |
| MCTS tree/selection policy, exploration constant | — | **OPEN**, unspecified |

[SOURCE §11, Q160] **The larger map, for 4 and 5 players** (`LARGER_MAP_FROM_PLAYERS` 4): `MAP_NODE_COUNT` ~336, `MAP_EDGE_COUNT` ~420, `LEAF_COUNT_MIN` / `MAX` 42 / 63 and `POI_COUNT` 35 / 28 / 21, each 1.4 × the above (631), with §4.2's larger table. Every other parameter is the same on both maps (633), the valleys included.

---

## 12. Open Items

Genuinely undecided. Do not invent values for these — either design around them as clearly-marked, swappable/config placeholders, or stop and ask, per the implementation prompt's instructions.

1. **Hosting / infrastructure** — the design leaves this open ("Cloudflare's Durable Objects sounds like a good candidate, but there may be others").
2. **MCTS tree/selection policy** — nothing beyond the rollout policy and the default evaluation function (§9) has been specified.
3. **Message board persistence and scope** (per-game vs. cross-game, retention) — not addressed.
4. **What happens if the game master disconnects or is otherwise unavailable mid-game** — the role cannot be transferred (§6.1), and no fallback for GM absence is described.
