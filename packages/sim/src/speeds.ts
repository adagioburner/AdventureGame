import type { PerTerrain } from '@adventure/config';
import {
  bestRouteSteps,
  effectiveDistanceFor,
  refreshAllowance,
  routeTable,
  type GameMap,
  type GameState,
  type NodeId,
  type PlayerState,
  type PlayerStats,
  type Poi,
} from '@adventure/core';
import type { PoiCandidate } from './candidates.ts';

/**
 * How far the computer player counts a site, by its own speeds (Q112).
 *
 * The one cost per step (§1.2) still finds the routes counted here: the
 * cheapest by weighted terrain cost. What changed is how the computer ranks
 * the sites at the ends of those routes. The remoteness walk (§5.1) still
 * ranks by weighted terrain cost alone. A person's drawn route and the
 * computer's real move walk the best route for the player's speeds instead
 * (Q210, `bestRoute`), and the computer's search counts it too
 * (`closestByBestRoute`, stage 2); its imagined players walk it (stage 3)
 * but still rank by `closestBySpeeds` (822 B).
 */

/** The `count` POIs of `eligible` that `player` counts as closest, nearest first. */
export type ClosestFinder = (
  state: GameState,
  player: PlayerState,
  eligible: ReadonlySet<NodeId>,
  count: number,
) => readonly PoiCandidate[];

/** The Q65 formula, which now lives beside the best route it also picks (Q210). */
export { effectiveDistance } from '@adventure/core';

/**
 * [SOURCE §9, chat] Andrei, 2026-09-30 (Q112): "recalculating distances based
 * on current skills using the cached numbers. It bothers me that the cached
 * distances always consider mountains inaccessible when in reality by the [end]
 * of the game you can have lots of mountain speed."
 *
 * Each POI's `effectiveDistance`, from the steps per terrain along the
 * cheapest route (422 A: that route only), with the player's speeds now.
 * Every player in the games the computer imagines ranks by it (424 A; Q210,
 * 822 B), its own choices by `closestByBestRoute` since Q210's stage 2. Equal
 * distances keep the weighted-terrain-cost order, then node id. `cost` stays
 * the weighted terrain cost.
 *
 * The map's sites are ranked once per space and speeds and the order kept
 * (`siteOrderBySpeeds`); a call walks it until it has `count` of `eligible`.
 */
export function closestBySpeeds(
  state: GameState,
  player: PlayerState,
  eligible: ReadonlySet<NodeId>,
  count: number,
): readonly PoiCandidate[] {
  if (count <= 0 || eligible.size === 0) return [];
  return nearestOf(state.map, player.position, eligible, count, siteOrderBySpeeds(state.map, player.position, player.stats));
}

/** Steps per terrain along the route `player` counts to `target`; `null` where no route reaches. */
export type RouteStepsFinder = (state: GameState, player: PlayerState, target: NodeId) => PerTerrain<number> | null;

/** Along the cheapest route by weighted terrain cost, from the map's cache (Q112). */
export const cheapestRouteSteps: RouteStepsFinder = (state, player, target) => {
  const steps = routeTable(state.map.graph, state.map.ruleset.config).stepsFrom(player.position);
  const plains = steps.plains[target] as number;
  if (!Number.isFinite(plains)) return null;
  return { plains, forest: steps.forest[target] as number, mountain: steps.mountain[target] as number };
};

/** [Q210, 820 A] Along the best route for the player's speeds, from the cached counts (`bestRouteSteps`). */
export const bestRouteStepsFor: RouteStepsFinder = (state, player, target) =>
  bestRouteSteps(state.map.graph, player.position, target, player.stats, state.map.ruleset.config)?.steps ?? null;

/**
 * [Q210] Stage 2 of Andrei's plan, 2026-10-02: "Build MCTS nodes with the
 * most efficient paths, but leave the simulated games as they are"; 820 A:
 * the first three of the search's uses "don't need the path, and can use the
 * distance provided by the formula".
 *
 * `closestBySpeeds` with each site's `effectiveDistance` along the best route
 * for the player's speeds, from the cached counts of every route kept to it,
 * instead of along the cheapest one. Equal distances keep the
 * weighted-terrain-cost order, then node id; `cost` stays the cheapest
 * route's weighted terrain cost. The computer's search ranks its choices by
 * it; its imagined games still rank by `closestBySpeeds`. Its order of the
 * sites is kept per space and speeds too (`alongBestRoute`).
 */
