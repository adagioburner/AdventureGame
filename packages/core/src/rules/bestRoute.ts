import { TERRAINS, type GameConfig, type PerTerrain } from '@adventure/config';
import type { NodeId } from '../ids.ts';
import type { MapGraph } from '../graph.ts';
import type { PlayerStats } from '../player.ts';
import { frontPath, routeTable } from '../path.ts';
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
  const speeds = refreshAllowance(stats);
  const perTurn = config.movement.REST_STAMINA_GAIN;
  const cost = config.movement.STAMINA_COST;

  let best = Number.POSITIVE_INFINITY;
  for (let turns = 1; ; turns++) {
    let total = perTurn * turns;
    let covered = true;
    for (const terrain of TERRAINS) {
      const left = steps[terrain] - turns * speeds[terrain];
      if (left <= 0) continue;
      total += cost[terrain] * left;
      if (speeds[terrain] > 0) covered = false;
    }
    if (total < best) best = total;
    else if (total > best) return best;
    if (covered) return best;
  }
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
 * `null` only if `to` cannot be reached.
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
  const front = routes.routesFrom(from);
  const first = front.start[to] as number;
  const last = front.start[to + 1] as number;
  if (first === last) return null;

  const steps = routes.stepsFrom(from);
  const cheapest = effectiveDistance(
    { plains: steps.plains[to] as number, forest: steps.forest[to] as number, mountain: steps.mountain[to] as number },
    stats,
    config,
  );
  const cost = config.movement.STAMINA_COST;
  // Only a route strictly better than today's replaces it; among those, the
  // least weighted terrain cost, then the first found.
  let chosen = -1;
  let distance = cheapest;
  let weight = 0;
  for (let entry = first; entry < last; entry++) {
    const plains = front.plains[entry] as number;
    const forest = front.forest[entry] as number;
    const mountain = front.mountain[entry] as number;
    const candidate = effectiveDistance({ plains, forest, mountain }, stats, config);
    if (candidate > distance) continue;
    const entryWeight = cost.plains * plains + cost.forest * forest + cost.mountain * mountain;
    if (candidate === distance && (chosen === -1 || entryWeight >= weight)) continue;
    chosen = entry;
    distance = candidate;
    weight = entryWeight;
  }
  return chosen === -1 ? routes.path(from, to) : frontPath(front, chosen);
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
