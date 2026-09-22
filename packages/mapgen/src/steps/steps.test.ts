import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET, TERRAINS, type Ruleset, type Terrain } from '@adventure/config';
import { asNodeId, createRng, isConnected, isLeaf, leafNodes, type NodeId } from '@adventure/core';
import { defaultRemotenessScorer } from '@adventure/sim';
import { draftAsGraph, rebuildAdjacency } from '../graphops.ts';
import { emptyDraft } from '../pipeline.ts';
import type { GenerationContext, MapDraft } from '../types.ts';
import { sampleStep } from './1-sample.ts';
import { triangulateStep } from './2-triangulate.ts';
import { pruneStep } from './3-prune.ts';
import { seedTerrainStep } from './4-seed-terrain.ts';
import { meetsCompactness, smoothStep } from './5-smooth.ts';
import { carveValleysStep } from './6-carve-valleys.ts';
import { placePoisStep } from './7-place-pois.ts';
import { validateStep } from './8-validate.ts';

function contextOf(seed: string, ruleset: Ruleset = DEFAULT_RULESET): GenerationContext {
  return { ruleset, rng: createRng(seed), seed, remotenessScorer: defaultRemotenessScorer };
}

/** Run the pipeline from step 1 up to and including `last`, and hand back the draft. */
function draftAfter(last: string, seed: string, ruleset: Ruleset = DEFAULT_RULESET): MapDraft {
  const steps = [
    sampleStep,
    triangulateStep,
    pruneStep,
    seedTerrainStep,
    smoothStep,
    carveValleysStep,
    placePoisStep,
    validateStep,
  ];
  const draft = emptyDraft();
  const context = contextOf(seed, ruleset);
  for (const step of steps) {
    step.run(draft, context);
    if (step.id === last) break;
  }
  return draft;
}

/** A draft built by hand, for the cases a generated map will not reliably produce. */
function handBuilt(terrains: readonly Terrain[], edges: readonly (readonly [number, number])[]): MapDraft {
  const draft = emptyDraft();
  draft.positions = terrains.map((_, index) => ({ x: index * 100, y: 0 }));
  draft.terrain = [...terrains];
  draft.edges = edges.map(([a, b]) => ({ a: asNodeId(a), b: asNodeId(b) }));
  rebuildAdjacency(draft);
  return draft;
}

describe('step 1 — Poisson-disc sampling', () => {
  it('is an exact function of the seed', () => {
    expect(draftAfter('1-sample', 'adventure').positions).toEqual(draftAfter('1-sample', 'adventure').positions);
  });

  it('draws a different map from a different seed', () => {
    expect(draftAfter('1-sample', 'adventure').positions).not.toEqual(draftAfter('1-sample', 'other').positions);
  });

  it('lands near MAP_NODE_COUNT', () => {
    const { MAP_NODE_COUNT } = DEFAULT_RULESET.config.map;
    for (const seed of ['adventure', 'alpha', 'beta', 'gamma']) {
      const count = draftAfter('1-sample', seed).positions.length;
      // "~240 points" — Poisson-disc yield is a distribution, so this asserts
      // the calibration of POISSON_RADIUS_FACTOR, not an exact count.
      expect(count).toBeGreaterThan(MAP_NODE_COUNT * 0.9);
      expect(count).toBeLessThan(MAP_NODE_COUNT * 1.1);
    }
  });

  it('keeps every point inside the map rectangle and no two points closer than the disc radius', () => {
    const { MAP_COORDINATE_SPACE, MAP_NODE_COUNT } = DEFAULT_RULESET.config.map;
    const radius =
      Math.sqrt((MAP_COORDINATE_SPACE * MAP_COORDINATE_SPACE) / MAP_NODE_COUNT) *
      DEFAULT_RULESET.engineering.POISSON_RADIUS_FACTOR;
    const points = draftAfter('1-sample', 'adventure').positions;

    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThan(MAP_COORDINATE_SPACE);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThan(MAP_COORDINATE_SPACE);
    }
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i] as { x: number; y: number };
        const b = points[j] as { x: number; y: number };
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    expect(closest).toBeGreaterThanOrEqual(radius);
  });
});

