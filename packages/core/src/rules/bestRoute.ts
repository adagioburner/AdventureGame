import { TERRAINS, type GameConfig, type PerTerrain } from '@adventure/config';
import type { NodeId } from '../ids.ts';
import type { MapGraph } from '../graph.ts';
import type { PlayerStats } from '../player.ts';
import { frontPath, routeTable, type RouteTable } from '../path.ts';
import { refreshAllowance } from './movement.ts';

/**
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q65): "stamina(1) = max(P - p, 0) +
 * 2*max(F - f, 0) + 3*max(M - m, 0) [...] We will count each turn as 5 stamina
 * (this is out rest stamina constant) and from that perspective define
 * effective distance = min 5n + stamina(n)"; 2026-09-30 (423): this formula.
 *
 * P, F and M are `steps`; p, f and m the player's plains, forest and mountain
 * speeds; 1, 2 and 3 are `STAMINA_COST`; 5 is `REST_STAMINA_GAIN`. n runs from
 * 1, so standing on the POI already is 5. The stamina the player has on hand
 * does not enter.
 *
 * Every term is convex in n, so once the sum starts to climb it never falls
 * again, and once every terrain the player has a speed on is covered it only
 * climbs; the search over n stops at whichever comes first.
 *
 * The computer ranks sites by it (Q112), and a route's is what makes it the
 * best (Q210, 810 A).
 */
export function effectiveDistance(steps: PerTerrain<number>, stats: PlayerStats, config: GameConfig): number {
  if (!TERRAINS.every((terrain) => Number.isFinite(steps[terrain]))) return Number.POSITIVE_INFINITY;
  return effectiveDistanceFor(steps.plains, steps.forest, steps.mountain, refreshAllowance(stats), config);
}

/**
 * `effectiveDistance` of finite steps, for speeds already read off the player
 * (`refreshAllowance`), with nothing allocated: the computer's searches ask
 * it for every site of the map at once (`@adventure/sim`'s `closestBySpeeds`).
 */
export function effectiveDistanceFor(plains: number, forest: number, mountain: number, speeds: PerTerrain<number>, config: GameConfig): number {
  const perTurn = config.movement.REST_STAMINA_GAIN;
  const cost = config.movement.STAMINA_COST;

  let best = Number.POSITIVE_INFINITY;
  for (let turns = 1; ; turns++) {
    const leftPlains = plains - turns * speeds.plains;
    const leftForest = forest - turns * speeds.forest;
    const leftMountain = mountain - turns * speeds.mountain;
    let total = perTurn * turns;
    if (leftPlains > 0) total += cost.plains * leftPlains;
    if (leftForest > 0) total += cost.forest * leftForest;
    if (leftMountain > 0) total += cost.mountain * leftMountain;
    if (total < best) best = total;
    else if (total > best) return best;
    // Once every terrain the player has a speed on is covered, it only climbs.
    const covered =
      (leftPlains <= 0 || speeds.plains === 0) && (leftForest <= 0 || speeds.forest === 0) && (leftMountain <= 0 || speeds.mountain === 0);
    if (covered) return best;
  }
}

/** The best route's steps per terrain and score, without the route itself (`bestRouteSteps`). */
export interface BestRouteSteps {
  readonly steps: PerTerrain<number>;
  /** Its `effectiveDistance` for the player's speeds. */
  readonly distance: number;
  /** -1 for today's route, `routes.path`; otherwise its entry in `routesFrom(from)`. */
  readonly entry: number;
}

/**
 * [Q210, 820 A] What `bestRoute` picks, as the cached counts of steps per
 * terrain and its score, with no route traced: all the computer's search
 * needs to rank sites and to tell what it reaches this turn. `null` only if
 * `to` cannot be reached. On the spot it is no steps at all.
 *
 * Only the player's speeds count, and the search asks for the same space and
 * speeds over and over, once a round per position it weighs; so each answer
 * is kept, for up to `BEST_ROUTE_MEMO_KEYS` spaces and speeds per map.
 */
export function bestRouteSteps(
  graph: MapGraph,
  from: NodeId,
  to: NodeId,
  stats: PlayerStats,
  config: GameConfig,
): BestRouteSteps | null {
  const routes = routeTable(graph, config);
  const speeds = refreshAllowance(stats);
  let rows = memos.get(routes);
  if (rows === undefined) {
    rows = new Map();
    memos.set(routes, rows);
  }
  const key = `${from} ${speeds.plains} ${speeds.forest} ${speeds.mountain}`;
  let row = rows.get(key);
  if (row === undefined) {
    if (rows.size >= BEST_ROUTE_MEMO_KEYS) rows.clear();
    row = new Array<BestRouteSteps | null | undefined>(graph.nodes.length);
    rows.set(key, row);
  }
  const known = row[to];
  if (known !== undefined) return known;
  const found = pickBestRoute(routes, from, to, speeds, config);
  row[to] = found;
  return found;
}

