import { TERRAINS, type GameConfig, type PerTerrain, type Terrain } from '@adventure/config';
import type { NodeId } from './ids.ts';
import { neighbours, type MapGraph } from './graph.ts';

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

/* -------------------------------------------------------------------------- */
/*  The one shortest-path search                                               */
/* -------------------------------------------------------------------------- */

/**
 * Settled-node information from one Dijkstra run, indexed by `NodeId` — which
 * is why node ids are dense integers (see `ids.ts`).
 */
export interface DijkstraResult {
  /** Weighted cost from the origin; `Infinity` for a node never settled. */
  readonly costs: readonly number[];
  /** Predecessor on the cheapest path, or `null` for the origin and unreached nodes. */
  readonly previous: readonly (NodeId | null)[];
  /** Nodes in the order they were settled: ascending by `(cost, node id)`. */
  readonly settled: readonly NodeId[];
}

export interface DijkstraOptions {
  /**
   * Called for every node as it is settled, in settle order. Returning `true`
   * ends the search after that node — which is how `closestPoiCandidates`
   * stops once it has seen `CLOSE_CANDIDATE_COUNT` eligible POIs instead of
   * exploring the whole map.
   */
  readonly stopWhen?: (node: NodeId, cost: number) => boolean;
}

/**
 * The single Dijkstra in the repo, over `terrainStepCost`.
 *
 * **Determinism is the point.** The frontier is ordered by `(cost, node id)`,
 * so the settle order is a total order with no ties at all, and a predecessor
 * is recorded only on a *strict* improvement. Two nodes that offer the same
 * cost to a third therefore always lose to the one settled first, whatever
 * order `adjacency` happens to list them in. That is what lets two clients,
 * the server and a replay draw the identical path for the same request.
 */
export function dijkstra(
  graph: MapGraph,
  from: NodeId,
  config: GameConfig,
  options: DijkstraOptions = {},
): DijkstraResult {
  const count = graph.nodes.length;
  const costs = new Array<number>(count).fill(Number.POSITIVE_INFINITY);
  const previous = new Array<NodeId | null>(count).fill(null);
  const done = new Array<boolean>(count).fill(false);
  const settled: NodeId[] = [];

  if (from < 0 || from >= count) throw new RangeError(`unknown node ${from}`);
  costs[from] = 0;

  const heap: HeapEntry[] = [];
  heapPush(heap, { node: from, cost: 0 });

  for (;;) {
    const entry = heapPop(heap);
    if (entry === undefined) break;
    if (done[entry.node] === true) continue;
    done[entry.node] = true;
    settled.push(entry.node);
    if (options.stopWhen?.(entry.node, entry.cost) === true) break;

    for (const next of neighbours(graph, entry.node)) {
      if (done[next] === true) continue;
      const candidate = entry.cost + stepCost(graph, next, config);
      if (candidate < (costs[next] ?? Number.POSITIVE_INFINITY)) {
        costs[next] = candidate;
        previous[next] = entry.node;
        heapPush(heap, { node: next, cost: candidate });
      }
    }
  }

  return { costs, previous, settled };
}

/**
 * Cheapest path by `terrainStepCost`, excluding `from`, including `to`.
 * Returns `null` only if `to` is unreachable (which cannot happen on a
 * validated map — §2.1 step 8 rejects disconnected graphs — but the signature
 * does not assume it). `from === to` is the empty path, which costs nothing.
 *
 * Ties break deterministically; see `dijkstra` for how and why.
 */
export function shortestPath(
  graph: MapGraph,
  from: NodeId,
  to: NodeId,
  config: GameConfig,
): readonly NodeId[] | null {
  if (from === to) return [];
  const { previous } = dijkstra(graph, from, config, { stopWhen: (node) => node === to });
  return pathTo(previous, from, to);
}

/** The path `dijkstra`'s predecessors give from `from` to `to`, or `null` if it never reached `to`. */
function pathTo(previous: readonly (NodeId | null)[], from: NodeId, to: NodeId): readonly NodeId[] | null {
  if (from === to) return [];
  if (previous[to] == null) return null;

  const reversed: NodeId[] = [];
  let cursor: NodeId | null = to;
  while (cursor !== null && cursor !== from) {
    reversed.push(cursor);
    cursor = previous[cursor] ?? null;
  }
  return reversed.reverse();
}

/**
 * Every search from a node over one map, kept once worked out.
 *
 * [SOURCE §9, review] Andrei, 2026-09-28 (Q62): "we can also precompute and
 * cache distances to make simulations run faster". The step costs are fixed per
 * terrain and nobody's skills enter them, so on a map that never changes — a
 * game's — the search from a node always comes out the same. `from` runs the
 * whole `dijkstra` from a node the first time it is asked for and keeps it.
 *
 * Nothing it answers differs from the uncached functions: `dijkstra` settles
 * in `(cost, node id)` order and never revisits a settled node's predecessor,
 * so a whole search settles the same nodes in the same order as one stopped
 * early, and `path` is exactly `shortestPath`.
 *
 * Only for a graph that is never changed after the first call. The map
 * generator builds and edits graphs, so it keeps the uncached functions.
 */