export function closestByBestRoute(
  state: GameState,
  player: PlayerState,
  eligible: ReadonlySet<NodeId>,
  count: number,
): readonly PoiCandidate[] {
  if (count <= 0 || eligible.size === 0) return [];
  return nearestOf(state.map, player.position, eligible, count, siteOrder(alongBestRoute, state.map, player.position, player.stats));
}

/**
 * The first `count` sites of `eligible` in `run`'s order, which holds the
 * map's sites nearest first (`siteOrder`). `eligible` holds sites, as both
 * finders' contract says; a space that is no site is not ranked.
 */
function nearestOf(map: GameMap, from: NodeId, eligible: ReadonlySet<NodeId>, count: number, run: SiteRun): PoiCandidate[] {
  const costs = routeTable(map.graph, map.ruleset.config).from(from).costs;
  const pois = map.pois;
  const { order, end } = run;
  const found: PoiCandidate[] = [];
  for (let at = run.start; at < end && found.length < count; at++) {
    const node = (pois[order[at] as number] as Poi).node;
    if (eligible.has(node)) found.push({ node, cost: costs[node] as number });
  }
  return found;
}

/**
 * The map's sites in the order `closestBySpeeds` ranks them from `from` for
 * `stats`' speeds: `order[start]` up to `order[end]` are indices into
 * `map.pois`, nearest first by `effectiveDistance` along the cheapest route,
 * then by weighted terrain cost, then by node id; a site no route reaches is
 * left out. Ranked once and kept per space and speeds (`siteOrder`): the
 * players in the games the computer imagines pick a site tens of thousands
 * of times a move, mostly from the same spaces at the same speeds, and
 * walking the order to the first few sites they may head for costs next to
 * nothing. The run is read before the store is asked again, as it is one
 * the store reuses.
 */
export function siteOrderBySpeeds(map: GameMap, from: NodeId, stats: PlayerStats): SiteRun {
  return siteOrder(alongCheapestRoute, map, from, stats);
}

/** Where a ranking of the map's sites stands in a store's slab (`siteOrderBySpeeds`). */
export interface SiteRun {
  readonly order: SiteSlab;
  readonly start: number;
  readonly end: number;
}

/** Rankings of sites as indices into `map.pois`, one after another; a byte an entry on a map of up to 255 sites. */
type SiteSlab = Uint8Array | Uint16Array;

/**
 * One way of measuring how far every site of a map is from a space for a
 * player's speeds, and the orders it gave, kept per map, by space and then
 * by speeds (`speedsKey`), in two rounds of up to `rows` rankings each, a
 * few MB. When a round fills, the one before it is emptied and begun again,
 * so the orders asked for lately stay while the rest make room.
 */
interface SiteMeasure {
  /** Writes each site's distance into `distances`, indexed as `map.pois` is; `Infinity` where no route reaches. */
  measure(map: GameMap, from: NodeId, stats: PlayerStats, distances: Float64Array): void;
  readonly rows: number;
  readonly known: WeakMap<GameMap, SiteStore>;
  /** The map asked about last and its store, spared the lookup. */
  lastMap: GameMap | null;
  lastStore: SiteStore | null;
}

interface SiteStore {
  /** This round's rankings, by space and then by `speedsKey`, as where each starts in the round's slab. */
  current: SiteRound;
  /** The round before, read when this one has no ranking, and emptied for reuse when this one fills. */
  previous: SiteRound;
  /** The run handed out, pointed at the ranking asked for last. */
  readonly run: { order: SiteSlab; start: number; end: number };
  /** Scratch for ranking: each site's distance, the sites after the first of two passes of ordering, and the counts of a pass. */
  readonly distances: Float64Array;
  readonly pass: Uint16Array;
  readonly counts: Uint16Array;
  /** The order of a player whose speeds are not kept (`speedsKey`), ranked afresh each time. */
  readonly unkept: Uint16Array;
  /** Each space's reachable sites by weighted terrain cost, then node id (`sitesByCost`). */
  readonly byCost: (Uint16Array | undefined)[];
}

/**
 * A round's rankings, each `stride` entries of one slab (a typed array of
 * its own would cost more to make than the ranking it holds): how many sites
 * it ranks, then those sites nearest first.
 */
interface SiteRound {
  readonly bySpace: (Map<number, number> | undefined)[];
  readonly slab: SiteSlab;
  readonly stride: number;
  /** How many rankings the round holds: the next starts at `size * stride`. */
  size: number;
}

