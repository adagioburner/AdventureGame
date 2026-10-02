import { effectiveDistance, routeTable, type GameState, type NodeId, type PlayerState } from '@adventure/core';
import type { PoiCandidate } from './candidates.ts';

/**
 * How far the computer player counts a site, by its own speeds (Q112).
 *
 * The one cost per step (§1.2) still finds the routes counted here: the
 * cheapest by weighted terrain cost. What changed is how the computer ranks
 * the sites at the ends of those routes. The remoteness walk (§5.1) still
 * ranks by weighted terrain cost alone. A person's drawn route and the
 * computer's real move walk the best route for the player's speeds instead
 * (Q210, `bestRoute`); ranking sites by it is the next stage.
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