/** How many spaces and speeds `bestRouteSteps` keeps answers for, per map: a few MB at most. */
const BEST_ROUTE_MEMO_KEYS = 2048;

const memos = new WeakMap<RouteTable, Map<string, (BestRouteSteps | null | undefined)[]>>();

function pickBestRoute(routes: RouteTable, from: NodeId, to: NodeId, speeds: PerTerrain<number>, config: GameConfig): BestRouteSteps | null {
  const counts = routes.stepsFrom(from);
  const cheapest = { plains: counts.plains[to] as number, forest: counts.forest[to] as number, mountain: counts.mountain[to] as number };
  if (!Number.isFinite(cheapest.plains)) return null;
  const today = effectiveDistanceFor(cheapest.plains, cheapest.forest, cheapest.mountain, speeds, config);
  if (from === to) return { steps: cheapest, distance: today, entry: -1 };

  const front = routes.routesFrom(from);
  const first = front.start[to] as number;
  const last = front.start[to + 1] as number;
  const cost = config.movement.STAMINA_COST;
  // Only a route strictly better than today's replaces it; among those, the
  // least weighted terrain cost, then the first found.
  let chosen = -1;
  let distance = today;
  let weight = 0;
  for (let entry = first; entry < last; entry++) {
    const plains = front.plains[entry] as number;
    const forest = front.forest[entry] as number;
    const mountain = front.mountain[entry] as number;
    const candidate = effectiveDistanceFor(plains, forest, mountain, speeds, config);
    if (candidate > distance) continue;
    const entryWeight = cost.plains * plains + cost.forest * forest + cost.mountain * mountain;
    if (candidate === distance && (chosen === -1 || entryWeight >= weight)) continue;
    chosen = entry;
    distance = candidate;
    weight = entryWeight;
  }
  if (chosen === -1) return { steps: cheapest, distance: today, entry: -1 };
  return {
    steps: { plains: front.plains[chosen] as number, forest: front.forest[chosen] as number, mountain: front.mountain[chosen] as number },
    distance,
    entry: chosen,
  };
}

/**
 * [SOURCE §4, chat] Andrei, 2026-10-02 (Q210): "it bothers me that the game
 * shows to me the path that is not optimal based on my current skills. How
 * hard is it to make the players, including computer players, take the
 * optimal path by default"; 810 A to 815 A, and in stages, the first being
 * "switch the actual paths players walk to the most efficient".
 *
 * The route from `from` to `to` with the least `effectiveDistance` for
 * `stats`' speeds (810 A): free steps cost nothing, and a turn counts as 5
 * stamina. Among routes equally good, the cheapest by weighted terrain cost,
 * and today's route, `shortestPath`, whenever it is one of them (811 A), so a
 * player with no speeds is drawn and walks exactly the route they were.
 * `null` only if `to` cannot be reached. The route is traced only here, from
 * the entry `bestRouteSteps` would pick.
 *
 * It picks that entry afresh rather than from `bestRouteSteps`' answers:
 * one site's few routes cost little to score, while the players in the games
 * the computer imagines pick their sites from more spaces and speeds than
 * any store of answers could keep (Q210, stage 3).
 */
export function bestRoute(
  graph: MapGraph,
  from: NodeId,
  to: NodeId,
  stats: PlayerStats,
  config: GameConfig,
): readonly NodeId[] | null {
  if (from === to) return [];
  const routes = routeTable(graph, config);
  const choice = pickBestRoute(routes, from, to, refreshAllowance(stats), config);
  if (choice === null) return null;
  return choice.entry === -1 ? routes.path(from, to) : frontPath(routes.routesFrom(from), choice.entry);
}

/**
 * [Q210, 812 A] With a waypoint, each leg is the best for the player's speeds:
 * the best route to the waypoint followed by the best route onward.
 */
export function bestRouteVia(
  graph: MapGraph,
  from: NodeId,
  waypoint: NodeId | null,
  to: NodeId,
  stats: PlayerStats,
  config: GameConfig,
): readonly NodeId[] | null {
  if (waypoint === null) return bestRoute(graph, from, to, stats, config);
  const first = bestRoute(graph, from, waypoint, stats, config);
  if (first === null) return null;
  const second = bestRoute(graph, waypoint, to, stats, config);
  if (second === null) return null;
  return [...first, ...second];
}