export interface RouteTable {
  /** The whole `dijkstra` from `from`. */
  from(from: NodeId): DijkstraResult;
  /** `shortestPath(graph, from, to, config)`. */
  path(from: NodeId, to: NodeId): readonly NodeId[] | null;
  /**
   * How many steps of each route from `from` enter each terrain:
   * `stepsFrom(from).forest[to]` is the number of forest nodes on
   * `path(from, to)`, counting `to` and not `from`, as a step is charged (§7).
   * `Infinity` for a node the search never reached.
   *
   * [SOURCE §9, review] Andrei, 2026-09-28 (Q65): "precompute and cache the
   * number of steps required to reach each POI from each node over each
   * terrain separately. (We will allow ourselves to be sloppy here and simply
   * take the shortest path)", counted along the cheapest route by road cost,
   * the one `path` gives (155).
   */
  stepsFrom(from: NodeId): TerrainSteps;
}

/** Steps onto each terrain, indexed by the node a route ends on. */
export type TerrainSteps = PerTerrain<readonly number[]>;

const routeTables = new WeakMap<MapGraph, WeakMap<GameConfig, RouteTable>>();

/** The one `RouteTable` for `graph` under `config`'s step costs. */
export function routeTable(graph: MapGraph, config: GameConfig): RouteTable {
  let byConfig = routeTables.get(graph);
  if (byConfig === undefined) {
    byConfig = new WeakMap();
    routeTables.set(graph, byConfig);
  }
  const known = byConfig.get(config);
  if (known !== undefined) return known;

  const searches: (DijkstraResult | undefined)[] = new Array(graph.nodes.length);
  const steps: (TerrainSteps | undefined)[] = new Array(graph.nodes.length);
  const table: RouteTable = {
    from(from: NodeId): DijkstraResult {
      let search = searches[from];
      if (search === undefined) {
        search = dijkstra(graph, from, config);
        searches[from] = search;
      }
      return search;
    },
    path(from: NodeId, to: NodeId): readonly NodeId[] | null {
      if (from === to) return [];
      return pathTo(table.from(from).previous, from, to);
    },
    stepsFrom(from: NodeId): TerrainSteps {
      let counts = steps[from];
      if (counts === undefined) {
        counts = stepsAlong(graph, from, table.from(from));
        steps[from] = counts;
      }
      return counts;
    },
  };
  byConfig.set(config, table);
  return table;
}

/**
 * Each node's steps per terrain along `search`'s routes from `from`. A node is
 * settled after its predecessor, so walking the settle order, a node's counts
 * are its predecessor's plus the one step onto its own terrain.
 */
function stepsAlong(graph: MapGraph, from: NodeId, search: DijkstraResult): TerrainSteps {
  const count = graph.nodes.length;
  const counts = {} as Record<Terrain, number[]>;
  for (const terrain of TERRAINS) {
    counts[terrain] = new Array<number>(count).fill(Number.POSITIVE_INFINITY);
    counts[terrain][from] = 0;
  }
  for (const node of search.settled) {
    const before = search.previous[node];
    if (before == null) continue;
    const entered = graph.nodes[node]?.terrain;
    for (const terrain of TERRAINS) {
      counts[terrain][node] = (counts[terrain][before] as number) + (terrain === entered ? 1 : 0);
    }
  }
  return counts;
}

/* -- A binary min-heap ordered by `(cost, node id)`. Infrastructure only. --- */

interface HeapEntry {
  readonly node: NodeId;
  readonly cost: number;
}

function precedes(a: HeapEntry, b: HeapEntry): boolean {
  return a.cost !== b.cost ? a.cost < b.cost : a.node < b.node;
}

function heapPush(heap: HeapEntry[], entry: HeapEntry): void {
  heap.push(entry);
  for (let index = heap.length - 1; index > 0; ) {
    const parent = (index - 1) >> 1;
    if (!precedes(heap[index] as HeapEntry, heap[parent] as HeapEntry)) break;
    swap(heap, index, parent);
    index = parent;
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry | undefined {
  const top = heap[0];
  if (top === undefined) return undefined;
  const last = heap.pop() as HeapEntry;
  if (heap.length === 0) return top;

  heap[0] = last;
  for (let index = 0; ; ) {
    const left = index * 2 + 1;
    const right = left + 1;
    let best = index;
    if (left < heap.length && precedes(heap[left] as HeapEntry, heap[best] as HeapEntry)) best = left;
    if (right < heap.length && precedes(heap[right] as HeapEntry, heap[best] as HeapEntry)) best = right;
    if (best === index) break;
    swap(heap, index, best);
    index = best;
  }
  return top;
}

function swap(heap: HeapEntry[], a: number, b: number): void {
  const held = heap[a] as HeapEntry;
  heap[a] = heap[b] as HeapEntry;
  heap[b] = held;
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
 * yellow = costs stamina, grey = unreachable. The UI puts no cost beside a
 * yellow step since Andrei's 2026-09-23 review (Q32); `staminaCost` is still
 * reported, because the engine charges it.
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
