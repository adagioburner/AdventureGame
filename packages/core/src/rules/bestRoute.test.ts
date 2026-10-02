import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, TERRAINS, type Terrain } from '@adventure/config';
import { asNodeId, type NodeId } from '../ids.ts';
import { neighbours, type MapGraph } from '../graph.ts';
import { initialStats, type PlayerStats } from '../player.ts';
import { createRng } from '../rng.ts';
import { routeTable, shortestPath } from '../path.ts';
import { bestRoute, bestRouteVia, effectiveDistance } from './bestRoute.ts';

const config = DEFAULT_GAME_CONFIG;

function graphOf(terrains: readonly Terrain[], edges: readonly (readonly [number, number])[]): MapGraph {
  const adjacency: number[][] = terrains.map(() => []);
  for (const [a, b] of edges) {
    (adjacency[a] as number[]).push(b);
    (adjacency[b] as number[]).push(a);
  }
  return {
    nodes: terrains.map((terrain, index) => ({ id: asNodeId(index), position: { x: index, y: 0 }, terrain })),
    edges: edges.map(([a, b]) => ({ a: asNodeId(a), b: asNodeId(b) })),
    adjacency: adjacency.map((list) => list.map(asNodeId)),
  };
}

/** A `side` × `side` grid of random terrain, each node joined to its right and lower neighbours. */
function randomGrid(seed: string, side: number): MapGraph {
  const rng = createRng(seed);
  const terrains = Array.from({ length: side * side }, () => rng.pick(TERRAINS));
  const edges: [number, number][] = [];
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const at = row * side + column;
      if (column + 1 < side) edges.push([at, at + 1]);
      if (row + 1 < side) edges.push([at, at + side]);
    }
  }
  return graphOf(terrains, edges);
}

const n = (value: number): NodeId => asNodeId(value);

function speeds(plains: number, forest: number, mountain: number): PlayerStats {
  return { ...initialStats(10), plains_move: plains, forest_move: forest, mountain_move: mountain };
}

function stepsOf(graph: MapGraph, path: readonly NodeId[]): { plains: number; forest: number; mountain: number } {
  const steps = { plains: 0, forest: 0, mountain: 0 };
  for (const node of path) steps[graph.nodes[node]?.terrain as Terrain]++;
  return steps;
}

/** The least effective distance over every route from `from` to `to` that visits no node twice. */
function bruteForceBest(graph: MapGraph, from: NodeId, to: NodeId, stats: PlayerStats): number {
  let best = Number.POSITIVE_INFINITY;
  const visited = new Set<NodeId>([from]);
  const path: NodeId[] = [];
  const walk = (at: NodeId): void => {
    if (at === to) {
      best = Math.min(best, effectiveDistance(stepsOf(graph, path), stats, config));
      return;
    }
    for (const next of neighbours(graph, at)) {
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      walk(next);
      path.pop();
      visited.delete(next);
    }
  };
  walk(from);
  return best;
}

