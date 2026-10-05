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

[SOURCE §1, chat, Q245] New maps carve no valleys: the forest and the mountains each grow in areas kept apart, and the narrow plains left between two of them take the valleys' place (Andrei, 2026-10-04: "stop making "valleys", because now we are getting them for free").

[SOURCE §1.3, chat] The map's coordinate space has no required real-world scale — players always view it zoomed in. Use any convenient large coordinate space (e.g. 1,000,000 units) and set the initial camera zoom so the whole map is visible on screen at game start.

### 2.1 Generation pipeline

[SOURCE §1.3] Steps run in this exact order, every one drawing from a single seeded PRNG so a map is fully reproducible from `(seed, params)` — needed for debugging, replays, and the balancing harness:

1. **Sample positions** — Poisson-disc sampling over the map rectangle, ~240 points.
2. **Triangulate** — Delaunay triangulation over the points (planar by construction; planarity never needs re-checking).
3. **Prune to budget** — remove edges longest-first, with jitter, down to 300 edges; reject any removal that disconnects the graph or pushes leaf count outside 30–45.
4. **Seed terrain regions** — `TERRAIN_SEEDS` seeds per terrain, 2 each for plains, forest and mountain (Q245); grow by flood fill biased toward nodes with more same-terrain neighbours, until area shares are approximately 45% plains / 30% forest / 25% mountain. A `KEPT_APART` terrain (forest and mountain) never grows into a node that would bring two of its areas within that node's gap of each other on the ground (the triangulation, step 2), here and in the share balancing that finishes steps 4 and 6; every node draws its own gap, 1 to 3 nodes (`GAP`), once per map before the fill (917 D). Plains areas may merge. When the shares cannot be reached any other way, two areas may join (`JOIN_FOR_SHARES`, Q245, 916 A).
5. **Smooth** — flip isolated nodes to their majority-neighbour terrain until `compactness = boundary² / area` falls below `COMPACTNESS_MAX` [SOURCE §1.3, chat: circle reference = 4π ≈ 13; `COMPACTNESS_MAX` starts at 25].
6. **Carve valleys** — convert `VALLEY_COUNT` narrow (1-node-wide) fingers of 5–12 nodes from the plains boundary into neighbouring regions; these nodes are exempted from the Smooth step (there is only the one Smooth pass, above — Carve Valleys runs once, after it). `VALLEY_COUNT` is 0 since Q245, so maps carve none.
6b. **Join borders** [SOURCE §2.1, chat] — put pruned triangulation edges back where two terrain areas of at least `BORDER_AREA_MIN_SIZE` nodes meet in fewer than `BORDER_ROAD_PLACES` separate places (edges sharing a node count as one place): no edge longer than `BORDER_ROAD_MAX_LENGTH` times the longest edge step 3 kept, none that shares a node with a crossing the pair already has, the first one the shortest and each later one the farthest from the pair's existing crossings; an edge that joins a leaf only while at least `LEAF_COUNT_MIN` leaves remain. Two pieces of one terrain that touch in the triangulation but share no edge are joined by `JOINED_PIECE_ROADS` edges the same way. Terrain is unchanged, and every added edge comes from step 2, so the graph stays planar (OPEN_QUESTIONS Q105).
7. **Place POIs** — node selection and reward assignment; see §3 and §4.
8. **Validate** — reject and regenerate the whole map if: disconnected, or leaf count outside 30–45.

> [SOURCE §2.1, review] **The area shares in step 4 are a property of the finished map, not of the draft step 4 hands on.** Carve Valleys converts nodes out of forest and mountain into plains, so measuring the shares before it runs lets the finished map drift a long way from 45 / 30 / 25 — over 40 seeds the finished mountain share ran from 6.4% to 31.0%, and one seed finished 65 / 26 / 9. Step 6 therefore ends by growing whatever terrain is now short back into plains, leaving the carved fingers and the plains node each one opens from untouched. The same growth also finishes step 4, whose flood fill cannot reach the shares on its own: a region on a graph this sparse is routinely sealed off, every neighbouring node already claimed, while it is still far short. Because §4.2 fixes the POI count per terrain, a terrain that loses nodes also crowds its POIs — the skew that made this visible had two thirds of every mountain node carrying a POI.

> [SOURCE §2.1, chat] **Why step 6b.** Step 3 leaves a graph that is nearly a tree and step 4 grows terrain along it, so terrains meet exactly where edges are fewest: over 100 maps 12% had no plains–forest edge at all, and only 77% of forest nodes could be reached from plains without entering mountain. Pruning to more edges instead fails the leaf test (at 330 edges most maps regenerate, at 360 none can be made). With step 6b at `BORDER_ROAD_PLACES` = 1 a map carries ~300–315 edges.

