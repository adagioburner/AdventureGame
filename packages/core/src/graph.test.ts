import { describe, expect, it } from 'vitest';

import type { Terrain } from '@adventure/config';
import {
  compactness,
  degree,
  isConnected,
  isLeaf,
  leafNodes,
  meetsCompactnessTarget,
  neighbours,
  regionMetrics,
  terrainCompactness,
  terrainNodes,
  terrainRegions,
  type MapGraph,
} from './graph.ts';
import { asNodeId } from './ids.ts';

/**
 * Builds a graph from an edge list. Positions are irrelevant to every function
 * under test — the graph predicates are topological — so they are laid out on a
 * line just to be well-formed.
 */
function graphOf(terrains: readonly Terrain[], edges: readonly (readonly [number, number])[]): MapGraph {
  const adjacency: number[][] = terrains.map(() => []);
  for (const [a, b] of edges) {
    (adjacency[a] as number[]).push(b);
    (adjacency[b] as number[]).push(a);
  }
  return {
    nodes: terrains.map((terrain, i) => ({ id: asNodeId(i), position: { x: i, y: 0 }, terrain })),
    edges: edges.map(([a, b]) => ({ a: asNodeId(a), b: asNodeId(b) })),
    adjacency: adjacency.map((list) => list.map(asNodeId)),
  };
}

/** 0 — 1 — 2 — 3 — 4, terrains plains, forest, forest, forest, plains. */
const path = graphOf(
  ['plains', 'forest', 'forest', 'forest', 'plains'],
  [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ],
);

describe('adjacency helpers', () => {
  it('reads neighbours and degree', () => {
    expect(neighbours(path, asNodeId(1))).toEqual([asNodeId(0), asNodeId(2)]);
    expect(degree(path, asNodeId(1))).toBe(2);
    expect(degree(path, asNodeId(0))).toBe(1);
  });

  it('treats an unknown node as having no neighbours', () => {
    expect(neighbours(path, asNodeId(99))).toEqual([]);
    expect(degree(path, asNodeId(99))).toBe(0);
  });
});

describe('leaves', () => {
  it('finds the degree-1 nodes', () => {
    // [SOURCE §1] "no dead ends", so every leaf becomes a POI (§3) — which
    // makes `leafNodes` the input to step 7's quota arithmetic.
    expect(isLeaf(path, asNodeId(0))).toBe(true);
    expect(isLeaf(path, asNodeId(1))).toBe(false);
    expect(leafNodes(path)).toEqual([asNodeId(0), asNodeId(4)]);
  });
});

describe('isConnected', () => {
  it('accepts a connected graph', () => {
    expect(isConnected(path)).toBe(true);
  });

  it('rejects a graph in two components', () => {
    // §2.1 steps 3 and 8 both reject this.
    const split = graphOf(
      ['plains', 'plains', 'forest', 'forest'],
      [
        [0, 1],
        [2, 3],
      ],
    );
    expect(isConnected(split)).toBe(false);
  });

  it('rejects a graph with one isolated node', () => {
    const stray = graphOf(['plains', 'plains', 'plains'], [[0, 1]]);
    expect(isConnected(stray)).toBe(false);
  });

  it('treats the empty graph as connected', () => {
    expect(isConnected(graphOf([], []))).toBe(true);
  });
});

describe('compactness', () => {
  it('counts area as nodes and boundary as nodes touching another terrain', () => {
    // [SOURCE §2.1 step 5, chat] "Yes, counting nodes is the right approach."
    // In the path, {0, 1}: node 0's only neighbour is inside, node 1 touches
    // node 2 which is outside. So area 2, boundary 1.
    const metrics = regionMetrics(path, new Set([asNodeId(0), asNodeId(1)]));
    expect(metrics).toEqual({ area: 2, boundary: 1 });
    expect(compactness(metrics)).toBeCloseTo(0.5);
  });

  it('counts a node at most once however many outside neighbours it has', () => {
    // A star: the centre touches three outside nodes but is one boundary node.
    const star = graphOf(
      ['plains', 'forest', 'forest', 'forest'],
      [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    );
    expect(regionMetrics(star, new Set([asNodeId(0)]))).toEqual({ area: 1, boundary: 1 });
  });

  it('scores a fully-bounded region at its node count', () => {
    // Documented in graph.ts: where every node touches another terrain,
    // boundary equals area, so compactness equals the node count.
    expect(terrainCompactness(path, 'plains')).toEqual([1, 1]);
  });
});

describe('terrain regions', () => {
  it('collects every node of a terrain across regions', () => {
    expect(terrainNodes(path, 'plains')).toEqual(new Set([asNodeId(0), asNodeId(4)]));
  });

  it('splits one terrain into its connected components', () => {
    // §2.1 step 4 seeds "1 or 2 seeds per terrain", so two regions of one
    // terrain is legitimate and step 5 measures each separately.
    const regions = terrainRegions(path, 'plains');
    expect(regions).toHaveLength(2);
    expect(regions.map((region) => region.size)).toEqual([1, 1]);

    const forest = terrainRegions(path, 'forest');
    expect(forest).toHaveLength(1);
    expect(forest[0]).toEqual(new Set([asNodeId(1), asNodeId(2), asNodeId(3)]));
  });

  it('returns no regions for an absent terrain', () => {
    expect(terrainRegions(path, 'mountain')).toEqual([]);
  });
});

describe('meetsCompactnessTarget', () => {
  it('passes when every component is under the maximum', () => {
    expect(meetsCompactnessTarget(path, 'plains', 25)).toBe(true);
  });

  it('fails when any single component is over it', () => {
    // The two plains components score 1 each; a maximum of 1 is not "under".
    expect(meetsCompactnessTarget(path, 'plains', 1)).toBe(false);
  });

  it('passes vacuously for a terrain with no nodes', () => {
    expect(meetsCompactnessTarget(path, 'mountain', 25)).toBe(true);
  });
});
