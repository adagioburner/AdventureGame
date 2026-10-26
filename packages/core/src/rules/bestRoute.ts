import { TERRAINS, type GameConfig, type PerTerrain } from '@adventure/config';
import type { NodeId } from '../ids.ts';
import type { MapGraph } from '../graph.ts';
import type { MovementAllowance, PlayerStats } from '../player.ts';
import { frontPath, pathCost, routeTable, terrainStepCost, type RouteTable } from '../path.ts';
import { countWalk, refreshAllowance } from './movement.ts';

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
 * The computer ranks sites by it (Q112), along the route it counts best for
 * the speeds (`bestRouteSteps`). The route drawn and walked is picked by how
 * End turn walks it instead (`bestRoute`, Q308).
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
  /** -1 for the cheapest route, `routes.path`; otherwise its entry in `routesFrom(from)`. */
  readonly entry: number;
}

/**
 * [Q210, 820 A] The route with the least `effectiveDistance` for the player's
 * speeds, as the cached counts of steps per terrain and its score, with no
 * route traced: what the computer's search ranks sites by (Q308: the formula
 * stays for that). Among routes equally good, the cheapest by weighted
 * terrain cost, and the cheapest route whenever it is one of them (811 A).
 * `null` only if `to` cannot be reached. On the spot it is no steps at all.
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
  // Only a route strictly better than the cheapest (`today`) replaces it;
  // among those, the least weighted terrain cost, then the first found.
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
 * [Q308] How End turn walks `path`, turn after turn (§7): this turn from the
 * free steps `allowance` leaves and the `stamina` held, each later turn from
 * the player's full `speeds`. Free steps go first on each terrain, stamina
 * pays beyond them, and a turn stops at the first step it cannot pay; a turn
 * that walks nothing rests instead (490). Nothing that happens where a turn
 * ends on the way is counted.
 */
export interface TurnByTurnWalk {
  /** The turns until it arrives, counting this one: 1 when it arrives this turn. */
  readonly turns: number;
  /** The stamina its steps cost. */
  readonly staminaSpent: number;
  /** The free steps left in the turn it arrives on. */
  readonly allowance: MovementAllowance;
  /** The stamina held when it arrives. */
  readonly stamina: number;
}

export function walkTurnByTurn(
  graph: MapGraph,
  path: readonly NodeId[],
  allowance: MovementAllowance,
  stamina: number,
  speeds: MovementAllowance,
  config: GameConfig,
): TurnByTurnWalk {
  let plains = allowance.plains;
  let forest = allowance.forest;
  let mountain = allowance.mountain;
  let held = stamina;
  let spent = 0;
  let turns = 1;
  let walked = 0;
  for (let at = 0; at < path.length; ) {
    const terrain = graph.nodes[path[at] as NodeId]?.terrain;
    if (terrain === undefined) throw new RangeError(`unknown node ${path[at]}`);
    if (terrain === 'plains' && plains > 0) plains--;
    else if (terrain === 'forest' && forest > 0) forest--;
    else if (terrain === 'mountain' && mountain > 0) mountain--;
    else {
      const price = terrainStepCost(terrain, config);
      if (price > held) {
        // The turn ends here; one that walked nothing rests.
        if (walked === 0) held += config.movement.REST_STAMINA_GAIN;
        turns++;
        walked = 0;
        plains = speeds.plains;
        forest = speeds.forest;
        mountain = speeds.mountain;
        continue;
      }
      held -= price;
      spent += price;
    }
    at++;
    walked++;
  }
  return { turns, staminaSpent: spent, allowance: { plains, forest, mountain }, stamina: held };
}

/**
 * [Q315] Andrei, 2026-10-26: "when showing a long path to the destination, it
 * would be helpful to mark the grey part with flags (bubbles? markers?)
 * showing where they will be in two turns, three turns etc." Where each turn
 * of `path` ends as End turn walks it, turn after turn, as `walkTurnByTurn`
 * counts it (3 A): this turn from the free steps `allowance` leaves and the
 * `stamina` held, each later turn from the player's full `speeds`, a turn
 * stopping at the first step it cannot pay, and a turn that walks nothing
 * resting (490), which is counted as a turn (6 A). Nothing that happens where
 * a turn ends on the way is counted (Q308, 3 A).
 *
 * One entry a turn, this one first: how many steps of `path` are walked by
 * the end of it. A turn that rests repeats the entry before it, and the last
 * entry is `path.length`.
 */
export function turnStops(
  graph: MapGraph,
  path: readonly NodeId[],
  allowance: MovementAllowance,
  stamina: number,
  speeds: MovementAllowance,
  config: GameConfig,
): readonly number[] {
  const stops: number[] = [];
  let free = allowance;
  let held = stamina;
  let walked = 0;
  do {
    const turn = countWalk(graph, path, walked, free, held, config);
    if (turn.steps === 0) held += config.movement.REST_STAMINA_GAIN;
    held -= turn.staminaSpent;
    walked += turn.steps;
    stops.push(walked);
    free = speeds;
  } while (walked < path.length);
  return stops;
}

