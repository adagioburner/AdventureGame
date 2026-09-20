import type { Terrain } from '@adventure/config';
import type { NodeId } from './ids.ts';

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
 * Measurements feeding `compactness` (§2.1 step 5).
 *
 * [SOURCE §2.1 step 5, chat] "Yes, counting nodes is the right approach" — so
 * **area** is the region's node count and **boundary** is the count of its
 * nodes that touch a node of another terrain. That is the convention the
 * stated circle reference reproduces: a unit-density disc has πr² nodes and
 * 2πr boundary nodes, giving `boundary²/area = 4π ≈ 13`.
 */
export interface RegionMetrics {
  readonly area: number;
  readonly boundary: number;
}

export function regionMetrics(graph: MapGraph, region: ReadonlySet<NodeId>): RegionMetrics {
  let boundary = 0;
  for (const node of region) {
    for (const neighbour of neighbours(graph, node)) {
      if (!region.has(neighbour)) {
        boundary++;
        break;
      }
    }
  }
  return { area: region.size, boundary };
}

/** [SOURCE §1.3] `compactness = boundary² / area`. */
export function compactness(metrics: RegionMetrics): number {
  return (metrics.boundary * metrics.boundary) / metrics.area;
}

/** Every node of one terrain, across however many regions it occupies. */
export function terrainNodes(graph: MapGraph, terrain: Terrain): Set<NodeId> {
  const nodes = new Set<NodeId>();
  for (const node of graph.nodes) if (node.terrain === terrain) nodes.add(node.id);
  return nodes;
}

/**
 * A terrain's connected components — §2.1 step 4 seeds "1 or 2 seeds per
 * terrain", so a terrain can legitimately occupy two separate regions.
 *
 * Which of these the Smooth step measures is a real fork and is **not settled**:
 * measuring a terrain's nodes as one set versus per component differs by a
 * factor of about 2 for two equal blobs — two discs measured together give
 * `(2B)²/2A = 2B²/A`, i.e. ~8π ≈ 25, which sits exactly on `COMPACTNESS_MAX`,
 * while each disc measured alone gives ~13. So the threshold is either
 * comfortably met or barely met depending on the reading. See
 * OPEN_QUESTIONS Q4a; both helpers are here so either is one line.
 */
export function terrainRegions(graph: MapGraph, terrain: Terrain): Set<NodeId>[] {
  const all = terrainNodes(graph, terrain);
  const seen = new Set<NodeId>();
  const regions: Set<NodeId>[] = [];
  for (const start of all) {
    if (seen.has(start)) continue;
    const region = new Set<NodeId>([start]);
    const queue: NodeId[] = [start];
    seen.add(start);
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head] as NodeId;
      for (const next of neighbours(graph, current)) {
        if (all.has(next) && !seen.has(next)) {
          seen.add(next);
          region.add(next);
          queue.push(next);
        }
      }
    }
    regions.push(region);
  }
  return regions;
}
