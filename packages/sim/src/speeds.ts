import type { PerTerrain } from '@adventure/config';
import { bestRouteSteps, effectiveDistance, routeTable, type GameState, type NodeId, type PlayerState } from '@adventure/core';
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
 * it; its imagined games still rank by `closestBySpeeds`.
 */
export function closestByBestRoute(
  state: GameState,
  player: PlayerState,
  eligible: ReadonlySet<NodeId>,
  count: number,
): readonly PoiCandidate[] {
  if (count <= 0 || eligible.size === 0) return [];
  const config = state.map.ruleset.config;
  const costs = routeTable(state.map.graph, config).from(player.position).costs;

  const scored: { readonly node: NodeId; readonly cost: number; readonly distance: number }[] = [];
  for (const node of eligible) {
    const cost = costs[node] as number;
    if (!Number.isFinite(cost)) continue;
    const best = bestRouteSteps(state.map.graph, player.position, node, player.stats, config);
    if (best === null) continue;
    scored.push({ node, cost, distance: best.distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.cost - b.cost || a.node - b.node);
  return scored.slice(0, count).map(({ node, cost }) => ({ node, cost }));
}
