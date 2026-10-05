import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET, TERRAINS, type Terrain } from '@adventure/config';
import { asNodeId, createRng, type NodeId } from '@adventure/core';
import {
  areaLabels,
  drawApartGaps,
  rebalanceTerrainShares,
  terrainTargets,
  wouldJoin,
  type KeptApart,
} from './terraingrowth.ts';

/** A path graph, which is the sparsest thing the rebalance ever has to work on. */
function pathAdjacency(count: number): NodeId[][] {
  return Array.from({ length: count }, (_, index) => {
    const neighbours: NodeId[] = [];
    if (index > 0) neighbours.push(asNodeId(index - 1));
    if (index < count - 1) neighbours.push(asNodeId(index + 1));
    return neighbours;
  });
}

function counted(terrain: readonly Terrain[]): Record<Terrain, number> {
  const counts: Record<Terrain, number> = { plains: 0, forest: 0, mountain: 0 };
  for (const value of terrain) counts[value]++;
  return counts;
}

describe('terrainTargets', () => {
  it('sums to the node count exactly, so no terrain can sit a fraction under its share', () => {
    const shares = { plains: 0.45, forest: 0.3, mountain: 0.25 };
    for (const nodeCount of [1, 2, 7, 229, 233, 238, 240, 1001]) {
      const targets = terrainTargets(nodeCount, shares);
      expect(TERRAINS.reduce((sum, terrain) => sum + targets[terrain], 0)).toBe(nodeCount);
    }
  });

  it('is within one node of the exact share', () => {
    const shares = { plains: 0.45, forest: 0.3, mountain: 0.25 };
    const targets = terrainTargets(238, shares);
    for (const terrain of TERRAINS) {
      expect(Math.abs(targets[terrain] - shares[terrain] * 238)).toBeLessThan(1);
    }
  });
});

describe('rebalanceTerrainShares', () => {
  it('moves nodes off the surplus terrain until the shares hold', () => {
    // 20 nodes, all plains but one forest and one mountain at the far end.
    const terrain: Terrain[] = Array.from({ length: 20 }, (_, index) =>
      index === 18 ? 'forest' : index === 19 ? 'mountain' : 'plains',
    );
    const targets = terrainTargets(20, { plains: 0.45, forest: 0.3, mountain: 0.25 });

    rebalanceTerrainShares(terrain, pathAdjacency(20), targets, new Set(), createRng('rebalance'));

    expect(counted(terrain)).toEqual(targets);
  });

  it('leaves a map that already matches its targets alone', () => {
    const terrain: Terrain[] = Array.from({ length: 20 }, (_, index) =>
      index < 9 ? 'plains' : index < 15 ? 'forest' : 'mountain',
    );
    const before = [...terrain];
    const targets = terrainTargets(20, { plains: 0.45, forest: 0.3, mountain: 0.25 });
    expect(counted(terrain)).toEqual(targets);

    rebalanceTerrainShares(terrain, pathAdjacency(20), targets, new Set(), createRng('rebalance'));

    expect(terrain).toEqual(before);
  });

  it('never takes a locked node, even when that is the only way to the target', () => {
    // Forest can only reach plains through node 1, and node 1 is locked, so the
    // shares cannot be met and the pass must stop rather than take it anyway.
    const terrain: Terrain[] = ['plains', 'plains', 'plains', 'plains', 'forest', 'mountain'];
    const locked = new Set<NodeId>([asNodeId(1), asNodeId(2), asNodeId(3)]);
    const targets = terrainTargets(6, { plains: 0.45, forest: 0.3, mountain: 0.25 });

    rebalanceTerrainShares(terrain, pathAdjacency(6), targets, locked, createRng('locked'));

    for (const node of locked) expect(terrain[node]).toBe('plains');
  });

  it('terminates on a map whose terrains cannot reach each other', () => {
    // Two components: nothing plains owns touches forest, so no move is legal.
    const terrain: Terrain[] = ['plains', 'plains', 'plains', 'forest'];
    const adjacency: NodeId[][] = [[asNodeId(1)], [asNodeId(0), asNodeId(2)], [asNodeId(1)], []];
    const targets = terrainTargets(4, { plains: 0.45, forest: 0.3, mountain: 0.25 });

    rebalanceTerrainShares(terrain, adjacency, targets, new Set(), createRng('split'));

    expect(terrain).toEqual(['plains', 'plains', 'plains', 'forest']);
  });

  it('is an exact function of its inputs', () => {
    const build = (): Terrain[] =>
      Array.from({ length: 30 }, (_, index) => (index === 28 ? 'forest' : index === 29 ? 'mountain' : 'plains'));
    const targets = terrainTargets(30, { plains: 0.45, forest: 0.3, mountain: 0.25 });

    const first = build();
    rebalanceTerrainShares(first, pathAdjacency(30), targets, new Set(), createRng('same'));
    const second = build();
    rebalanceTerrainShares(second, pathAdjacency(30), targets, new Set(), createRng('same'));

    expect(first).toEqual(second);
  });
});