describe('step 2 — Delaunay triangulation', () => {
  it('produces a connected graph with each edge listed once, low id first', () => {
    const draft = draftAfter('2-triangulate', 'adventure');
    expect(isConnected(draftAsGraph(draft))).toBe(true);
    const keys = draft.edges.map((edge) => `${edge.a}-${edge.b}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const edge of draft.edges) expect(edge.a).toBeLessThan(edge.b);
  });

  it('gives roughly 3n edges, which is what step 3 then prunes down', () => {
    const draft = draftAfter('2-triangulate', 'adventure');
    expect(draft.edges.length).toBeGreaterThan(draft.positions.length * 2);
    expect(draft.edges.length).toBeLessThan(draft.positions.length * 3);
  });
});

describe('step 3 — prune to budget', () => {
  it('reaches MAP_EDGE_COUNT, stays connected and respects the leaf ceiling', () => {
    const { MAP_EDGE_COUNT, LEAF_COUNT } = DEFAULT_RULESET.config.map;
    for (const seed of ['adventure', 'alpha', 'beta']) {
      const draft = draftAfter('3-prune', seed);
      expect(draft.edges.length).toBe(MAP_EDGE_COUNT);
      expect(isConnected(draftAsGraph(draft))).toBe(true);
      expect(leafNodes(draftAsGraph(draft)).length).toBeLessThanOrEqual(LEAF_COUNT.max);
    }
  });

  it('skips a removal that would disconnect the graph rather than abandoning the attempt', () => {
    // A tight triangle 0-1-2 with node 3 hanging off 0 by a much longer edge.
    // That long edge is the first candidate and is also the only bridge, so it
    // has to be skipped and the pruning has to carry on with a triangle edge.
    const draft = emptyDraft();
    draft.positions = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
      { x: 1000, y: 0 },
    ];
    draft.terrain = ['plains', 'plains', 'plains', 'plains'];
    draft.edges = [
      { a: asNodeId(0), b: asNodeId(1) },
      { a: asNodeId(0), b: asNodeId(2) },
      { a: asNodeId(0), b: asNodeId(3) },
      { a: asNodeId(1), b: asNodeId(2) },
    ];
    rebuildAdjacency(draft);

    const ruleset: Ruleset = {
      ...DEFAULT_RULESET,
      config: {
        ...DEFAULT_RULESET.config,
        map: { ...DEFAULT_RULESET.config.map, MAP_EDGE_COUNT: 3, LEAF_COUNT: { min: 0, max: 4 } },
      },
    };
    pruneStep.run(draft, contextOf('prune', ruleset));

    expect(draft.edges.length).toBe(3);
    expect(isConnected(draftAsGraph(draft))).toBe(true);
    expect(draft.edges).toContainEqual({ a: asNodeId(0), b: asNodeId(3) });
  });

  it('never breaks the leaf ceiling, whatever that costs the edge budget', () => {
    // With a ceiling of zero, no removal that would create a dead end is
    // allowed at all, so the finished graph has none. Whether the budget is
    // still reachable under that ceiling is incidental; refusing the removal
    // is the contract.
    const ruleset: Ruleset = {
      ...DEFAULT_RULESET,
      config: {
        ...DEFAULT_RULESET.config,
        map: { ...DEFAULT_RULESET.config.map, LEAF_COUNT: { min: 0, max: 0 } },
      },
    };
    const draft = draftAfter('3-prune', 'adventure', ruleset);
    expect(leafNodes(draftAsGraph(draft)).length).toBe(0);
    expect(isConnected(draftAsGraph(draft))).toBe(true);
    expect(draft.edges.length).toBeGreaterThanOrEqual(DEFAULT_RULESET.config.map.MAP_EDGE_COUNT);
  });
});

describe('step 4 — seed terrain regions', () => {
  it('assigns every node one of the three terrains', () => {
    const draft = draftAfter('4-seed-terrain', 'adventure');
    expect(draft.terrain).toHaveLength(draft.positions.length);
    for (const terrain of draft.terrain) expect(TERRAINS).toContain(terrain);
  });

  it('puts all three terrains on the map', () => {
    for (const seed of ['adventure', 'alpha', 'beta', 'gamma']) {
      const draft = draftAfter('4-seed-terrain', seed);
      for (const terrain of TERRAINS) expect(draft.terrain).toContain(terrain);
    }
  });

  it('lands on TERRAIN_AREA_SHARE on average', () => {
    // Per map the shares vary widely — a region can be sealed off early on a
    // graph this sparse — so the target is a property of the distribution, as
    // §2.1's "approximately" implies. `pnpm map:batch` is where this is read.
    const seeds = Array.from({ length: 12 }, (_, index) => `share-${index}`);
    const totals: Record<Terrain, number> = { plains: 0, forest: 0, mountain: 0 };
    for (const seed of seeds) {
      const draft = draftAfter('4-seed-terrain', seed);
      for (const terrain of TERRAINS) {
        totals[terrain] += draft.terrain.filter((value) => value === terrain).length / draft.terrain.length;
      }
    }
    for (const terrain of TERRAINS) {
      const mean = totals[terrain] / seeds.length;
      expect(mean).toBeGreaterThan(DEFAULT_RULESET.config.map.TERRAIN_AREA_SHARE[terrain] - 0.07);
      expect(mean).toBeLessThan(DEFAULT_RULESET.config.map.TERRAIN_AREA_SHARE[terrain] + 0.07);
    }
  }, 20000);
});

describe('step 5 — smooth', () => {
  /** A ruleset whose compactness target can never be met, so the flip loop runs. */
  const alwaysSmooth: Ruleset = {
    ...DEFAULT_RULESET,
    config: { ...DEFAULT_RULESET.config, map: { ...DEFAULT_RULESET.config.map, COMPACTNESS_MAX: 0 } },
  };

  it('flips an outvoted node to its majority-neighbour terrain', () => {
    // Node 0 is forest with three plains neighbours and nothing else.
    const draft = handBuilt(
      ['forest', 'plains', 'plains', 'plains'],
      [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    );
    smoothStep.run(draft, contextOf('smooth', alwaysSmooth));
    expect(draft.terrain[0]).toBe('plains');
  });

  it('leaves a node alone when nothing outvotes its own terrain', () => {
    const draft = handBuilt(
      ['forest', 'forest', 'plains'],
      [
        [0, 1],
        [0, 2],
      ],
    );
    smoothStep.run(draft, contextOf('smooth', alwaysSmooth));
    expect(draft.terrain[0]).toBe('forest');
  });

  it('stops as soon as no node is outvoted, rather than oscillating', () => {
    // Two forest nodes and two plains nodes in a ring: nobody is outvoted, so
    // one pass changes nothing and the loop ends even though the impossible
    // compactness target is still unmet.
    const draft = handBuilt(
      ['forest', 'forest', 'plains', 'plains'],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
    );
    smoothStep.run(draft, contextOf('smooth', alwaysSmooth));
    expect(draft.terrain).toEqual(['forest', 'forest', 'plains', 'plains']);
  });

  it('leaves every terrain component under COMPACTNESS_MAX on a real map', () => {
    for (const seed of ['adventure', 'alpha', 'beta']) {
      const draft = draftAfter('5-smooth', seed);
      expect(meetsCompactness(draft, DEFAULT_RULESET.config.map.COMPACTNESS_MAX)).toBe(true);
    }
  });

  it('does nothing at the default COMPACTNESS_MAX, because a pruned map is already under it', () => {
    // Worth pinning down rather than leaving as folklore. §2.1 says to flip
    // "until compactness falls below COMPACTNESS_MAX", and on a graph of ~240
    // nodes and 300 edges — mean degree 2.5, so nearly a tree — a terrain
    // region's boundary is a handful of nodes and `boundary²/area` comes out
    // around 1, against a `COMPACTNESS_MAX` of 25. The condition holds before
    // the loop starts, so the step is a no-op. `pnpm map:batch` reports the
    // compactness it actually measures; the threshold is §11-tunable.
    const before = draftAfter('4-seed-terrain', 'adventure');
    const after = draftAfter('5-smooth', 'adventure');
    expect(after.terrain).toEqual(before.terrain);
    expect(meetsCompactness(before, DEFAULT_RULESET.config.map.COMPACTNESS_MAX)).toBe(true);
  });

  it('draws nothing from the PRNG, so the steps after it are unaffected by how much it flips', () => {
    const draft = draftAfter('4-seed-terrain', 'adventure');
    const context = contextOf('smooth', alwaysSmooth);
    smoothStep.run(draft, context);
    expect(context.rng.nextUint32()).toBe(createRng('smooth').nextUint32());
  });
});

describe('step 6 — carve valleys', () => {
  it('records every carved node, all of them now plains and none of them plains before', () => {
    const before = draftAfter('5-smooth', 'adventure');
    const nonPlainsBefore = new Set<number>();
    before.terrain.forEach((terrain, index) => {
      if (terrain !== 'plains') nonPlainsBefore.add(index);
    });

    const after = draftAfter('6-carve-valleys', 'adventure');
    expect(after.valleyNodes.size).toBeGreaterThan(0);
    for (const node of after.valleyNodes) {
      expect(after.terrain[node]).toBe('plains');
      expect(nonPlainsBefore.has(node)).toBe(true);
    }
  });

  it('carves no more than VALLEY_COUNT.max fingers of VALLEY_LENGTH.max nodes', () => {
    const { VALLEY_COUNT, VALLEY_LENGTH } = DEFAULT_RULESET.config.map;
    for (const seed of ['adventure', 'alpha', 'beta', 'gamma']) {
      const draft = draftAfter('6-carve-valleys', seed);
      expect(draft.valleyNodes.size).toBeLessThanOrEqual(VALLEY_COUNT.max * VALLEY_LENGTH.max);
    }
  });

  it('keeps each finger one node wide: a carved node touches at most one other carved node it came from', () => {
    const draft = draftAfter('6-carve-valleys', 'adventure');
    for (const node of draft.valleyNodes) {
      const carvedNeighbours = (draft.adjacency[node] ?? []).filter((neighbour) =>
        draft.valleyNodes.has(neighbour),
      );
      // A finger is a path, so an interior node has two carved neighbours and
      // the two ends have one. Three would be a fork, i.e. two nodes wide.
      expect(carvedNeighbours.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('step 7 — place POIs', () => {
  it('makes every leaf node a POI, with no dead ends left over', () => {
    for (const seed of ['adventure', 'alpha', 'beta']) {
      const draft = draftAfter('7-place-pois', seed);
      const graph = draftAsGraph(draft);
      const pois = new Set<NodeId>(draft.poiNodes);
      for (const leaf of leafNodes(graph)) expect(pois.has(leaf)).toBe(true);
    }
  }, 20000);

  it('gives each terrain its POI_COUNT quota plus its surplus leaves', () => {
    const draft = draftAfter('7-place-pois', 'adventure');
    const graph = draftAsGraph(draft);
    for (const terrain of TERRAINS) {
      const quota = DEFAULT_RULESET.config.pois.POI_COUNT[terrain];
      const placed = draft.poiNodes.filter((node) => draft.terrain[node] === terrain);
      const leaves = placed.filter((node) => isLeaf(graph, node)).length;
      const allLeaves = leafNodes(graph).filter((node) => draft.terrain[node] === terrain).length;
      expect(leaves).toBe(allLeaves);
      expect(placed.length).toBe(quota + Math.max(0, allLeaves - quota));
    }
  }, 20000);

  it('lists each POI once, ascending', () => {
    const draft = draftAfter('7-place-pois', 'adventure');
    expect(new Set(draft.poiNodes).size).toBe(draft.poiNodes.length);
    expect([...draft.poiNodes].sort((a, b) => a - b)).toEqual(draft.poiNodes);
  }, 20000);
});

describe('step 8 — validate', () => {
  it('rejects a disconnected graph', () => {
    const draft = handBuilt(['plains', 'plains', 'plains', 'plains'], [[0, 1]]);
    expect(() => validateStep.run(draft, contextOf('v'))).toThrow(/disconnected/);
  });

  it('rejects a leaf count outside LEAF_COUNT', () => {
    const draft = handBuilt(
      ['plains', 'plains', 'plains'],
      [
        [0, 1],
        [1, 2],
      ],
    );
    expect(() => validateStep.run(draft, contextOf('v'))).toThrow(/leaf_count_out_of_range/);
  });

  it('does not re-check compactness, which step 6 has just made worse on purpose', () => {
    // A 1-node-wide plains finger of 6 nodes: boundary equals area, so its
    // compactness is 6 — well above what a rounded region scores, and this
    // step must still pass it.
    const terrains: Terrain[] = ['forest', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'forest'];
    const draft = handBuilt(terrains, [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
    ]);
    const ruleset: Ruleset = {
      ...DEFAULT_RULESET,
      config: {
        ...DEFAULT_RULESET.config,
        map: { ...DEFAULT_RULESET.config.map, LEAF_COUNT: { min: 0, max: 4 }, COMPACTNESS_MAX: 1 },
      },
    };
    expect(() => validateStep.run(draft, contextOf('v', ruleset))).not.toThrow();
  });
});