> [SOURCE §2.1, chat, Q245] **Areas kept apart.** Andrei, 2026-10-04: "games get more interesting when there are more than one area of forest and mountains"; "The goal is to have a variety of different maps, with more than one forest in most, but not necessarily all of them". A first build gave plains 2 seeds and forest and mountains 3 each, free to merge (915); after flipping through maps he found "Many second or third components are tiny, not adding much to the map structure" and asked instead to "start with 2 seeds for forest and mountains, and don't let them merge - stop making "valleys", because now we are getting them for free", with "1 space gap should be enough, like what we have for "valleys" width today. We can do 2 seeds for plains but we don't care if they merge or not. This applies to all map sizes" (914 A, 1 node). One gap for the whole map drew the plains between two areas as a straight line, which he found "very ugly": "it's line that separates two forests, straight and clearly artificial" (a 1-node line 5 or more nodes long between two areas of one terrain on 41% of standard maps and 49% of larger ones). Shown 1, 2 or 3 nodes, or a gap drawn per node between 1 and 3, he chose the last, "i really liked how uneven looks" (917 D): each node draws its own gap, so two areas stop 1 node apart in some places and 3 in others and the plains between them winds. Measured over 300 maps per size, counting nodes of one terrain that touch on the ground, 5 or more, as one area (standard map, then larger; with 1 or 2 seeds and valleys in brackets): the forest is in 2 or more areas on 87% and 89% (38%, 31%), the mountains on 89% and 97% (44%, 47%), exactly 2 of each on 75% and 80% (12%, 10%), 3 or more of either on 5% and 7% (13%, 14%); second and third areas have a median of 21 and 27 nodes (16, 19), and a map with a forest or mountain area under 10 nodes besides the largest is 18% and 19% (23%, 19%). The plains are in 2 or more areas on 45% and 57% (31%, 32%). Of the pairs of areas of one terrain, 27% and 29% are 1 node apart at their closest; a 1-node line 5 or more nodes long is left on 2% and 4% of maps. On 9% of maps the shares can only be reached by joining two areas, and there two areas join (916 A, "Allow join"); no map lands 5 or more points off 45 / 30 / 25. Site placement and the start rule (§6) hold; the start is about 7.7 road steps from the forest and mountains on the standard map and 10.0 on the larger one (7.9 and 10.5). Without valleys about 3.5 sites a map (4.0) that sat in valleys are placed elsewhere by the same rules; the site count does not change. Each node's gap is drawn from the map's one PRNG at step 4, after the seeds are placed, and kept on the draft for step 6. The larger map has the same counts (912 A).