describe('keeping areas apart (Q245)', () => {
  const forestOn = (terrain: readonly Terrain[]) => (node: NodeId) => terrain[node] === 'forest';
  const apartOn = (count: number, joinForShares: boolean, gaps: readonly number[] = new Array<number>(count).fill(1)): KeptApart => ({
    ground: pathAdjacency(count),
    terrains: new Set<Terrain>(['forest']),
    gaps,
    joinForShares,
  });

  it('labels each area of a terrain on the ground', () => {
    const terrain: Terrain[] = ['forest', 'forest', 'plains', 'forest', 'plains'];
    expect([...areaLabels(pathAdjacency(5), forestOn(terrain))]).toEqual([0, 0, -1, 1, -1]);
  });

  it('refuses a node that would bring two areas within the gap, and only that node', () => {
    const terrain: Terrain[] = ['forest', 'plains', 'forest', 'plains', 'plains', 'plains', 'forest'];
    const ground = pathAdjacency(7);
    const label = areaLabels(ground, forestOn(terrain));
    expect(wouldJoin(ground, label, asNodeId(1), 1)).toBe(true);
    expect(wouldJoin(ground, label, asNodeId(3), 1)).toBe(false);
    // Two spaces apart: node 4 would leave areas {2} and {6} one space apart.
    expect(wouldJoin(ground, label, asNodeId(4), 1)).toBe(false);
    expect(wouldJoin(ground, label, asNodeId(4), 2)).toBe(true);
  });

  it('grows the area that stays apart rather than the node with more forest neighbours', () => {
    const terrain: Terrain[] = ['forest', 'plains', 'forest', 'plains', 'plains'];
    const targets = { plains: 2, forest: 3, mountain: 0 };
    rebalanceTerrainShares(terrain, pathAdjacency(5), targets, new Set(), createRng('apart'), apartOn(5, true));
    expect(terrain).toEqual(['forest', 'plains', 'forest', 'forest', 'plains']);
  });

  it("reads each node's own gap, so one node refuses what its neighbour would take (917)", () => {
    // Forest at both ends of a path. Nodes 1 and 3 each touch one forest area;
    // a gap of 3 reaches the other area as well, a gap of 1 does not.
    const targets = { plains: 2, forest: 3, mountain: 0 };
    const start = (): Terrain[] => ['forest', 'plains', 'plains', 'plains', 'forest'];

    const right = start();
    rebalanceTerrainShares(right, pathAdjacency(5), targets, new Set(), createRng('gaps'), apartOn(5, false, [1, 3, 1, 1, 1]));
    expect(right).toEqual(['forest', 'plains', 'plains', 'forest', 'forest']);

    const left = start();
    rebalanceTerrainShares(left, pathAdjacency(5), targets, new Set(), createRng('gaps'), apartOn(5, false, [1, 1, 1, 3, 1]));
    expect(left).toEqual(['forest', 'forest', 'plains', 'plains', 'forest']);
  });

  it('draws one gap per space within KEPT_APART.GAP, and nothing at all when it names no terrain', () => {
    const map = DEFAULT_RULESET.config.map;
    const gaps = drawApartGaps(map, 240, createRng('draw'));
    expect(gaps).toHaveLength(240);
    expect(new Set(gaps)).toEqual(new Set([1, 2, 3]));

    const rng = createRng('draw');
    expect(drawApartGaps({ ...map, KEPT_APART: { ...map.KEPT_APART, TERRAINS: [] } }, 240, rng)).toEqual([]);
    expect(rng.nextUint32()).toBe(createRng('draw').nextUint32());
  });

  it('joins two areas for the shares only when JOIN_FOR_SHARES allows it (916)', () => {
    const start: Terrain[] = ['forest', 'plains', 'forest'];
    const targets = { plains: 0, forest: 3, mountain: 0 };

    const kept = [...start];
    rebalanceTerrainShares(kept, pathAdjacency(3), targets, new Set(), createRng('apart'), apartOn(3, false));
    expect(kept).toEqual(start);

    const joined = [...start];
    rebalanceTerrainShares(joined, pathAdjacency(3), targets, new Set(), createRng('apart'), apartOn(3, true));
    expect(joined).toEqual(['forest', 'forest', 'forest']);
  });
});
