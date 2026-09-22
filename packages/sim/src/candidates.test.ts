import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type GameConfig, type Terrain } from '@adventure/config';
import { asNodeId, createRng, type MapGraph, type NodeId } from '@adventure/core';
import { chooseWalkTarget, closestPoiCandidates } from './candidates.ts';

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

/** 0 ─ 1 ─ 2 ─ 3 ─ 4, all plains, so cost is the hop count. */
const line = graphOf(
  ['plains', 'plains', 'plains', 'plains', 'plains'],
  [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ],
);

function withK(k: number): GameConfig {
  return { ...DEFAULT_GAME_CONFIG, balancing: { ...DEFAULT_GAME_CONFIG.balancing, CLOSE_CANDIDATE_COUNT: k } };
}

describe('closestPoiCandidates', () => {
  it('returns the K cheapest eligible POIs, ascending by cost', () => {
    const found = closestPoiCandidates(line, n(0), new Set([n(2), n(3), n(4)]), withK(2));
    expect(found).toEqual([
      { node: n(2), cost: 2 },
      { node: n(3), cost: 3 },
    ]);
  });

  it('returns fewer than K when fewer remain eligible', () => {
    expect(closestPoiCandidates(line, n(0), new Set([n(4)]), withK(10))).toEqual([{ node: n(4), cost: 4 }]);
  });

  it('is empty when nothing is eligible', () => {
    expect(closestPoiCandidates(line, n(0), new Set(), withK(10))).toEqual([]);
  });

  it('counts the origin itself, at cost 0, when it is eligible', () => {
    // The first leg of a §5.1 walk starts at a random plains node that may
    // happen to be an unvisited POI; the walk only moves away from where it
    // stands, so skipping it would strand that POI.
    const found = closestPoiCandidates(line, n(0), new Set([n(0), n(2)]), withK(10));
    expect(found[0]).toEqual({ node: n(0), cost: 0 });
  });

  it('ranks by weighted terrain cost, not by hops', () => {
    //  0 ─ 1(mountain) ─ 2   cost 3 + 1 = 4 to node 2
    //  0 ─ 3 ─ 4             cost 1 + 1 = 2 to node 4
    const graph = graphOf(
      ['plains', 'mountain', 'plains', 'plains', 'plains'],
      [
        [0, 1],
        [1, 2],
        [0, 3],
        [3, 4],
      ],
    );
    expect(closestPoiCandidates(graph, n(0), new Set([n(2), n(4)]), withK(10))).toEqual([
      { node: n(4), cost: 2 },
      { node: n(2), cost: 4 },
    ]);
  });

  it('breaks equal costs by the lower node id', () => {
    // 1 and 2 are both one plains step from 0.
    const graph = graphOf(
      ['plains', 'plains', 'plains'],
      [
        [0, 1],
        [0, 2],
      ],
    );
    expect(closestPoiCandidates(graph, n(0), new Set([n(1), n(2)]), withK(10)).map((c) => c.node)).toEqual([
      n(1),
      n(2),
    ]);
  });
});

describe('chooseWalkTarget', () => {
  it('picks uniformly among the K closest and nothing outside them', () => {
    const seen = new Set<NodeId>();
    for (let run = 0; run < 50; run++) {
      const target = chooseWalkTarget(line, n(0), new Set([n(1), n(2), n(3), n(4)]), withK(2), createRng(`r${run}`));
      expect(target).not.toBeNull();
      seen.add((target as { node: NodeId }).node);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([n(1), n(2)]);
  });

  it('is null when nothing is eligible', () => {
    expect(chooseWalkTarget(line, n(0), new Set(), withK(10), createRng('x'))).toBeNull();
  });
});