> [SOURCE §1.3, chat] Compactness is *not* re-checked at the Validate step: Carve Valleys deliberately reduces compactness along the plains boundary immediately before this step runs, so re-checking it here would fail generation almost every time. Compactness is already enforced inside the Smooth step itself (step 5 loops until it's satisfied).

---

## 3. Points of Interest (POIs)

[SOURCE §1] Some nodes are POIs. A POI has: a reward (§4), optionally a guard (§4.4), and an eye-candy image of the place or — if guarded — of the guardian, with a red (fighting) or purple (magic) contour.

[SOURCE §1, review] **The red or purple goes on the POI's node, not round the guardian's image.** Andrei, reviewing the phase 3 map on 2026-09-23: "the guards should not have red or purple contours; instead, the nodes should." A guarded POI's node keeps the black outline every node has and gains a ring in its guard's colour just outside it ("let's keep the regular black one inside it as well", same day); once the POI is claimed its node is drawn as an ordinary one (§4.5). The image stands beside its node rather than on it, on whichever side covers no road and no other POI. Registered as Q31.

[SOURCE §1, review] **Every image stands right against its node, and a guardian stands on it.** Andrei, the same evening: "let us place POI images closer to the POIs themselves, close to or touching the node. Guards, specifically, can be standing on the node itself, not centered on it but intersecting at the base". An image other than a guardian touches its node's oval, measured on the picture itself rather than its bounding box, without covering it. A guardian stands with its feet on the back part of its node, off the centre, so the front of the node, the guard's colour and the reward in front of it stay in view. Where every spot on its node would cover a neighbouring node or image, it stands beside its node like the others. No dressing ever covers a POI's image: "let's have the POI images always unobscured". This revises the Q31 note above only as far as where the image stands, and is registered as Q35.

[SOURCE §1, review] **Every POI's node has a dot in the middle until the POI is claimed.** Andrei, 2026-09-29: "When I play i often miss a site by one space because the map is a bit crowded. We need to mark sites better." He chose "the dot in the middle", on guarded POIs as well, and "when a site is claimed, the dot needs to disappear"; its size and colour: "The road color and size 0.55 work." The dot is 0.55 of the node's width across, in the main brown of the roads, inside the black outline (and inside a guarded node's ring); whatever covers a node covers it too. Picking a node by tap or click is unchanged. Registered as Q80.

[SOURCE §1] POI placement: distributed randomly at approximately equal distances from each other; every leaf node of the graph must be a POI (no dead ends); leaf nodes are assigned POI status first, remaining POIs distributed randomly among the rest.

[SOURCE §1] POI counts: **25 on plains, 20 in forests, 15 in mountains** (total 60).

[SOURCE §3, chat, Q240] Since the plains have stamina sites (§4.2), **30 on plains** (total 65): the 5 stamina POIs are placed like every other plains POI (900 A).

[SOURCE §3, chat, Q250] Since the rewards moved terrain (§4.2), **32 on plains, 20 in forests, 15 in mountains** (67): each reward kept its sites (920 A), then the forest's stamina grew to 6 POIs and the plains' magic-guarded gold to 5; 45 / 28 / 21 on the larger map.

[SOURCE §3, chat, Q270] Since the forest's stamina went to 4 POIs, **18 in forests** (65): "There will be fewer sites in the forest" (961); 45 / 25 / 21 on the larger map.

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

Three things per kind, all needed by the assignment algorithm in §4.3: the total reward **units** of that kind on the terrain, how many **POIs** on that terrain are dedicated to that kind (these must sum to the terrain's total POI count, since every POI gets exactly one kind, §3), and — for gold specifically — its **guard type**. Where a terrain's gold has more than one guard type (mountain, and plains since Q250), the POI-count and unit-total are further split per guard type, since each guard type is effectively its own sub-kind for the §4.3 algorithm.

[SOURCE §1.1] / [SOURCE §1.1, chat] / [SOURCE §4.2, chat, Q250]

| Terrain | Kind | Guard | Total units | POIs of this kind |
|---|---|---|---|---|
| Plains (32 POIs) | Plains moving skill | none | 20 | 10 |
| | Forest moving skill | none | 15 | 7 |
| | Mountain moving skill (Q250) | none | 15 | 8 |
| | Gold (informally "cities", Andrei's "fortresses") | fighting | 10 | 2 |
| | Gold (Q250, the forest's until then) | magic | 8 | 5 |
| Forest (18 POIs, Q270) | Magic skill (Q250) | none | 10 | 6 |
| | Fighting skill | none | 15 | 8 |
| | Stamina (Q240, Q250, Q260, Q270) | none | 8 | 4 |
| Mountain (15 POIs) | Gold | fighting | 20 | 10 |
| | Gold | magic | 10 | 5 |

[SOURCE §4.2, chat, Q160, Q250] With 4 or 5 players the map is 40% larger (§11's larger map): every row's units are 1.4 × the above (the stamina's 11.2 rounded to 11, Q270), and its POIs 1.4 × rounded to the nearest whole number (630), the stamina's 5.6 to 6: "The 4-5 player map should get 1.4 times as many hearts and sites" (960). So the map has 45 / 25 / 21 POIs by terrain. (From Q250 until Q270 the forest's stamina had 9 POIs rather than 8, so the forest kept its 28, 925 A.)

| Terrain | Kind | Guard | Total units | POIs of this kind |
|---|---|---|---|---|
| Plains (45 POIs) | Plains moving skill | none | 28 | 14 |
| | Forest moving skill | none | 21 | 10 |
| | Mountain moving skill | none | 21 | 11 |
| | Gold | fighting | 14 | 3 |
| | Gold | magic | 11 | 7 |
| Forest (25 POIs) | Magic skill | none | 14 | 8 |
| | Fighting skill | none | 21 | 11 |
| | Stamina (Q270) | none | 11 | 6 |
| Mountain (21 POIs) | Gold | fighting | 28 | 14 |
| | Gold | magic | 14 | 7 |

[SOURCE §4.2, chat, Q250] **The rewards move terrain.** Andrei, 2026-10-04: "we seem to have found a simple super strategy: buy forest speed +4 and go to the forest. We need to change the allocation of resources between terrains", the plains getting the three moving skills, "the gold guarded by magic that used to be in the forest before" and the two fortresses, the forests magic, fighting and stamina, and the mountains staying as they were. The super strategy was measured by the Buying skills thread: a computer seat that bought forest speed +4 on its first turn and headed for the forest won 15 and shared 1 of 24 games from every seat on maps whose forest was one piece, against 8 wins for the same seats playing normally; after the move, on the same maps, it won 8 of 24 against 7 wins and 2 shared (927). Every row kept its units and its POIs and only moved terrain (920 A), and then, the same day: "we can fill forests up to their usual 20 sites, by changing stamina to 6/10. And on plains, gold with magic guards can grow to 5/8". So the forest is back to 20 POIs, the plains have 32 and the map 48 gold; the larger map has 9 stamina POIs with 14 units, which keeps its forest at 28 (925 A), and 7 magic-guarded gold POIs with 11 gold (926 A), so 45 / 28 / 21 POIs and 67 gold. The magic-guarded gold is guarded by §5.2 like all gold (921 A): plains POIs are less remote than forest ones, so over 300 standard maps a 1-unit stack's guard went from 2.2 to 3.0 on average (mostly 3) and a 2-unit stack's from 4.1 to 5.6, and with 8 gold on 5 POIs about one stack in twelve holds 3 gold, guarded 8 on average, where the forest's never held more than 2. Each reward keeps the pictures it had (922 A, §10). Measured over the same maps, in road steps from the start to the nearest POI: magic 5 → 13, stamina 5 → 13, mountain moving skill 12 → 4, the magic-guarded gold 14 → 5; fighting stays 12, plains and forest moving skills 3–4; the start (§6, Q227) finds a plains space under 0.1 on 299 of 300 standard maps (297 before) and on every larger one.

[SOURCE §4.2, chat, Q240] **Stamina sites on the plains** (in the forest since Q250). Andrei, 2026-10-03: "I'd like to add stamina rewarding sites to plains. [...] I am thinking of adding 5 sites, rewarding 10 stamina units total (and each stamina unit adds 5 stamina). [...] Stamina sites follow the same rules any other reward type does." Until then stamina had no row here, and the only stamina on a map came from surplus leaves (§3). The plains' stamina row is placed and filled by the same steps as every other row: its 5 POIs are drawn among the plains' 30 (900 A); they are unguarded, each gets 1 unit and the other 5 lean toward the more remote ones by §4.3, usually 3-2-2-2-1 or 3-3-2-1-1; and each shows one of the 12 pictures of the `Plains_Stamina` sheet, drawn from the seed, so two can share one (901 A), at 0.45 of a road's length, a tenth smaller than the houses' 0.5: "slightly smaller, so a bench or a campfire doesn't look as big as a house" (904 B). The larger map has 7 with 14 units, the usual 1.4 × (902 A). Each unit claimed gives `STAMINA_PER_UNIT` (5) stamina. The map shows one white heart per unit (905 A), and the words players read say the stamina a site gives: "took 10 stamina", "the 10 stamina site (plains)" (906 A). The stamina POIs surplus leaves make (`OVERFLOW_LEAF_STAMINA_UNITS`, 1 unit each) are stamina sites in every way, in any terrain: 5 stamina a unit and the same pictures (903 A). The computer takes them by the same rules; how it thinks does not change. With 5 more plains POIs a seed draws a different map than before.

[SOURCE §4.2, chat, Q260] **More hearts on the stamina sites.** Andrei, 2026-10-05: "Stamina sites with just one heart are not very attractive. I'd like to increase the # of stamina units offered in forests to 12 but I'm afraid its going to be unbalancing. Can you run some simulations with that number and see if computers take them and if that helps them win?" Three computers played 60 standard maps twice at 3 s a move, once with 10 hearts and once with 12, the same maps, seats and dice, the 2 extra hearts added to the same 6 POIs by §4.3. They took 4.0 of 10 hearts a game and 6.6 of 12; the player who took the most hearts won 35% and 36% of the games, where chance alone gives 33%; seat wins, the winner's gold and the game's length stayed within luck. Then: "let's change the total stamina units to 12" (`FOREST_STAMINA_UNITS`), on the same 6 POIs. The larger map has 17 on its 9 (`LARGER_MAP_FOREST_STAMINA_UNITS`, 1.4 × 12 rounded, 940 A). The hearts are spread by §4.3 like every reward (942 A); since the stamina row is drawn before the mountain's, a seed draws its mountain gold differently than before, and 11 of 200 standard seeds (1 of 200 larger ones) draw a different map altogether: their first attempt is rejected as before, and the next starts from a different point of the stream. Measured over 200 maps per size: one-heart POIs per map 2.7 → 1.7, mostly 3-3-2-2-1-1 or 3-2-2-2-2-1, and on the larger map 4.7 → 3.1, mostly 3-3-2-2-2-2-1-1-1; the biggest stack is 6 on either. The rulebook gives no number of hearts and is unchanged.

[SOURCE §4.2, chat, Q270] **Fewer hearts and fewer stamina sites.** Andrei, later on 2026-10-05: "No, 12 stamina hearts in the [forest] make acquiring forest speed unattractive. We need to change that to 8 hearts on 4 sites. Don't worry about old maps, no one is playing yet. Simply update the number." So `FOREST_STAMINA_UNITS` is 8 on 4 POIs, and the larger map has 1.4 × both, 11 on 6 (`LARGER_MAP_FOREST_STAMINA_UNITS`, 960). The 2 POIs that are no longer stamina are gone, not given to another reward: the forest has 18 POIs, 25 on the larger map (961), and every other row is as it was. Measured over 200 maps per size: one-heart POIs per map 1.0, mostly 3-2-2-1 (67%) or 2-2-2-2 (17%), the biggest stack 3 on three maps in four and never over 5; on the larger map 2.0, mostly 3-2-2-2-1-1 (55%), never over 4. A forest dead end beyond the 18, which §3 makes a one-unit stamina POI, came up on 2 of 400 standard maps and 1 of 400 larger ones. The rulebook gives no number of POIs or hearts and is unchanged.

### 4.3 Reward assignment algorithm

[SOURCE §1.3, chat] Run per terrain, per row of the §4.2 table (i.e. per kind, or per kind+guard-type where gold is split by guard type):

1. **Assign kind (and, for gold, guard type) to POIs.** Partition the terrain's POIs into groups sized by the "POIs of this kind" column (e.g. on plains: 10 POIs → plains-movement, 7 → forest-movement, 8 → mountain-movement, 2 → gold/fighting-guarded, 5 → gold/magic-guarded (Q250); all 32 plains POIs accounted for, no overlap. On mountain: 10 POIs → gold/fighting-guarded, 5 → gold/magic-guarded).
1b. **Keep the fortresses apart.** [SOURCE §4.3, chat, Q255] A row with `apart` (in v1 only the plains' gold/fighting row, the fortresses) keeps every pair of its POIs at least `FORTRESS_MIN_ROAD_STEPS` (**12**) road steps apart over any terrain, and at least `FORTRESS_MIN_LINE_SPACES` (**5**) spaces apart in a straight line, one space being the map's median road length. Its POIs are taken in the order step 1 drew them: each one far enough from every one kept before it stays where it is, and one too close swaps places with a POI of another row of the same terrain, drawn at random among those far enough from every one kept, which takes the place it leaves. Every row keeps its POI count, and a map whose fortresses were drawn far enough apart is left exactly as it was. The draw comes from a stream of its own, forked from the map's by the row, so the map's one stream (§2.1) runs on as if nothing had moved and only the swapped POIs and the units of their two rows come out different. With no POI far enough left the attempt is rejected and §2.1 draws another (`sites_apart_unreachable`).
2. **Give every POI 1 guaranteed unit** of its assigned kind.
3. **Distribute the remaining units** of that row's total (total units − POIs of this kind, from §4.2) one at a time, to a randomly chosen POI within the same group, weighted so each POI's chance is inversely proportional to `(its current count of this type − (remoteness − 1) × REMOTENESS_WEIGHT_FOR_DISTRIBUTION)`. Default `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` = **2** (distinct from `REMOTENESS_WEIGHT` in §5.2) — intentionally: weight decreases as a POI's own count grows, and increases the more remote the POI is, so extra units gravitate toward remote, lightly-stacked POIs.
4. **Swap pairs toward remoteness.** [SOURCE §4.3, review] Draw `REWARD_SWAP_PASSES × (POIs in the row)` pairs of POIs from within the same group, and swap the two POIs' unit counts whenever the larger stack is sitting on the less remote of the two. Default `REWARD_SWAP_PASSES` = **5**. This is a repair pass, not a sort: it is not run to completion, and the map keeps the variety a full ordering would take out.

Since remoteness ∈ [0,1], `(remoteness − 1) ∈ [−1, 0]`, so step 3's denominator is always `current_count + (1 − remoteness) × REMOTENESS_WEIGHT_FOR_DISTRIBUTION` — current_count (≥1, from the guaranteed baseline) plus a non-negative term. It's always ≥ 1, for any non-negative value of `REMOTENESS_WEIGHT_FOR_DISTRIBUTION`, so the earlier non-positive-denominator problem no longer applies at all, regardless of how that constant is tuned later.

[SOURCE §4.3, review] Why step 4 exists. Step 3's weighting leans the right way but only weakly — measured over 200 generated maps, the bigger of two stacks in the same row was the more remote one **57.1%** of the time, and raising `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` saturates near 65% however far it is pushed, because step 3 is a *random draw* and §4.2 hands most rows barely more spare units than POIs (plains movement: 20 units over 10 POIs). Andrei's ruling: "we can distribute rewards without much regard for remoteness, and then for a number of times consider pairs of POIs with the same type of reward and swap their rewards if they do not correlate with their remoteness — we don't have to do complete ordering", with **90%** named as a satisfactory level of agreement. Measured, same 200 maps: 2 passes → 86.8%, **3 passes → 91.8%**, 5 → 96.3%, 10 → 99.3%. Three passes clears 90% across a batch; five clears it on all but one map in 200 read one at a time, which is why the default is 5. A swap exchanges two stacks inside one row, so every §4.2 total, every row's POI count and step 2's guaranteed unit all survive it untouched.

[SOURCE §4.3, chat, Q255] Why step 1b exists. Andrei, 2026-10-04: "I'd like to make sure that two large gold prises guarded by combat on plains are well separated from each other", and of a map with the two side by side, "Well, i certainly don't want THIS". Step 1 put the fortresses on any of the plains POIs: measured over 200 maps a size, the two were closer than 12 road steps on 30% of standard maps, and the closest two of the three closer than 12 on 66% of larger maps. Road steps alone would not do (930 B): where the roads wind, two POIs 12 or more road steps apart can still sit within 3 spaces of each other on the map (1% of standard maps, 5% of larger), so the straight line counts too. 12 steps (931); on the larger map every pair of the three, by the same numbers (932 A). Measured with the rule, 200 maps a size: a fortress moves on 33% of standard maps and 70% of larger ones, and there a median 3 and 4 POIs come out different (at most 7 and 13); the closest two are now a median 18 road steps and 10.7 spaces apart on the standard map (16 and 8.7 before) and 15 and 8.7 on the larger (10 and 5.6), none under 12 or 5; no map had to be drawn again; and the fortresses' guards are as before, 10 on 94% and 85% of them. The rule moves no POI and changes no POI's remoteness, only which POIs the fortresses are on; theirs averages a little higher (0.19 → 0.21 on the standard map, 0.17 → 0.19 on the larger), and their gold and guards come from steps 2–4 and §5.2 as before.

### 4.4 Guards

[SOURCE §1] A reward may (not must) be guarded: shown as a red number (fighting-gated) or purple number (magic-gated) beside the node, indicating guard strength, range **2–10**.

[SOURCE §1.1, chat] In v1, only gold rewards are guarded — every gold POI on every terrain is guarded, none are exempt. Guard type by terrain (per §4.2): plains' 2 gold POIs are all fighting-guarded; mountain's 15 gold POIs split 10 fighting-guarded / 5 magic-guarded. [Q250] Since the rewards moved, the plains' 7 gold POIs split 2 fighting-guarded (the fortresses) / 5 magic-guarded, and the forest has no gold. The engine should not hard-code "gold only" — guarding should work on any reward kind — this is a v1 content choice, not an engine constraint.

[SOURCE §4.4, chat] Forest gold was guarded by magic by chance: a coin flip for each POI from 2026-09-30 (Q115), always from 2026-10-01 (Q185). Since the rewards moved (Q250) the forest holds no gold, and the plains' magic gold has its own row, guarded by magic outright; the chance setting was removed on 2026-10-05 (953). Its decisions stay in docs/OPEN_QUESTIONS.md.

### 4.5 Consumption

[SOURCE §2] A POI's reward is consumed once claimed; the node then behaves like an ordinary node of its terrain type for the rest of the game.

[SOURCE §4.5, chat] **Speeds and skills came back** (Q135) to empty sites while they ran short, from 30 September until buying replaced it (§7, Q190, 757); the rule was removed on 2026-10-05 with the games that still used it (952). Its decisions stay in docs/OPEN_QUESTIONS.md.

[SOURCE §2, review] **A claimed POI's image does not change.** Andrei, 2026-09-23: "The claimed POIs should lose their icons, but the images DO NOT CHANGE." Its reward icons, guard strength and guard ring go; its picture stays exactly as it was. Registered as Q36.

---

## 5. Balancing

[SOURCE §1.2] Reward difficulty balances guard strength against remoteness.

### 5.1 Remoteness

[SOURCE §1.2] Computed via simulated random walks: start at a random plains position, repeatedly move to one of the `REMOTENESS_CANDIDATE_COUNT` closest unvisited POIs (chosen at random among them), until every POI has been visited once per walk. Distance for "closest" and for walk-segment lengths uses the same weighted terrain cost as movement: 1 plains / 2 forest / 3 mountain per step [SOURCE §1.2, chat: the one distance metric used throughout the design — also for the UI's shortest-path display, §7, and the AI's own POI targeting, §9]. [2026-09-30, Q112] The AI still walks these cheapest routes, but ranks the sites at their ends by its own speeds (§9). [2026-10-02, Q210] The route drawn for a person and the route a computer's real move walks are the best for the player's speeds instead (§7.1), and so are the routes its search's own choices count (stage 2, §9) and the routes the players in the games it imagines walk (stage 3, §9); those players still rank sites along these cheapest routes. Run `REMOTENESS_SIMULATION_RUNS` walks, normalize the resulting per-POI scores to **[0, 1]**.

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

[SOURCE §2, chat] **Every player starts with `STARTING_GOLD` (5) gold, the same for every seat.** Andrei, 2026-10-02: "Now that players can buy skills for gold, it makes sense to starts them with 5 gold to enable a variety of strategies" (Q200). The New game screen's seat line still names only the starting stamina, which is what differs between seats (792). Nothing that decides the winner moves: the win check compares a lead with the gold left on the map, and 5 each changes no lead.

[SOURCE §6, chat] **The figures start on the deepest plains space whose sites nearby are not remote** (Q227). Andrei, 2026-10-03, worried about big forest speed or magic stacks near the start, measured several ways of starting away from the forest and mountains, and settled on: "change the starting place to go to the deepest plains space with remoteness less than 0.1. We don't need any changes in how remoteness is calculated". A space's remoteness is the average remoteness (§5.1) of the sites, of every terrain, within `START_NEARBY_STEPS` (5) road steps of it (876, 878): "since we're looking for a forest speed site 3+ within 5 steps". How deep a space is counts road steps to the nearest forest or mountain space, one per road whatever the terrain (878). Of the plains spaces that are not sites, the start is the deepest whose remoteness is below `START_MAX_REMOTENESS` (0.1, "please make 0.1 a config setting"); of equally deep ones, the least remote (873); and with none below it, the least remote space (874), which none of 400 maps measured needed. Measured on 200 maps per size, the start is typically 8 road steps deep on the standard map and 10 on the larger one, against 5 and 6 when drawn at random, and a forest speed stack of 3 or more lies within 5 steps of it on 10% of standard maps and 8% of larger ones, against 22% and 19%. The rulebook says only "a plains space that is not a site" (875).

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

[SOURCE §2, chat, 2026-10-02] **Buying speeds and skills** (Q190). Andrei: "Players complain that if they didn't get the right skill early on they are screwed for the rest of the game. I have the following idea: allow players buy skills for gold, 1 to 1. We won't need respawning skills then, this mechanism substitutes that." On their own turn, before moving or resting, a player may buy any number of units of the five skills (the three moving skills, fighting, magic), never stamina or gold, for `BUY_GOLD_PER_UNIT` gold a unit (751, 753, 754). A moving skill bought gives its free step this turn too (752). Nothing bought can be sold back (755). The gold leaves the game, and a purchase runs the win check: if spending it puts another player's lead past all the gold left on the map, that player wins at once (756). A purchase is not a turn; the turn goes on. Speeds and skills no longer come back (757, §4.5).

The Buy button on the card of the player on turn opens the buy panel over the map: next to the card, level with its top, where the cards stand beside the map, and across the top of the map on an upright phone (750 as changed by Andrei on 2026-10-02, "a separate buy panel in all cases, and a cancel option on it. This way, if you misclick, you can always cancel"; 770). Each skill's + adds one unit to the panel only: the tile's number goes up, with the units added in blue beside it, and "Your gold" by Done counts down. Done buys them all as one purchase and Cancel puts everything back; only those two close the panel; a + greys out once the gold left would not pay for another unit; there is no −; Rest and End turn are greyed while the panel is open (766, 768). Each Done is one turn log line, such as "Bea bought 1 mountains speed and 1 combat for 2 gold." (769); a purchase that ends the game has an entry of its own headed "Bought, and the game ended" (772). Other players see a purchase as it happens (Andrei, 2026-10-02: "Basically the purchase notice works the same way as claiming a reward, but happens before the walk, not after"; 773-786, replacing 762's log line alone): a notice floats up from the buyer's figure for each speed or skill bought, such as "Bought magic +2", with units of a skill counted together, one after another in the cards' order, each with the claim notice's timing and with the cash register Andrei supplied. Online every page but the buyer's shows it; on one device, only a computer's purchases. The buyer hears the cash register as they press Done, without a notice. A computer's walk waits until its last purchase notice has faded, and so does the end of the game when a purchase ended it. Like a claim's, the notice is missed when the buyer's figure is out of view. Purchases caught up online, or already in the log when a game opens, have neither notice nor sound. Online, a Done that arrives after the turn has ended buys nothing, and the player is told "Your turn ended before the purchase arrived, so nothing was bought." (771). Sideways phones have the Buy button too (763), and on an upright phone the card's "Turn N ·" and "Playing now" stand on two lines, clear of it (764). The computer thinks once a turn, then makes its purchases as one and plays its move (761; §9).

### 7.1 Online UI

[SOURCE §4] Click-drag to pan, `+`/`-` to zoom. Clicking the player's own highlighted character enters moving mode; clicking a destination node highlights the shortest path (weighted terrain cost, §5.1) with a thick dotted line and an isometric cross at the destination. Shift-click sets an intermediate waypoint when more than one path exists.

[SOURCE §4, chat, 2026-10-02] **The route drawn is the best for the player's speeds** (Q210). Andrei: "it bothers me that the game shows to me the path that is not optimal based on my current skills. How hard is it to make the players, including computer players, take the optimal path by default". The route highlighted, and the route a computer's real move walks, is the one with the least effective distance for the player's speeds: the least over n ≥ 1 turns of 5n + the stamina still needed after n turns of free steps, the Q112 formula of §9 applied to the route's own steps per terrain (810 A). Only routes that no other route beats on all three terrains' step counts can be best, so those are what the search keeps (`RouteTable.routesFrom`). A route only as good as the cheapest by weighted terrain cost leaves that one drawn, and among routes equally good the cheaper by weighted terrain cost wins, so a player with no speeds sees exactly the route they did (811 A). With a waypoint, each leg is the best on its own (812 A). Buying a speed picks the route shown again for the new speeds, a waypoint still ahead kept, as choosing its destination again would (813 A); a route brought back from the turn before stays down when that happens, so Track stays as it was, and online the new route is saved (818 B). Games under way get it too, no rule having changed (815 A). The rulebook says only that the game draws the route it thinks is best (816). Andrei set three stages for the computer: its real moves first (this), then the choices its search weighs (stage 2, §9), then the games it imagines (stage 3, §9).

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

[SOURCE chat, review] **A Track button says whether the map follows the players on turn.** Andrei, 2026-09-25: "for planning a move we can either be in the "follow the active players" mode, or in "plan your move" mode. can we make these modes explicit, with a 'track' button that is actually a toggle — it unpresses itself when you start panning, zooming and planning, and by pressing it you go back to watching other playerd move". The glide at the start of a turn and the following of a walk happen only while Track is pressed. It sits above the map's "+" (on a phone, in the row with it, Q58) and is filled as Waypoint is when on. Dragging, the wheel, pinching, "+", "−", "Whole map", a player's card (Q120; Find until then), tapping your figure, Plan a move or changing a route unpresses it. Pressing it closes planning, keeping the route drawn and saved for End turn (on one device, and online until the route is saved, a purchase leaves it as it is, Q210 819 A), and glides the map to the figure walking or else the player on turn. It is pressed when a game opens and presses itself at End turn and Rest; on one device it also presses itself at the start of every turn, which keeps hot seat moving the map as before (Q57).

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

[SOURCE §5, chat, 2026-09-30] **Closest by the player's own speeds** (Q112). For the computer's own choices (§12.2) and for every player in the games it imagines, a site's distance is `min over n ≥ 1 turns of 5n + stamina(n)`, where `stamina(n)` is the stamina still needed after n turns of free steps: 1 × (plains steps − n × plains speed) + 2 × (forest steps − n × forest speed) + 3 × (mountain steps − n × mountain speed), each part only when above 0, and 5 is `REST_STAMINA_GAIN`. The steps per terrain are counted along the cheapest route by weighted terrain cost; its real move walks the best route for its speeds (Q210, §7.1). [2026-10-02, Q210 stage 2] Its search's own choices count the best route's steps instead: which sites are choices, whether a site is reached this turn (the walk arrives exactly when the player holds the stamina beyond this turn's free steps, so no route is traced), which purchases are skipped, and its own walk to a choice (820 A). [2026-10-02, Q210 stage 3] The players in the games it imagines still rank sites along the cheapest route (822 B), but walk the best route for their speeds. Andrei's plan was to work out a player's arrival from the steps per terrain alone and trace its route only when another player claims its site first; but on a turn that ends short, the order of the terrain decides where the walk stops, so the totals gave a different arrival in 10% to 27% of trips, and tracing a route costs about as much as counting it. So the route is traced once when the player picks its site, and each turn is counted along it by §7's rules, the figure placed where the count ends without the turn being replayed step by step (823 A); a turn that ends on an unclaimed site on the way still fights or takes it. Counted along the cheapest route this is exactly the game the rules would play. Andrei: "It bothers me that the cached distances always consider mountains inaccessible when in reality by the [end] of the game you can have lots of mountain speed." The remoteness walk (§5.1) keeps weighted terrain cost.

[SOURCE chat, 2026-10-03] **The route lists are worked out while the game is set up** (Q235). The best routes from a space to every other (`RouteTable.routesFrom`) are worked out once a game, the first time a route starts there, and a computer's first moves asked for nearly all of them, on the larger map spending most of the first move's thinking time on it. Andrei: "There's plenty of time when the game is being set up, but the map and the starting place are already established." So the page that thinks for the computers, the hot seat page or online the game master's, works every space's list out in the background from the moment setup has the map and a computer seat, nearest the starting place first (890 A); online, a seat nobody holds counts as one, since the computer plays it if the game starts that way (895 A). If the game starts before they are all done, or a game is opened part way through, it carries on between the computer's moves, nearest the figures first, and while the computer thinks it works out what it still needs, as before (891 A). Nothing on screen shows it (893 A), and phones do the same (894 A). The games computers play against each other in the balancing harness work out every list before their first move (892 A). No rule changes: the computer only keeps more of its thinking time for imagining games. Andrei also pointed out that a space's list could reuse the routes through a neighbouring space already worked out; that is not built.

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

[SOURCE §5, chat, 2026-10-02] **The computer buys too** (Q190). Andrei: "we'll need new actions to consider from every MCTS node, up to 5 of them. Similar to resting, it seems prudent to introduce some pruning here, e.g. buying a skill is not available to a computer player if that skill is within 1 turn reach from them (cached distances to the skill site less or equal current speed), or 1 turn reach plus some stamina." Every node of the computer's own tree gets a branch for each skill it can pay for, buying one unit and staying in the same turn, so a few buys followed by a move or a rest are one turn. A skill has no buy branch while an unclaimed site offering it can be reached this turn for at most `BUY_SKIP_STAMINA` stamina past the free steps, and no more than the stamina the player holds (759); the steps are counted along the cached cheapest route, as `stamina(1)` above, and since Q210's stage 2 along the best route for its speeds. The players it imagines in its simulated games never buy (760). It thinks once a turn, then plays the buys on its best line as one purchase, then its move (761).

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

[SOURCE §10, chat, Q250] When the rewards moved terrain, each kept its pictures (922 A): the mountain moving skill's forts and the magic-guarded gold's guardians stand on the plains, the magic skill's houses and the stamina pictures in the forest. `Art/manifest.json` names them in rows of their own with a `borrowed` note.

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
| `VALLEY_COUNT` | 0 | fixed — none since Q245, the forest's and mountains' kept-apart areas take the valleys' place |
| `VALLEY_WIDTH` | 1 node | fixed |
| `VALLEY_LENGTH` | 5–12 nodes | fixed |
| `BORDER_ROAD_PLACES` | 1 | tunable — separate places two touching terrain areas meet, §2.1 step 6b; started at 2, lowered to 1 after Andrei looked at maps (Q105, 398) |
| `BORDER_AREA_MIN_SIZE` | 5 nodes | tunable — smallest area step 6b joins (Q105, 395) |
| `BORDER_ROAD_MAX_LENGTH` | 1.3 × longest kept edge | tunable — step 6b (Q105, 393) |
| `JOINED_PIECE_ROADS` | 1 | tunable — step 6b, pieces of one terrain (Q105, 394) |
| `TERRAIN_SEEDS` (plains/forest/mountain) | 2 / 2 / 2 | tunable — seeds each terrain grows from, §2.1 step 4, drawn per map between a min and a max (Q245) |
| `KEPT_APART` | forest, mountain; `GAP` 1–3 nodes, drawn per node; `JOIN_FOR_SHARES` on (916 A) | tunable — terrains whose areas never grow within a node's gap of each other on the ground, §2.1 step 4 (Q245, 914, 917 D); `JOIN_FOR_SHARES` lets two join only when the shares need it |
| `POI_COUNT` (plains/forest/mountain) | 32 / 18 / 15 | fixed target; plains 25 until its 5 stamina POIs (Q240), then 30 / 20 / 15 until the rewards moved terrain (Q250), then 32 / 20 / 15 until the forest's stamina went to 4 POIs (Q270) |
| `GUARD_STRENGTH_MIN` / `MAX` | 2 / 10 | fixed (revisit later) |
| `REMOTENESS_WEIGHT` | 4 | tunable (play-test) — guard/remoteness balance, §5.2 |
| `REMOTENESS_WEIGHT_FOR_DISTRIBUTION` | 2 | tunable (play-test) — reward stacking, §4.3 |
| `REWARD_SWAP_PASSES` | 5 | tunable (play-test) — reward/remoteness agreement, §4.3 step 4 [SOURCE §4.3, review] |
| `FORTRESS_MIN_ROAD_STEPS` | 12 | tunable — the fewest road steps between any two of the plains' fortresses, over any terrain, §4.3 step 1b (Q255, 931) |
| `FORTRESS_MIN_LINE_SPACES` | 5 | tunable — the fewest spaces between any two of the plains' fortresses in a straight line, one space the map's median road length, §4.3 step 1b (Q255, 930 B) |
| `FOREST_STAMINA_UNITS` | 8 | tunable — the hearts on the forest's 4 stamina POIs, §4.2 (Q260, Q270) |
| `LARGER_MAP_FOREST_STAMINA_UNITS` | 11 | tunable — the same on the larger map's 6, §4.2 (Q270, 960) |
| `BUY_GOLD_PER_UNIT` | 1 | tunable — the gold one bought unit of a skill costs, §7 (Q190: "1 to 1") |
| `CLOSE_CANDIDATE_COUNT` | 10 | tunable — the computer player's K, for §9's rollout and §9's tree |
| `REMOTENESS_CANDIDATE_COUNT` | 10 | tunable — §5.1's walk, while a map is generated (Q66) |
| `REMOTENESS_SIMULATION_RUNS` | 100 | tunable |
| `STAMINA_COST` (plains/forest/mountain) | 1 / 2 / 3 | fixed |
| `REST_STAMINA_GAIN` | 5 | tunable |
| `STAMINA_PER_UNIT` | 5 | tunable — the stamina one unit of a stamina reward gives when claimed, §4.2 (Q240) |
| `STARTING_STAMINA_BASE` | 30 | tunable |
| `STARTING_STAMINA_INCREMENT` | 5 | tunable (Q75; was 10) |
| `STARTING_GOLD` | 5 | tunable — the gold every player starts with, §6 (Q200) |
| `START_NEARBY_STEPS` | 5 | tunable — the road steps within which a space's sites are averaged into its remoteness, for the start, §6 (Q227, 876) |
| `START_MAX_REMOTENESS` | 0.1 | tunable — the start is the deepest plains space whose remoteness is below this, §6 (Q227) |
| `PLAYER_COUNT_MIN` / `MAX` | 2 / 5 | tunable, not a hard limit |
| `GUARD_DIE` | d6 | fixed |
| `MCTS_TIME_BUDGET_PER_MOVE` | 10 seconds | tunable; per computer seat on the setup screen, 1 to 60 seconds [SOURCE §5, review] |
| `SIMULATION_TURN_CAP` | 250 turns | the most turns one simulated game runs, §9 [SOURCE §5, review] |
| `STAMINA_PER_SKILL_POINT` | 5 | tunable — stamina worth one skill point in §9's estimated evaluation (Q110) |
| `BUY_SKIP_STAMINA` | 5 | tunable — the computer has no buy branch for a skill a site offers within this much stamina past its free steps this turn, capped by the stamina it holds, §9 (Q190, 759) |
| MCTS tree/selection policy, exploration constant | — | **OPEN**, unspecified |

[SOURCE §11, Q160] **The larger map, for 4 and 5 players** (`LARGER_MAP_FROM_PLAYERS` 4): `MAP_NODE_COUNT` ~336, `MAP_EDGE_COUNT` ~420, `LEAF_COUNT_MIN` / `MAX` 42 / 63 and `POI_COUNT` 45 / 25 / 21 (45 / 28 / 21 before Q270, 42 / 28 / 21 before the rewards moved, Q250; plains 35 before Q240's 7 stamina POIs), each 1.4 × the above (631), with §4.2's larger table. Every other parameter is the same on both maps (633), the valleys included.

---

## 12. Open Items

Genuinely undecided. Do not invent values for these — either design around them as clearly-marked, swappable/config placeholders, or stop and ask, per the implementation prompt's instructions.

1. **Hosting / infrastructure** — the design leaves this open ("Cloudflare's Durable Objects sounds like a good candidate, but there may be others").
2. **MCTS tree/selection policy** — nothing beyond the rollout policy and the default evaluation function (§9) has been specified.
3. **Message board persistence and scope** (per-game vs. cross-game, retention) — not addressed.
4. **What happens if the game master disconnects or is otherwise unavailable mid-game** — the role cannot be transferred (§6.1), and no fallback for GM absence is described.