function siteMeasure(rows: number, measure: SiteMeasure['measure']): SiteMeasure {
  return { measure, rows, known: new WeakMap(), lastMap: null, lastStore: null };
}

function siteStore(map: GameMap, rows: number): SiteStore {
  return {
    current: siteRound(map, rows),
    previous: siteRound(map, rows),
    run: { order: new Uint8Array(0), start: 0, end: 0 },
    distances: new Float64Array(map.pois.length),
    pass: new Uint16Array(map.pois.length),
    counts: new Uint16Array(RADIX),
    unkept: new Uint16Array(map.pois.length),
    byCost: new Array<Uint16Array | undefined>(map.graph.nodes.length),
  };
}

function siteRound(map: GameMap, rows: number): SiteRound {
  const stride = map.pois.length + 1;
  return {
    bySpace: new Array<Map<number, number> | undefined>(map.graph.nodes.length),
    slab: stride <= 256 ? new Uint8Array(rows * stride) : new Uint16Array(rows * stride),
    stride,
    size: 0,
  };
}

/** `round`, emptied to be filled again. */
function emptied(round: SiteRound): SiteRound {
  round.bySpace.fill(undefined);
  round.size = 0;
  return round;
}

/**
 * Each site's `effectiveDistance` along the cheapest route by weighted
 * terrain cost: `closestBySpeeds`' measure. The players in the games the
 * computer imagines ask from a great many spaces and speeds, so its rounds
 * are large.
 */
const alongCheapestRoute = siteMeasure(65_536, (map, from, stats, distances) => {
  const config = map.ruleset.config;
  const routes = routeTable(map.graph, config);
  const costs = routes.from(from).costs;
  const steps = routes.stepsFrom(from);
  const speeds = refreshAllowance(stats);
  for (let index = 0; index < map.pois.length; index++) {
    const node = (map.pois[index] as Poi).node;
    distances[index] = Number.isFinite(costs[node])
      ? effectiveDistanceFor(steps.plains[node] as number, steps.forest[node] as number, steps.mountain[node] as number, speeds, config)
      : Number.POSITIVE_INFINITY;
  }
});

/** Each site's `effectiveDistance` along the best route for the speeds (`bestRouteSteps`): `closestByBestRoute`'s measure, asked from the few spaces the search weighs. */
const alongBestRoute = siteMeasure(4096, (map, from, stats, distances) => {
  const config = map.ruleset.config;
  const costs = routeTable(map.graph, config).from(from).costs;
  for (let index = 0; index < map.pois.length; index++) {
    const node = (map.pois[index] as Poi).node;
    const best = Number.isFinite(costs[node]) ? bestRouteSteps(map.graph, from, node, stats, config) : null;
    distances[index] = best === null ? Number.POSITIVE_INFINITY : best.distance;
  }
});

/** The map's sites in order of `measure` from `from` for `stats`' speeds, from the store when they were ranked before. */
function siteOrder(measure: SiteMeasure, map: GameMap, from: NodeId, stats: PlayerStats): SiteRun {
  let store = measure.lastMap === map ? measure.lastStore : null;
  if (store === null) {
    store = measure.known.get(map) ?? null;
    if (store === null) {
      store = siteStore(map, measure.rows);
      measure.known.set(map, store);
    }
    measure.lastMap = map;
    measure.lastStore = store;
  }
  const run = store.run;
  const key = speedsKey(stats);
  if (key === null) {
    const ranked = rankSites(measure, store, map, from, stats, store.unkept, 0);
    run.order = store.unkept;
    run.start = 0;
    run.end = ranked;
    return run;
  }
  let current = store.current.bySpace[from];
  let at = current?.get(key);
  if (at === undefined) {
    if (store.current.size >= measure.rows) {
      const filled = store.current;
      store.current = emptied(store.previous);
      store.previous = filled;
      current = undefined;
    }
    const round = store.current;
    at = round.size * round.stride;
    const before = store.previous.bySpace[from]?.get(key);
    if (before === undefined) {
      round.slab[at] = rankSites(measure, store, map, from, stats, round.slab, at + 1);
    } else {
      const slab = store.previous.slab;
      round.slab.set(slab.subarray(before, before + round.stride), at);
    }
    if (current === undefined) {
      current = new Map();
      round.bySpace[from] = current;
    }
    current.set(key, at);
    round.size += 1;
  }
  run.order = store.current.slab;
  run.start = at + 1;
  run.end = at + 1 + (store.current.slab[at] as number);
  return run;
}

