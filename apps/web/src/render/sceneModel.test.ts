import { describe, expect, it } from 'vitest';
import { DEFAULT_RULESET } from '@adventure/config';
import { asNodeId, isClaimed, type GameMap, type GameState, type PathPreview } from '@adventure/core';
import { atlasOf, buildArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { previewGame, SAMPLE_ALLOWANCE, SAMPLE_STAMINA } from '../page/preview.ts';
import { distance, distanceToSegment, polygonArea, position } from './geometry.ts';
import {
  buildMapScene,
  buildPathScene,
  buildStateScene,
  buildWaypoint,
  SPACING_PX,
  type MapScene,
} from './sceneModel.ts';

const catalog = buildArtCatalog(ART_FILES);
const game = previewGame('adventure', DEFAULT_RULESET);
const scene = buildMapScene(game.map, catalog);

/** The scene as plain data: the projection's functions compared by their matrix. */
function plain(value: MapScene): unknown {
  return JSON.parse(JSON.stringify({ ...value, projection: value.projection.matrix }));
}

describe('what the player sees of the map', () => {
  it("never depends on the generator's internals: remoteness, reward group or attempts", () => {
    // Q15 sends these to every client, and ARCHITECTURE.md §9 keeps them off
    // the screen. Scrambling all three must not move a single pixel.
    const scrambled: GameMap = {
      ...game.map,
      attempts: game.map.attempts + 41,
      pois: game.map.pois.map((poi, index) => ({
        ...poi,
        remoteness: ((index * 7919) % 101) / 100,
        group: { kind: 'stamina', guard: index % 2 === 0 ? 'magic' : null },
      })),
    };
    expect(plain(buildMapScene(scrambled, catalog))).toEqual(plain(scene));
  });

  it('is the same scene every time for the same map', () => {
    expect(plain(buildMapScene(game.map, catalog))).toEqual(plain(scene));
  });

  it('stands one picture on every POI, with a contour exactly when it is guarded', () => {
    const pois = scene.billboards.filter((item) => item.layer === 'pois');
    expect(pois).toHaveLength(game.map.pois.length);
    for (const poi of game.map.pois) {
      const picture = pois.find((item) => item.node === poi.node);
      expect(picture?.contour ?? null).toBe(poi.guard?.type ?? null);
      expect(picture?.foot).toEqual(scene.projection.toScreen(position(game.map.graph, poi.node)));
    }
  });

  it('shows a stack of N units as N icons, and a guard as its strength in its colour', () => {
    expect(scene.labels).toHaveLength(game.map.pois.length);
    for (const poi of game.map.pois) {
      const label = scene.labels.find((candidate) => candidate.node === poi.node);
      expect(label?.icons.kind).toBe(poi.reward.kind);
      expect(label?.icons.count).toBe(poi.reward.units);
      if (poi.guard === null) expect(label?.guard).toBeNull();
      else expect(label?.guard).toMatchObject({ type: poi.guard.type, strength: poi.guard.strength });
    }
  });

  it('draws every node and every road, sized from the map rather than its coordinate space', () => {
    expect(scene.nodes).toHaveLength(game.map.graph.nodes.length);
    expect(scene.roads).toHaveLength(game.map.graph.edges.length);
    for (const node of scene.nodes) expect(node.radius).toBeCloseTo(catalog.manifest.nodes.radius * scene.spacing);
    // One node spacing comes out as SPACING_PX on screen along the ground.
    const along = scene.projection.toScreen({ x: scene.spacing, y: 0 });
    const origin = scene.projection.toScreen({ x: 0, y: 0 });
    expect(Math.hypot(along.x - origin.x, (along.y - origin.y) * 2)).toBeCloseTo(SPACING_PX);
  });

  it('covers the ground with terrain, each node in its own cell and its own terrain', () => {
    const width = scene.bounds.max.x - scene.bounds.min.x;
    const height = scene.bounds.max.y - scene.bounds.min.y;
    const total = scene.terrain.reduce((sum, patch) => sum + polygonArea(patch.polygon), 0);
    expect(total / (width * height)).toBeCloseTo(1, 6);
    for (const patch of scene.terrain) {
      const node = game.map.graph.nodes[patch.node];
      expect(patch.terrain).toBe(node?.terrain);
      expect(patch.polygon.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps dressing off nodes and roads, and never in front of either', () => {
    const graph = game.map.graph;
    const dressing = scene.billboards.filter((item) => item.layer === 'dressing');
    expect(dressing.length).toBeGreaterThan(100);
    // Every node, and every road sampled every tenth of its length: a check
    // independent of the exact segment test the placement itself uses.
    const covered = graph.nodes.map((node) => scene.projection.toScreen(node.position));
    for (const edge of graph.edges) {
      const a = position(graph, edge.a);
      const b = position(graph, edge.b);
      for (let t = 0.1; t < 1; t += 0.1) {
        covered.push(scene.projection.toScreen({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
      }
    }
    const sheets = Object.values(catalog.manifest.terrain).flatMap((art) => art.dressing.map((d) => d.sheet));
    const problems: string[] = [];
    for (const item of dressing) {
      const ground = scene.projection.toWorld(item.foot);
      const where = `dressing at (${item.foot.x.toFixed(1)}, ${item.foot.y.toFixed(1)})`;
      if (graph.nodes.some((node) => distance(ground, node.position) < scene.spacing * 0.3)) {
        problems.push(`${where} stands on a node`);
      }
      if (graph.edges.some((edge) => distanceToSegment(ground, position(graph, edge.a), position(graph, edge.b)) < scene.spacing * 0.14)) {
        problems.push(`${where} stands on a road`);
      }
      const hides = covered.some(
        (point) =>
          point.x >= item.foot.x - item.size * 0.45 &&
          point.x <= item.foot.x + item.size * 0.45 &&
          point.y >= item.foot.y - item.size * 0.9 &&
          point.y <= item.foot.y + item.size * 0.05,
      );
      if (hides) problems.push(`${where} stands in front of a node or road`);
      // And it is drawn from a dressing sheet, with a sprite the sheet has.
      if (!sheets.includes(item.sprite.sheet)) problems.push(`${where} uses ${item.sprite.sheet}`);
      if (item.sprite.index >= atlasOf(catalog, item.sprite.sheet).sprites.length) problems.push(`${where} has no sprite`);
    }
    expect(problems).toEqual([]);
  });

  it('orders everything standing back to front', () => {
    for (let i = 1; i < scene.billboards.length; i++) {
      expect(scene.billboards[i]?.depth).toBeGreaterThanOrEqual(scene.billboards[i - 1]?.depth ?? -Infinity);
    }
  });
});

describe('what changes during play', () => {
  it('stands both players on the starting node, side by side, and rings the one to move', () => {
    const state = buildStateScene(scene, game.state, catalog);
    expect(state.characters).toHaveLength(2);
    const [first, second] = state.characters;
    expect(first?.node).toBe(game.state.players[0]?.position);
    expect(second?.node).toBe(game.state.players[1]?.position);
    expect(first?.foot.y).toBe(second?.foot.y);
    expect(first?.foot.x).toBeLessThan(second?.foot.x ?? -Infinity);
    expect(first?.sprite.index).toBe(0);
    expect(second?.sprite.index).toBe(1);
    expect(state.active).not.toBeNull();
    expect(state.claimed.size).toBe(0);
  });

  it('fades a claimed POI and drops its reward from the screen', () => {
    const target = game.map.pois[3];
    if (target === undefined) throw new Error('the map has too few POIs');
    const claimed: GameState = {
      ...game.state,
      poiRuntime: game.state.poiRuntime.map((runtime, index) =>
        index === 3 ? { claimedBy: game.state.players[0]?.id ?? null, claimedOnTurn: 1 } : runtime,
      ),
    };
    const state = buildStateScene(scene, claimed, catalog);
    expect([...state.claimed]).toEqual([target.node]);
    expect(claimed.poiRuntime.filter(isClaimed)).toHaveLength(1);
  });

  it('shows no active ring once the game is over', () => {
    expect(buildStateScene(scene, { ...game.state, status: 'finished' }, catalog).active).toBeNull();
  });
});

describe('a prospective move', () => {
  const sample = game.sample;

  it('has a sample on this map showing all three of §7.1’s colours', () => {
    expect(sample).not.toBeNull();
    const colors = new Set(sample?.preview.steps.map((step) => step.color));
    expect([...colors].sort()).toEqual(['free', 'stamina', 'unreachable']);
    expect(sample?.allowance).toEqual(SAMPLE_ALLOWANCE);
    expect(sample?.stamina).toBe(SAMPLE_STAMINA);
  });

  it('colours each dot by the step it leads into, exactly as previewPath reported it', () => {
    if (sample === null) throw new Error('no sample');
    const from = game.state.players[0]?.position ?? asNodeId(0);
    const path = buildPathScene(scene, game.map, from, sample.preview, catalog);
    const shown = [...new Set(path.dots.map((dot) => dot.color))];
    const reported = [...new Set(sample.preview.steps.map((step) => step.color))];
    expect(shown).toEqual(reported);
    // The last dot of each step sits on that step's node.
    const ends = path.dots.filter((dot) =>
      sample.preview.steps.some((step) => distance(dot.at, position(game.map.graph, step.node)) < 1e-6),
    );
    expect(ends).toHaveLength(sample.preview.steps.length);
    expect(path.cross.at).toEqual(position(game.map.graph, sample.preview.destination));
    // A reachable cross takes the colour of the step that arrives there.
    const arrival = sample.preview.steps.at(-1)?.color;
    expect(path.cross.color).toBe(sample.preview.destinationReachable ? arrival : 'unreachable');
  });

  it('labels every stamina step with its cost and nothing else', () => {
    if (sample === null) throw new Error('no sample');
    const from = game.state.players[0]?.position ?? asNodeId(0);
    const path = buildPathScene(scene, game.map, from, sample.preview, catalog);
    const expected = sample.preview.steps
      .filter((step) => step.color === 'stamina')
      .map((step) => `-${step.staminaCost}`);
    expect(path.costs.map((cost) => cost.text)).toEqual(expected);
    // Each beside the middle of its own road, clear of both ends and so of
    // the icons and numbers under each POI.
    let previous = from;
    let index = 0;
    for (const step of sample.preview.steps) {
      if (step.color === 'stamina') {
        const cost = path.costs[index++];
        const a = scene.projection.toScreen(position(game.map.graph, previous));
        const b = scene.projection.toScreen(position(game.map.graph, step.node));
        const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (cost === undefined) throw new Error('a stamina step has no cost');
        expect(distance(cost.at, middle)).toBeLessThan(SPACING_PX * 0.25);
        expect(Math.min(distance(cost.at, a), distance(cost.at, b))).toBeGreaterThan(distance(cost.at, middle));
      }
      previous = step.node;
    }
  });

  it('greys the cross when the destination is out of reach this turn', () => {
    const node = game.map.graph.nodes[1]?.id ?? asNodeId(1);
    const unreachable: PathPreview = {
      steps: [{ node, color: 'unreachable', staminaCost: 0 }],
      destination: node,
      destinationReachable: false,
      reachableStepCount: 0,
      totalStaminaCost: 0,
    };
    const path = buildPathScene(scene, game.map, asNodeId(0), unreachable, catalog);
    expect(path.cross.color).toBe('unreachable');
    expect(path.costs).toHaveLength(0);
  });

  it('stands the waypoint flag on its node', () => {
    const node = sample?.waypoint ?? asNodeId(0);
    const flag = buildWaypoint(scene, game.map, node, catalog);
    expect(flag.foot).toEqual(scene.projection.toScreen(position(game.map.graph, node)));
    const atlas = atlasOf(catalog, catalog.manifest.moveProspect.sheet);
    expect(atlas.sprites[flag.sprite.index]?.id).toBe(catalog.manifest.moveProspect.waypoint);
  });
});