/**
 * [Q308] Andrei, 2026-10-25: a route is scored as End turn walks it. The
 * Q65 measure, a turn counting as 5 stamina (`REST_STAMINA_GAIN`), on the
 * walk itself: 5 for each turn until it arrives plus the stamina it spends.
 */
export function walkedDistance(walk: TurnByTurnWalk, config: GameConfig): number {
  return config.movement.REST_STAMINA_GAIN * walk.turns + walk.staminaSpent;
}

/**
 * [SOURCE §4, chat] Andrei, 2026-10-02 (Q210): "it bothers me that the game
 * shows to me the path that is not optimal based on my current skills. How
 * hard is it to make the players, including computer players, take the
 * optimal path by default"; 810 A to 815 A, and in stages, the first being
 * "switch the actual paths players walk to the most efficient".
 *
 * [Q308] Andrei, 2026-10-25, on a 26-step loop drawn where 9 forest steps
 * arrived this turn: "Something is very wrong with path calculation here".
 * The route from `from` to `to` with the least `walkedDistance`: walked as
 * End turn walks it, from this turn's free steps left, `allowance`, and the
 * stamina in `stats`. 810 A's formula let every turn's free steps fall
 * anywhere along a route, and End turn spends stamina rather than wait for
 * them. Among routes equally good, the cheapest by weighted terrain cost, and
 * the cheapest route, `shortestPath`, whenever it is one of them (811 A), so
 * a player with no speeds is drawn and walks the cheapest route. `null` only
 * if `to` cannot be reached.
 *
 * The candidates are the routes `routesFrom` keeps, those no other route
 * beats on all three terrains' step counts. Now and then a longer route walks
 * a little better, its extra free steps ending a turn where the next turn's
 * free steps take over; it is not weighed.
 */
export function bestRoute(
  graph: MapGraph,
  from: NodeId,
  to: NodeId,
  stats: PlayerStats,
  allowance: MovementAllowance,
  config: GameConfig,
): readonly NodeId[] | null {
  return bestWalk(graph, from, to, stats, allowance, config)?.route ?? null;
}

/**
 * [Q210, 812 A] With a waypoint, each leg is the best for the player: the
 * best route to the waypoint followed by the best route onward. [Q308] The
 * leg onward is scored from where the first leaves the walk: the free steps
 * left in the turn it reaches the waypoint, and the stamina then held.
 */
export function bestRouteVia(
  graph: MapGraph,
  from: NodeId,
  waypoint: NodeId | null,
  to: NodeId,
  stats: PlayerStats,
  allowance: MovementAllowance,
  config: GameConfig,
): readonly NodeId[] | null {
  if (waypoint === null) return bestRoute(graph, from, to, stats, allowance, config);
  const first = bestWalk(graph, from, waypoint, stats, allowance, config);
  if (first === null) return null;
  const second = bestWalk(graph, waypoint, to, { ...stats, stamina: first.walk.stamina }, first.walk.allowance, config);
  if (second === null) return null;
  return [...first.route, ...second.route];
}

function bestWalk(
  graph: MapGraph,
  from: NodeId,
  to: NodeId,
  stats: PlayerStats,
  allowance: MovementAllowance,
  config: GameConfig,
): { readonly route: readonly NodeId[]; readonly walk: TurnByTurnWalk } | null {
  const speeds = refreshAllowance(stats);
  const walkOf = (path: readonly NodeId[]): TurnByTurnWalk => walkTurnByTurn(graph, path, allowance, stats.stamina, speeds, config);
  if (from === to) return { route: [], walk: walkOf([]) };
  const routes = routeTable(graph, config);
  const cheapest = routes.path(from, to);
  if (cheapest === null) return null;

  let route = cheapest;
  let walk = walkOf(cheapest);
  let distance = walkedDistance(walk, config);
  let weight = pathCost(graph, cheapest, config);
  // No route walks better than `effectiveDistance` counts it, for free steps
  // that many a turn: so a route it counts worse than the best walk yet, or
  // only as good and no cheaper, is never traced.
  const most = {
    plains: Math.max(speeds.plains, allowance.plains),
    forest: Math.max(speeds.forest, allowance.forest),
    mountain: Math.max(speeds.mountain, allowance.mountain),
  };
  const cost = config.movement.STAMINA_COST;
  const front = routes.routesFrom(from);
  const last = front.start[to + 1] as number;
  for (let entry = front.start[to] as number; entry < last; entry++) {
    const plains = front.plains[entry] as number;
    const forest = front.forest[entry] as number;
    const mountain = front.mountain[entry] as number;
    const entryWeight = cost.plains * plains + cost.forest * forest + cost.mountain * mountain;
    const bound = effectiveDistanceFor(plains, forest, mountain, most, config);
    if (bound > distance || (bound === distance && entryWeight >= weight)) continue;
    const candidate = frontPath(front, entry);
    const candidateWalk = walkOf(candidate);
    const candidateDistance = walkedDistance(candidateWalk, config);
    if (candidateDistance > distance || (candidateDistance === distance && entryWeight >= weight)) continue;
    route = candidate;
    walk = candidateWalk;
    distance = candidateDistance;
    weight = entryWeight;
  }
  return { route, walk };
}
