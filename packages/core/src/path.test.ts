import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type Terrain } from '@adventure/config';
import { asNodeId, type NodeId } from './ids.ts';
import type { MapGraph } from './graph.ts';
import { dijkstra, pathCost, routeVia, shortestPath, stepCost, terrainStepCost } from './path.ts';

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
