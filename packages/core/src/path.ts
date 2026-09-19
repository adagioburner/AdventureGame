import type { GameConfig, Terrain } from '@adventure/config';
import type { NodeId } from './ids.ts';
import type { MapGraph } from './graph.ts';
import { NotImplementedError } from './errors.ts';

/**
 * [SOURCE §1.2, chat] There is exactly **one** distance metric in this design:
 * weighted terrain cost, 1 plains / 2 forest / 3 mountain per step. It is used
 * for remoteness walks (§5.1), for the UI's shortest-path display (§7.1), for
 * the AI's POI targeting (§9), and it is the same table that stamina is
 * charged from (§7). Every component imports it from here; there is no second
 * cost function in the repo.
 *
 * The cost is charged for *entering* a node, so it depends on the destination
 * node's terrain — confirmed by the §8 worked example, where a step onto a
 * forest node is covered by forest-move skill, not by the skill of the node
 * being left.
 */
export function terrainStepCost(terrain: Terrain, config: GameConfig): number {
  return config.movement.STAMINA_COST[terrain];
}

export function stepCost(graph: MapGraph, node: NodeId, config: GameConfig): number {
  const target = graph.nodes[node];
  if (target === undefined) throw new RangeError(`unknown node ${node}`);
  return terrainStepCost(target.terrain, config);
}

/** Total weighted cost of a path, excluding the starting node. */
export function pathCost(graph: MapGraph, path: readonly NodeId[], config: GameConfig): number {
  let total = 0;
  for (const node of path) total += stepCost(graph, node, config);
  return total;
}

/**
 * Cheapest path by `terrainStepCost`, excluding `from`, including `to`.
 * Returns `null` only if `to` is unreachable (which cannot happen on a
 * validated map — §2.1 step 8 rejects disconnected graphs — but the signature
 * does not assume it).
 *
 * Implementation note for the next session: ties must be broken
 * deterministically (e.g. by lowest node id) so that two clients, the server
 * and a replay all display the identical path for the same request.
 */
export function shortestPath(
  _graph: MapGraph,
  _from: NodeId,
  _to: NodeId,
  _config: GameConfig,
): readonly NodeId[] | null {
  throw new NotImplementedError('shortestPath (Dijkstra over terrainStepCost)', 'GDD.md §5.1 / §7.1');
}

/**
 * [SOURCE §4] Shift-click sets an intermediate waypoint. The resulting route is
 * the cheapest path to the waypoint followed by the cheapest path onward.
 */
export function routeVia(
  graph: MapGraph,
  from: NodeId,
  waypoint: NodeId | null,
  to: NodeId,
  config: GameConfig,
): readonly NodeId[] | null {
  if (waypoint === null) return shortestPath(graph, from, to, config);
  const first = shortestPath(graph, from, waypoint, config);
  if (first === null) return null;
  const second = shortestPath(graph, waypoint, to, config);
  if (second === null) return null;
  return [...first, ...second];
}

/**
 * [SOURCE §4] Path colouring: green = covered by the current skill allowance,
 * yellow = costs stamina (labelled with the cost), grey = unreachable.
 *
 * [SOURCE §4, chat] This reflects only what is achievable *this turn*, and is
 * recalculated every turn as allowances refresh. Grey never means permanently
 * impossible — resting always restores stamina — so no component may cache a
 * grey verdict across turns or treat it as a connectivity statement.
 */
export type PathStepColor = 'free' | 'stamina' | 'unreachable';

export interface PathStep {
  readonly node: NodeId;
  readonly color: PathStepColor;
  /** Stamina charged for this step; 0 when covered by the allowance. */
  readonly staminaCost: number;
}

export interface PathPreview {
  readonly steps: readonly PathStep[];
  readonly destination: NodeId;
  /** False when the walk runs out of stamina before the destination. */
  readonly destinationReachable: boolean;
  /** How far the player actually gets this turn; index into `steps`. */
  readonly reachableStepCount: number;
  readonly totalStaminaCost: number;
}
