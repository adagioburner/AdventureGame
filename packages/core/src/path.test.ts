import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type Terrain } from '@adventure/config';
import { asNodeId, type NodeId } from './ids.ts';
import type { MapGraph } from './graph.ts';
import { createRng } from './rng.ts';
import { dijkstra, pathCost, routeTable, routeVia, shareRouteTable, shortestPath, stepCost, terrainStepCost, workOutAllRoutes } from './path.ts';

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

const n = (value: number): NodeId => asNodeId(value);

describe('terrainStepCost', () => {
  it('is the §11 STAMINA_COST table', () => {
    expect(terrainStepCost('plains', config)).toBe(1);
    expect(terrainStepCost('forest', config)).toBe(2);
    expect(terrainStepCost('mountain', config)).toBe(3);
  });

  it('charges for the node being entered, not the one being left', () => {
    // §8's worked example turns on this: a step onto forest is a forest step.
    const graph = graphOf(['plains', 'forest'], [[0, 1]]);
    expect(stepCost(graph, n(1), config)).toBe(2);
    expect(stepCost(graph, n(0), config)).toBe(1);
  });
});

describe('shortestPath', () => {
  it('prefers the longer route when it is cheaper, so a hop count cannot stand in for it', () => {
    //   0 ── 1(mountain) ── 4     two hops, 3 + 1 = 4
    //   0 ── 2 ── 3 ── 4          three hops, 1 + 1 + 1 = 3
    const graph = graphOf(
      ['plains', 'mountain', 'plains', 'plains', 'plains'],
      [
        [0, 1],
        [1, 4],
        [0, 2],
        [2, 3],
        [3, 4],
      ],
    );
    const path = shortestPath(graph, n(0), n(4), config);
    expect(path).toEqual([n(2), n(3), n(4)]);
    expect(pathCost(graph, path ?? [], config)).toBe(3);
  });

  it('breaks a tie the same way whatever order the adjacency lists are in', () => {
    // 0 ── 1 ── 3 and 0 ── 2 ── 3, both plains, both cost 2.
    const forward = graphOf(
      ['plains', 'plains', 'plains', 'plains'],
      [
        [0, 1],
        [0, 2],
        [1, 3],
        [2, 3],
      ],
    );
    const reversed: MapGraph = {
      ...forward,
      adjacency: forward.adjacency.map((list) => [...list].reverse()),
    };
    expect(shortestPath(forward, n(0), n(3), config)).toEqual([n(1), n(3)]);
    expect(shortestPath(reversed, n(0), n(3), config)).toEqual([n(1), n(3)]);
  });

  it('returns null for an unreachable target', () => {
    const graph = graphOf(['plains', 'plains', 'plains'], [[0, 1]]);
    expect(shortestPath(graph, n(0), n(2), config)).toBeNull();
  });

  it('is the empty path from a node to itself', () => {
    const graph = graphOf(['plains', 'plains'], [[0, 1]]);
    expect(shortestPath(graph, n(0), n(0), config)).toEqual([]);
  });

  it('agrees with pathCost summed over stepCost', () => {
    const graph = graphOf(
      ['plains', 'forest', 'mountain', 'plains'],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );
    const path = shortestPath(graph, n(0), n(3), config) ?? [];
    const summed = path.reduce((total, node) => total + stepCost(graph, node, config), 0);
    expect(pathCost(graph, path, config)).toBe(summed);
    expect(summed).toBe(2 + 3 + 1);
  });
});