//   0 ── 1 ── 2 ── 3 ── 4 ── 5     plains all the way: 5 steps, 5 stamina
//   └─── 6f ── 7f ── 8f ──────┘    three forest steps and the plains target: 7 stamina
const detour = graphOf(
  ['plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'forest', 'forest', 'forest'],
  [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [0, 6],
    [6, 7],
    [7, 8],
    [8, 5],
  ],
);

describe('bestRoute (Q210, 810 A, 811 A)', () => {
  it('takes the forest on free steps when the player has the forest speed for it', () => {
    expect(shortestPath(detour, n(0), n(5), config)).toEqual([n(1), n(2), n(3), n(4), n(5)]);
    expect(bestRoute(detour, n(0), n(5), speeds(0, 3, 0), config)).toEqual([n(6), n(7), n(8), n(5)]);
  });

  it('keeps the cheapest route by terrain alone for a player with no speeds', () => {
    expect(bestRoute(detour, n(0), n(5), speeds(0, 0, 0), config)).toEqual(shortestPath(detour, n(0), n(5), config));
  });

  it('keeps today’s route when another is only as good, not better', () => {
    // Plains speed 1 and forest speed 1 make both routes worth 9: 5 + 4 and 5 + 2 + 2.
    const stats = speeds(1, 1, 0);
    expect(effectiveDistance({ plains: 5, forest: 0, mountain: 0 }, stats, config)).toBe(
      effectiveDistance({ plains: 1, forest: 3, mountain: 0 }, stats, config),
    );
    expect(bestRoute(detour, n(0), n(5), stats, config)).toEqual([n(1), n(2), n(3), n(4), n(5)]);
  });

  it('is the empty route on the spot, and null where nothing reaches', () => {
    expect(bestRoute(detour, n(3), n(3), speeds(1, 1, 1), config)).toEqual([]);
    const apart = graphOf(['plains', 'plains', 'plains'], [[0, 1]]);
    expect(bestRoute(apart, n(0), n(2), speeds(1, 1, 1), config)).toBeNull();
  });

  it('is exactly today’s route from every node to every node when the player has no speeds', () => {
    const graph = randomGrid('best-route-zero', 7);
    const routes = routeTable(graph, config);
    for (let from = 0; from < graph.nodes.length; from += 5) {
      for (let to = 0; to < graph.nodes.length; to++) {
        expect(bestRoute(graph, n(from), n(to), speeds(0, 0, 0), config)).toEqual(routes.path(n(from), n(to)));
      }
    }
  });

  it('is as good as the best of every route there is, on random terrain and speeds', () => {
    const rng = createRng('best-route-brute-force');
    for (let round = 0; round < 6; round++) {
      const graph = randomGrid(`best-route-${round}`, 4);
      const stats = speeds(rng.nextIntInclusive(0, 3), rng.nextIntInclusive(0, 3), rng.nextIntInclusive(0, 3));
      for (let to = 1; to < graph.nodes.length; to++) {
        const route = bestRoute(graph, n(0), n(to), stats, config) ?? [];
        const today = shortestPath(graph, n(0), n(to), config) ?? [];
        const distance = effectiveDistance(stepsOf(graph, route), stats, config);
        expect(distance).toBe(bruteForceBest(graph, n(0), n(to), stats));
        expect(distance).toBeLessThanOrEqual(effectiveDistance(stepsOf(graph, today), stats, config));
      }
    }
  });

  it('draws the same route whatever order the adjacency lists are in', () => {
    const graph = randomGrid('best-route-order', 6);
    const reversed: MapGraph = { ...graph, adjacency: graph.adjacency.map((list) => [...list].reverse()) };
    const stats = speeds(1, 2, 2);
    for (let to = 0; to < graph.nodes.length; to++) {
      const one = bestRoute(graph, n(0), n(to), stats, config) ?? [];
      const other = bestRoute(reversed, n(0), n(to), stats, config) ?? [];
      expect(effectiveDistance(stepsOf(reversed, other), stats, config)).toBe(effectiveDistance(stepsOf(graph, one), stats, config));
    }
  });
});

describe('RouteTable.routesFrom (Q210)', () => {
  it('starts each node’s routes with one as cheap as any by terrain alone, and keeps none another beats everywhere', () => {
    const graph = randomGrid('route-front', 6);
    const routes = routeTable(graph, config);
    const front = routes.routesFrom(n(0));
    for (let node = 1; node < graph.nodes.length; node++) {
      const first = front.start[node] as number;
      const last = front.start[node + 1] as number;
      expect(last).toBeGreaterThan(first);
      const cost = (entry: number): number =>
        (front.plains[entry] as number) + 2 * (front.forest[entry] as number) + 3 * (front.mountain[entry] as number);
      expect(cost(first)).toBe(routes.from(n(0)).costs[node]);
      for (let a = first; a < last; a++) {
        for (let b = first; b < last; b++) {
          if (a === b) continue;
          const beats =
            (front.plains[a] as number) <= (front.plains[b] as number) &&
            (front.forest[a] as number) <= (front.forest[b] as number) &&
            (front.mountain[a] as number) <= (front.mountain[b] as number);
          expect(beats).toBe(false);
        }
      }
    }
  });
});

describe('bestRouteVia (Q210, 812 A)', () => {
  it('goes through the waypoint, each leg the best for the player’s speeds', () => {
    const stats = speeds(0, 3, 0);
    expect(bestRouteVia(detour, n(0), n(7), n(3), stats, config)).toEqual([
      ...(bestRoute(detour, n(0), n(7), stats, config) ?? []),
      ...(bestRoute(detour, n(7), n(3), stats, config) ?? []),
    ]);
    expect(bestRouteVia(detour, n(0), null, n(5), stats, config)).toEqual(bestRoute(detour, n(0), n(5), stats, config));
  });
});
