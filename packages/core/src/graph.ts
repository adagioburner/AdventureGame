import type { Terrain } from '@adventure/config';
import type { NodeId } from './ids.ts';
import { NotImplementedError } from './errors.ts';

/** A point in `MAP_COORDINATE_SPACE`. [SOURCE §1.3, chat] No real-world scale. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** [SOURCE §1] A map node: a small oval, coloured by its terrain. */
export interface MapNode {
  readonly id: NodeId;
  readonly position: Point;
  readonly terrain: Terrain;
}

/** [SOURCE §1] An undirected edge, rendered as a road/path. */
export interface MapEdge {
  readonly a: NodeId;
  readonly b: NodeId;
}

/**
 * [SOURCE §1] The planar graph. Planarity is guaranteed by construction
 * (Delaunay, §2.1 step 2) and "never needs re-checking", so there is no
 * planarity predicate anywhere in this package.
 *
 * `adjacency` is indexed by `NodeId`, which is why node ids are dense integers.
 */
export interface MapGraph {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly adjacency: readonly (readonly NodeId[])[];
}

export function neighbours(graph: MapGraph, node: NodeId): readonly NodeId[] {
  return graph.adjacency[node] ?? [];
}

export function degree(graph: MapGraph, node: NodeId): number {
  return neighbours(graph, node).length;
}

/** [SOURCE §1] A leaf is a degree-1 node — "no dead ends", so all become POIs. */
export function isLeaf(graph: MapGraph, node: NodeId): boolean {
  return degree(graph, node) === 1;
}

export function leafNodes(graph: MapGraph): NodeId[] {
  return graph.nodes.filter((node) => isLeaf(graph, node.id)).map((node) => node.id);
}

/**
 * §2.1 steps 3 and 8 both reject a disconnected graph. Plain BFS; the graph is
 * ~240 nodes so nothing cleverer is warranted.
 */
export function isConnected(graph: MapGraph): boolean {
  if (graph.nodes.length === 0) return true;
  const seen = new Uint8Array(graph.nodes.length);
  const first = graph.nodes[0]?.id;
  if (first === undefined) return true;
  const queue: NodeId[] = [first];
  seen[first] = 1;
  let visited = 1;
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as NodeId;
    for (const next of neighbours(graph, current)) {
      if (seen[next] === 0) {
        seen[next] = 1;
        visited++;
        queue.push(next);
      }
    }
  }
  return visited === graph.nodes.length;
}

/**
 * Per-terrain-region measurements feeding `compactness` (§2.1 step 5).
 *
 * `compactness = boundary² / area` is the GDD's formula verbatim. What is NOT
 * in the GDD is the *measurement convention* — what "boundary" and "area"
 * count on a graph. The stated circle reference (4π ≈ 13) is only reproduced
 * by counting **nodes** for both: a unit-density disc has area πr² nodes and
 * 2πr boundary nodes, giving 4π; counting boundary *edges* on a Delaunay mesh
 * lands several times higher, well above `COMPACTNESS_MAX` = 25.
 *
 * That derivation is strong but it is still a reading, so this function is
 * left unimplemented rather than committed to. See docs/OPEN_QUESTIONS.md Q4.
 */
export interface RegionMetrics {
  readonly area: number;
  readonly boundary: number;
}

export function regionMetrics(_graph: MapGraph, _terrain: Terrain): RegionMetrics {
  throw new NotImplementedError(
    'regionMetrics — the boundary/area counting convention is unconfirmed',
    'GDD.md §2.1 step 5 / docs/OPEN_QUESTIONS.md Q4',
  );
}

/** [SOURCE §1.3] `compactness = boundary² / area`. */
export function compactness(metrics: RegionMetrics): number {
  return (metrics.boundary * metrics.boundary) / metrics.area;
}