describe('dijkstra', () => {
  it('settles ascending by (cost, node id)', () => {
    const graph = graphOf(
      ['plains', 'plains', 'plains', 'forest'],
      [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    );
    expect(dijkstra(graph, n(0), config).settled).toEqual([n(0), n(1), n(2), n(3)]);
  });

  it('stops early when asked, leaving the rest unsettled', () => {
    const graph = graphOf(
      ['plains', 'plains', 'plains'],
      [
        [0, 1],
        [1, 2],
      ],
    );
    const result = dijkstra(graph, n(0), config, { stopWhen: (node) => node === n(1) });
    expect(result.settled).toEqual([n(0), n(1)]);
  });
});

describe('routeVia', () => {
  it('is the path to the waypoint followed by the path onward', () => {
    const graph = graphOf(
      ['plains', 'plains', 'plains', 'plains'],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );
    expect(routeVia(graph, n(0), n(2), n(1), config)).toEqual([n(1), n(2), n(1)]);
  });

  it('is the plain shortest path when there is no waypoint', () => {
    const graph = graphOf(['plains', 'plains'], [[0, 1]]);
    expect(routeVia(graph, n(0), null, n(1), config)).toEqual([n(1)]);
  });
});

describe('routeTable', () => {
  /** A seeded jumble of plains, forest and mountain with plenty of equal-cost routes. */
  function jumble(seed: string, size: number): MapGraph {
    const rng = createRng(seed);
    const terrains: Terrain[] = Array.from({ length: size }, () => rng.pick(['plains', 'forest', 'mountain'] as const));
    const edges: [number, number][] = [];
    for (let node = 1; node < size; node++) edges.push([node, rng.nextInt(node)]);
    for (let extra = 0; extra < size / 2; extra++) {
      const a = rng.nextInt(size);
      const b = rng.nextInt(size);
      if (a !== b) edges.push([a, b]);
    }
    return graphOf(terrains, edges);
  }

  it('gives exactly the routes and search order shortestPath and dijkstra give', () => {
    for (const seed of ['a', 'b', 'c']) {
      const graph = jumble(seed, 60);
      const table = routeTable(graph, config);
      for (let from = 0; from < 60; from++) {
        const whole = dijkstra(graph, n(from), config);
        expect(table.from(n(from)).settled).toEqual(whole.settled);
        expect(table.from(n(from)).costs).toEqual(whole.costs);
        for (let to = 0; to < 60; to++) {
          expect(table.path(n(from), n(to))).toEqual(shortestPath(graph, n(from), n(to), config));
        }
      }
    }
  });

  it('reports an unreachable node as shortestPath does', () => {
    const graph = graphOf(['plains', 'plains', 'plains'], [[0, 1]]);
    expect(routeTable(graph, config).path(n(0), n(2))).toBeNull();
    expect(routeTable(graph, config).path(n(2), n(2))).toEqual([]);
  });

  it('searches once per map, from every node at the first call', () => {
    const graph = jumble('d', 20);
    const table = routeTable(graph, config);
    expect(routeTable(graph, config)).toBe(table);
    expect(table.from(n(3))).toBe(table.from(n(3)));
    expect(routeTable(jumble('d', 20), config)).not.toBe(table);
    expect(() => table.from(n(20))).toThrow(RangeError);
  });

  it('works out every route list at once, the same lists as asked one by one (Q235)', () => {
    const graph = jumble('e', 30);
    workOutAllRoutes(graph, config);
    const built = routeTable(graph, config);
    const asked = routeTable(jumble('e', 30), config);
    for (let from = 0; from < 30; from++) expect(built.routesFrom(n(from))).toEqual(asked.routesFrom(n(from)));
  });

  it('shares a table, route lists and all, with a copy of the same map (Q235)', () => {
    const graph = jumble('f', 30);
    const table = routeTable(graph, config);
    const lists = table.routesFrom(n(4));
    // As an online game's map arrives from the server.
    const copy = JSON.parse(JSON.stringify(graph)) as MapGraph;
    const copyConfig = JSON.parse(JSON.stringify(config)) as typeof config;
    expect(shareRouteTable(graph, config, copy, copyConfig)).toBe(true);
    expect(routeTable(copy, copyConfig)).toBe(table);
    expect(routeTable(copy, copyConfig).routesFrom(n(4))).toBe(lists);
    expect(shareRouteTable(graph, config, copy, copyConfig)).toBe(true);
  });

  it('shares nothing with another map, other step costs, or a map with a table of its own (Q235)', () => {
    const graph = jumble('g', 30);
    expect(shareRouteTable(graph, config, jumble('g', 30), config)).toBe(false);
    const table = routeTable(graph, config);

    const other = jumble('h', 30);
    expect(shareRouteTable(graph, config, other, config)).toBe(false);
    expect(routeTable(other, config)).not.toBe(table);

    const pricier = { ...config, movement: { ...config.movement, STAMINA_COST: { ...config.movement.STAMINA_COST, forest: 5 } } };
    const copy = JSON.parse(JSON.stringify(graph)) as MapGraph;
    expect(shareRouteTable(graph, config, copy, pricier)).toBe(false);
    expect(routeTable(copy, pricier)).not.toBe(table);

    const own = jumble('g', 30);
    const ownTable = routeTable(own, config);
    expect(shareRouteTable(graph, config, own, config)).toBe(false);
    expect(routeTable(own, config)).toBe(ownTable);

    // The same roads listed in another order find equal-cost routes in another order.
    const crossing = graph.adjacency.findIndex((next) => next.length >= 2);
    const rewired = JSON.parse(JSON.stringify(graph)) as { adjacency: number[][] };
    rewired.adjacency[crossing] = [...(rewired.adjacency[crossing] ?? [])].reverse();
    expect(shareRouteTable(graph, config, rewired as unknown as MapGraph, config)).toBe(false);
  });
});
