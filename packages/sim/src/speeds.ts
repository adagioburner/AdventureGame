import { TERRAINS, type GameConfig, type PerTerrain } from '@adventure/config';
import { refreshAllowance, routeTable, type GameState, type NodeId, type PlayerState, type PlayerStats } from '@adventure/core';
import type { PoiCandidate } from './candidates.ts';

/**
 * How far the computer player counts a site, by its own speeds (Q112).
 *
 * The one distance metric (§1.2) still finds every route: the cheapest by
 * weighted terrain cost. What changed is how the computer ranks the sites at
 * the ends of those routes. The remoteness walk (§5.1) and a person's route
 * preview still rank and draw by weighted terrain cost alone.
 */

/** The `count` POIs of `eligible` that `player` counts as closest, nearest first. */
export type ClosestFinder = (
  state: GameState,
  player: PlayerState,
  eligible: ReadonlySet<NodeId>,
  count: number,
) => readonly PoiCandidate[];

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
 * [SOURCE §9, chat] Andrei, 2026-09-30 (Q112): "recalculating distances based
 * on current skills using the cached numbers. It bothers me that the cached
 * distances always consider mountains inaccessible when in reality by the [end]
 * of the game you can have lots of mountain speed."
 *
 * Each POI's `effectiveDistance`, from the steps per terrain along the
 * cheapest route (422 A: that route only), with the player's speeds now. The
 * computer's own choices and every player in the games it imagines rank by it
 * (424 A). Equal distances keep the weighted-terrain-cost order, then node id.
 * `cost` stays the weighted terrain cost, and the route walked is still the
 * cheapest one, the only one counted.
 */
export function closestBySpeeds(
  state: GameState,
  player: PlayerState,
  eligible: ReadonlySet<NodeId>,
  count: number,
): readonly PoiCandidate[] {
  if (count <= 0 || eligible.size === 0) return [];
  const config = state.map.ruleset.config;
  const routes = routeTable(state.map.graph, config);
  const costs = routes.from(player.position).costs;
  const steps = routes.stepsFrom(player.position);

  const scored: { readonly node: NodeId; readonly cost: number; readonly distance: number }[] = [];
  for (const node of eligible) {
    const cost = costs[node] as number;
    if (!Number.isFinite(cost)) continue;
    const toNode = { plains: steps.plains[node] as number, forest: steps.forest[node] as number, mountain: steps.mountain[node] as number };
    scored.push({ node, cost, distance: effectiveDistance(toNode, player.stats, config) });
  }
  scored.sort((a, b) => a.distance - b.distance || a.cost - b.cost || a.node - b.node);
  return scored.slice(0, count).map(({ node, cost }) => ({ node, cost }));
}