/**
 * The map's sites ranked by `measure` from `from` for `stats`' speeds,
 * written into `into` (never the store's `pass`, which the ranking goes
 * through) from `start` on: nearest first, then the least weighted terrain
 * cost, then the lowest node id, sites no route reaches left out; how many
 * were written.
 *
 * The sites by cost and node (`sitesByCost`) are sorted by distance in two
 * stable passes over its digits (`RADIX`), which keeps that order among
 * equal distances. A distance that is no whole number below `RADIX²`, which
 * no ruleset's step costs give, has the sites sorted by comparing the three
 * instead, which comes to the same order more slowly.
 */
function rankSites(measure: SiteMeasure, store: SiteStore, map: GameMap, from: NodeId, stats: PlayerStats, into: SiteSlab, start: number): number {
  const { distances, pass, counts } = store;
  measure.measure(map, from, stats, distances);
  const byCost = sitesByCost(store, map, from);
  const reached = byCost.length;
  let digital = true;
  for (let at = 0; at < reached; at++) {
    const distance = distances[byCost[at] as number] as number;
    if (!Number.isInteger(distance) || distance < 0 || distance >= RADIX * RADIX) digital = false;
  }
  if (!digital) {
    const costs = routeTable(map.graph, map.ruleset.config).from(from).costs;
    const pois = map.pois;
    const sorted = Array.from(byCost).sort((a, b) => {
      const nodeA = (pois[a] as Poi).node;
      const nodeB = (pois[b] as Poi).node;
      return (distances[a] as number) - (distances[b] as number) || (costs[nodeA] as number) - (costs[nodeB] as number) || nodeA - nodeB;
    });
    into.set(sorted, start);
    return reached;
  }
  // Low digit first, into `pass`; then the high digit, into `into`.
  counts.fill(0);
  for (let at = 0; at < reached; at++) {
    const digit = (distances[byCost[at] as number] as number) % RADIX;
    counts[digit] = (counts[digit] as number) + 1;
  }
  for (let digit = 1; digit < RADIX; digit++) counts[digit] = (counts[digit] as number) + (counts[digit - 1] as number);
  for (let at = reached - 1; at >= 0; at--) {
    const site = byCost[at] as number;
    const digit = (distances[site] as number) % RADIX;
    const place = (counts[digit] as number) - 1;
    counts[digit] = place;
    pass[place] = site;
  }
  counts.fill(0);
  for (let at = 0; at < reached; at++) {
    const digit = Math.floor((distances[pass[at] as number] as number) / RADIX);
    counts[digit] = (counts[digit] as number) + 1;
  }
  for (let digit = 1; digit < RADIX; digit++) counts[digit] = (counts[digit] as number) + (counts[digit - 1] as number);
  for (let at = reached - 1; at >= 0; at--) {
    const site = pass[at] as number;
    const digit = Math.floor((distances[site] as number) / RADIX);
    const place = (counts[digit] as number) - 1;
    counts[digit] = place;
    into[start + place] = site;
  }
  return reached;
}

/** A whole-number distance below `RADIX * RADIX` is sorted as two digits of this base. */
const RADIX = 64;

/**
 * The sites a route from `from` reaches, by weighted terrain cost and then
 * node id: the map's search from `from` settles its spaces in that order.
 */
function sitesByCost(store: SiteStore, map: GameMap, from: NodeId): Uint16Array {
  let sites = store.byCost[from];
  if (sites === undefined) {
    const found: number[] = [];
    for (const node of routeTable(map.graph, map.ruleset.config).from(from).settled) {
      const index = map.poiByNode.get(node);
      if (index !== undefined) found.push(index);
    }
    sites = Uint16Array.from(found);
    store.byCost[from] = sites;
  }
  return sites;
}

/**
 * The three speeds (`refreshAllowance`'s, read off the stats) as one small
 * whole number, or `null` for a speed past what one holds (a thousand free
 * steps a turn), whose order is worked out afresh each time rather than
 * kept.
 */
function speedsKey(stats: PlayerStats): number | null {
  const plains = stats.plains_move;
  const forest = stats.forest_move;
  const mountain = stats.mountain_move;
  if (plains >= SPEED_LIMIT || forest >= SPEED_LIMIT || mountain >= SPEED_LIMIT) return null;
  return (plains * SPEED_LIMIT + forest) * SPEED_LIMIT + mountain;
}

const SPEED_LIMIT = 1024;
