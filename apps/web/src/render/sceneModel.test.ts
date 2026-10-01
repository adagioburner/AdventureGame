import { describe, expect, it } from 'vitest';
import { DEFAULT_RULESET } from '@adventure/config';
import { asNodeId, isClaimed, type GameMap, type GameState, type PathPreview } from '@adventure/core';
import { atlasOf, buildArtCatalog, poiArt } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { previewGame, SAMPLE_ALLOWANCE, SAMPLE_STAMINA } from './scene.fixture.ts';
import { distance, distanceToSegment, polygonArea, position } from './geometry.ts';
import { BACKDROP_STEP, CLUSTER_TOUCH, EDGE_TREES_KEPT, placeDressing, silhouettePoints, STANDING_MARGIN } from './dressing.ts';
import { boxTouchesOval, grow, lengthInBox, ON_NODE_REACH, overlapArea, pictureBox, ROUGH_SHAPE } from './placement.ts';
import {
  buildMapScene,
  buildPathScene,
  buildStateScene,
  buildWaypoint,
  guardRing,
  ICON_TOUCH,
  labelBox,
  nodeOval,
  nodeOutlineWidth,
  siteDot,
  SPACING_PX,
  withUnits,
  type MapScene,
} from './sceneModel.ts';

const catalog = buildArtCatalog(ART_FILES);
const game = previewGame('adventure', DEFAULT_RULESET);
const scene = buildMapScene(game.map, catalog);

const ovals = scene.nodes.map((mark) => nodeOval(catalog, scene.projection, scene.spacing, mark));
const pictures = scene.billboards.filter((item) => item.layer === 'pois');
const screenRoads = game.map.graph.edges.map(
  (edge) =>
    [scene.projection.toScreen(position(game.map.graph, edge.a)), scene.projection.toScreen(position(game.map.graph, edge.b))] as const,
);

/** The node a POI picture stands by, on screen. */
function ovalOf(node: number | null) {
  const oval = node === null ? undefined : ovals[node];
  if (oval === undefined) throw new Error(`no node ${String(node)}`);
  return oval;
}

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

  it('stands one picture on every POI against its node: a guardian on it, off its middle, and the rest touching it', () => {
    // Andrei, 2026-09-23: "place POI images closer to the POIs themselves,
    // close to or touching the node. Guards, specifically, can be standing on
    // the node itself, not centered on it but intersecting at the base".
    expect(pictures).toHaveLength(game.map.pois.length);
    let guardians = 0;
    let onNode = 0;
    for (const poi of game.map.pois) {
      const picture = pictures.find((item) => item.node === poi.node);
      if (picture === undefined) throw new Error(`POI ${poi.node} has no picture`);
      const box = pictureBox(picture.foot, picture.size, ROUGH_SHAPE(picture.sprite));
      const oval = ovalOf(poi.node);
      if (poiArt(catalog, poi).row.onNode) {
        guardians++;
        const reach = Math.hypot((picture.foot.x - oval.at.x) / oval.rx, (picture.foot.y - oval.at.y) / oval.ry);
        if (reach <= 1) {
          onNode++;
          expect(reach).toBeCloseTo(ON_NODE_REACH);
          continue;
        }
      }
      expect(boxTouchesOval(box, oval)).toBe(false);
      expect(boxTouchesOval(grow(box, 1), oval)).toBe(true);
    }
    // A guardian steps off its node only where standing on it would cover a
    // neighbour, which on a crowded mountain happens.
    expect(guardians).toBeGreaterThan(10);
    expect(onNode).toBeGreaterThan(guardians / 2);
  });

  it('keeps POI pictures off the roads and off other POIs', () => {
    // Andrei, 2026-09-23: "placing the POI images so that they do not obscure
    // roads and other POI". Measured against every picture standing straight
    // behind its node, which is where the first build put them all.
    const pois = new Set(game.map.pois.map((poi) => poi.node));
    let hidden = 0;
    let hiddenBehind = 0;
    const problems: string[] = [];
    const boxes = pictures.map((picture) => pictureBox(picture.foot, picture.size, ROUGH_SHAPE(picture.sprite)));
    pictures.forEach((picture, index) => {
      const box = boxes[index];
      if (box === undefined) return;
      const oval = ovalOf(picture.node);
      const behind = pictureBox({ x: oval.at.x, y: oval.at.y - oval.ry }, picture.size, ROUGH_SHAPE(picture.sprite));
      // A guardian standing on its node stands on its own roads' first
      // stretch, as Andrei asked; those roads are left out of both sums.
      const onNode = ((picture.foot.x - oval.at.x) / oval.rx) ** 2 + ((picture.foot.y - oval.at.y) / oval.ry) ** 2 <= 1;
      screenRoads.forEach(([a, b], at) => {
        const edge = game.map.graph.edges[at];
        if (onNode && (edge?.a === picture.node || edge?.b === picture.node)) return;
        hidden += lengthInBox(a, b, box);
        hiddenBehind += lengthInBox(a, b, behind);
      });
      for (const node of pois) {
        if (node !== picture.node && boxTouchesOval(box, ovalOf(node))) problems.push(`the picture of ${picture.node} covers POI ${node}`);
      }
      boxes.forEach((other, at) => {
        if (at > index && overlapArea(box, other) > 0) problems.push(`the pictures of ${picture.node} and ${pictures[at]?.node} overlap`);
      });
    });
    expect(problems).toEqual([]);
    expect(hiddenBehind).toBeGreaterThan(300);
    // With the guards twice the size (Andrei, 2026-09-23) not every picture
    // on a crowded mountain can stand clear of both the roads and its
    // neighbours; clear of the neighbours wins, and about a quarter of the
    // road hidden by standing everything behind is still hidden.
    expect(hidden).toBeLessThan(hiddenBehind * 0.3);
  });

  it("rings a guarded POI's node in its guard's colour outside the black outline, and no other node", () => {
    // Q31: the colour is on the node, not round the picture, and the node
    // keeps its black outline inside the ring.
    const guards = new Map(game.map.pois.map((poi) => [poi.node, poi.guard?.type ?? null]));
    expect([...guards.values()].filter((guard) => guard !== null).length).toBeGreaterThan(5);
    const outline = nodeOutlineWidth(catalog) * scene.spacing;
    for (const mark of scene.nodes) {
      const guard = guards.get(mark.node) ?? null;
      expect(mark.guard).toBe(guard);
      expect(mark.radius).toBeCloseTo(catalog.manifest.nodes.radius * scene.spacing);
      const ring = guardRing(catalog, scene.spacing, mark);
      if (guard === null) expect(ring).toBeNull();
      else expect((ring?.radius ?? 0) - (ring?.width ?? 0) / 2).toBeCloseTo(mark.radius + outline / 2);
    }
  });

  it("puts a dot in the middle of every POI's node, guarded or not, and of no other node", () => {
    // Q80 (Andrei, 2026-09-29): the dot, in the roads' brown and 0.55 of the
    // node's width, marks which node a site's picture and icons belong to.
    const pois = new Set<number>(game.map.pois.map((poi) => poi.node));
    expect(game.map.pois.some((poi) => poi.guard === null)).toBe(true);
    expect(game.map.pois.some((poi) => poi.guard !== null)).toBe(true);
    const { size, color } = catalog.manifest.nodes.siteDot;
    const outline = nodeOutlineWidth(catalog) * scene.spacing;
    for (const mark of scene.nodes) {
      expect(mark.site).toBe(pois.has(mark.node));
      const dot = siteDot(catalog, mark);
      if (!pois.has(mark.node)) {
        expect(dot).toBeNull();
        continue;
      }
      expect(dot?.color).toBe(color);
      expect(dot?.radius).toBeCloseTo(mark.radius * size);
      // Inside the black outline, so the outline and a guard's ring show as before.
      expect(dot?.radius ?? Infinity).toBeLessThan(mark.radius - outline / 2);
    }
  });

  it("leaves every node's oval as it was, so nothing on the map stands elsewhere for the dot", () => {
    // Q80: "nothing else should change". The oval is what pictures and icons
    // are placed against; a mark without its dot gives the same one.
    for (const mark of scene.nodes) {
      expect(nodeOval(catalog, scene.projection, scene.spacing, { ...mark, site: false })).toEqual(
        nodeOval(catalog, scene.projection, scene.spacing, mark),
      );
    }
  });

  it('shows a stack of N units as N icons, and a guard as its strength in its colour, in front of the node', () => {
    expect(scene.labels).toHaveLength(game.map.pois.length);
    for (const poi of game.map.pois) {
      const label = scene.labels.find((candidate) => candidate.node === poi.node);
      expect(label?.icons.kind).toBe(poi.reward.kind);
      expect(label?.icons.count).toBe(poi.reward.units);
      if (poi.guard === null) expect(label?.guard).toBeNull();
      else expect(label?.guard).toMatchObject({ type: poi.guard.type, strength: poi.guard.strength });
      // Touching the front of the node's oval (Andrei, 2026-09-23), and
      // barely over it, so the icons never hide the guard's colour.
      const oval = ovalOf(poi.node);
      if (label === undefined) throw new Error(`POI ${poi.node} is not labelled`);
      const top = label.icons.first.y - label.icons.size / 2;
      expect(top).toBeLessThanOrEqual(oval.at.y + oval.ry);
      expect(top).toBeCloseTo(oval.at.y + oval.ry - label.icons.size * (0.5 - ICON_TOUCH));
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

  it('keeps standing dressing off nodes and roads, and never in front of either', () => {
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
      const box = grow(pictureBox(item.foot, item.size, ROUGH_SHAPE(item.sprite)), item.size * STANDING_MARGIN);
      const hides = covered.some(
        (point) => point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY,
      );
      if (hides) problems.push(`${where} stands in front of a node or road`);
      // And it is drawn from a dressing sheet, with a sprite the sheet has.
      if (!sheets.includes(item.sprite.sheet)) problems.push(`${where} uses ${item.sprite.sheet}`);
      if (item.sprite.index >= atlasOf(catalog, item.sprite.sheet).sprites.length) problems.push(`${where} has no sprite`);
    }
    expect(problems).toEqual([]);
  });

  it("keeps all standing dressing off the POIs' pictures and rewards", () => {
    const taken = [
      ...pictures.map((picture) => pictureBox(picture.foot, picture.size, ROUGH_SHAPE(picture.sprite))),
      ...scene.labels.map(labelBox),
    ];
    const problems: string[] = [];
    for (const item of scene.billboards.filter((billboard) => billboard.layer === 'dressing')) {
      const where = `${item.sprite.sheet} at (${item.foot.x.toFixed(1)}, ${item.foot.y.toFixed(1)})`;
      const box = grow(pictureBox(item.foot, item.size, ROUGH_SHAPE(item.sprite)), item.size * STANDING_MARGIN);
      if (taken.some((other) => overlapArea(box, other) > 0)) problems.push(`${where} covers a POI`);
    }
    expect(problems).toEqual([]);
  });

  it('stands every bush in a cluster, touching another bush, with kinds mixed', () => {
    // Andrei, 2026-09-26: "It may make sense to put the bushes in small
    // clusters." Q59: 2 to 4 bushes picked at random, touching, and every
    // bush in a cluster.
    const art = catalog.manifest.terrain.plains.dressing.find((d) => d.sheet === 'Plains_Dressing');
    const ids = art?.clusters?.sprites ?? [];
    expect(ids).toHaveLength(5);
    const sprites = atlasOf(catalog, 'Plains_Dressing').sprites;
    const bushes = scene.billboards.filter(
      (item) => item.sprite.sheet === 'Plains_Dressing' && ids.includes(sprites[item.sprite.index]?.id ?? ''),
    );
    expect(bushes.length).toBeGreaterThan(10);
    // The scene is built with ROUGH_SHAPE, one typical span across, so each
    // bush's footprint reaches half its size across the ground.
    const across = Math.hypot(scene.projection.matrix.a, scene.projection.matrix.c);
    const ground = bushes.map((item) => ({ at: scene.projection.toWorld(item.foot), reach: item.size / 2 / across, index: item.sprite.index }));
    const touching = (a: (typeof ground)[number], b: (typeof ground)[number]) =>
      distance(a.at, b.at) <= (a.reach + b.reach) * CLUSTER_TOUCH * 1.02;
    const alone = ground.filter((bush) => !ground.some((other) => other !== bush && touching(bush, other)));
    expect(alone).toEqual([]);
    const mixed = ground.some((bush) => ground.some((other) => other !== bush && touching(bush, other) && other.index !== bush.index));
    expect(mixed).toBe(true);
    // Everything else on the sheet stands alone, as often as each bush is picked.
    const others = scene.billboards.filter((item) => item.sprite.sheet === 'Plains_Dressing').length - bushes.length;
    expect(others).toBeGreaterThan(bushes.length);
  });

  it('keeps a third of the trees past the outermost roads, plants the rest in the middle, and moves nothing else (710, 711)', () => {
    // Andrei, 2026-10-01: "Trees are crowding too at the edge", and "I would
    // rather ask you to fit more in the middle." 710: a third stay; 711: the
    // rest are planted in the middle, by the same rules, as many as fit.
    const graph = game.map.graph;
    const ground = { map: game.map, catalog, projection: scene.projection, spacing: scene.spacing, bounds: scene.bounds, shapeOf: ROUGH_SHAPE };
    const untouched = placeDressing(ground, [], 1);
    const thinned = placeDressing(ground, [], EDGE_TREES_KEPT);
    const { min, max } = scene.bounds;
    // Past the outermost roads: walking from the tree straight to the nearest
    // edge of the ground, in small steps, never comes onto a road's middle line.
    const step = scene.spacing / 200;
    const pastTheRoads = (screen: { x: number; y: number }): boolean => {
      const at = scene.projection.toWorld(screen);
      const edges = [
        { x: min.x, y: at.y },
        { x: max.x, y: at.y },
        { x: at.x, y: min.y },
        { x: at.x, y: max.y },
      ];
      const edge = edges.reduce((best, point) => (distance(at, point) < distance(at, best) ? point : best));
      const steps = Math.ceil(distance(at, edge) / step);
      for (let i = 0; i <= steps; i++) {
        const point = { x: at.x + ((edge.x - at.x) * i) / steps, y: at.y + ((edge.y - at.y) * i) / steps };
        if (graph.edges.some((road) => distanceToSegment(point, position(graph, road.a), position(graph, road.b)) < step)) return false;
      }
      return true;
    };
    type Item = (typeof untouched)[number];
    const tree = (item: Item) => item.sprite.sheet === 'Forest_Trees';
    const edge = untouched.filter((item) => tree(item) && pastTheRoads(item.foot));
    const key = (item: Item) => `${item.sprite.sheet} ${item.sprite.index} at ${item.foot.x},${item.foot.y}`;
    const before = new Set(untouched.map(key));
    const after = new Set(thinned.map(key));
    // Untouched, the strip holds most of the forest's trees.
    expect(edge.length).toBeGreaterThan(untouched.filter(tree).length / 2);
    // Every other tree, bush and stone is where it was.
    expect(untouched.filter((item) => !edge.includes(item) && !after.has(key(item))).map(key)).toEqual([]);
    // A third of the edge trees stay, give or take the luck of the draw.
    const stayed = edge.filter((item) => after.has(key(item))).length;
    expect(stayed / edge.length).toBeGreaterThan(EDGE_TREES_KEPT - 0.1);
    expect(stayed / edge.length).toBeLessThan(EDGE_TREES_KEPT + 0.1);
    // What is new is trees in the middle of the forest, no more than were taken off.
    const planted = thinned.filter((item) => !before.has(key(item)));
    expect(planted.length).toBeGreaterThan(0);
    expect(planted.length).toBeLessThanOrEqual(edge.length - stayed);
    const problems = planted.flatMap((item) => {
      const at = scene.projection.toWorld(item.foot);
      const terrain = graph.nodes.reduce((best, node) => (distance(at, node.position) < distance(at, best.position) ? node : best)).terrain;
      if (!tree(item) || terrain !== 'forest') return [`${key(item)} is not a forest tree`];
      return pastTheRoads(item.foot) ? [`${key(item)} stands past the outermost roads`] : [];
    });
    expect(problems).toEqual([]);
  });

  it("fills the mountains with backdrop, large in the middle, each sized to stay over mountain ground", () => {
    // Andrei, 2026-09-23: "cover the whole mountain region, without gaps when
    // possible, but not stick out of it. For this, mountains can be resized";
    // then "we need to leave the mountains placed in the middle of the
    // mountain region large".
    const graph = game.map.graph;
    const backdrop = scene.billboards.filter((item) => item.layer === 'backdrop');
    const art = catalog.manifest.terrain.mountain.dressing;
    expect(art.map((d) => [d.sheet, d.layer])).toEqual([['Mountains_Mountains', 'backdrop']]);
    const [mountains] = art;
    if (mountains === undefined) throw new Error('no mountain dressing');
    const terrainAt = (screen: { x: number; y: number }) => {
      const at = scene.projection.toWorld(screen);
      const inside = at.x >= scene.bounds.min.x && at.x <= scene.bounds.max.x && at.y >= scene.bounds.min.y && at.y <= scene.bounds.max.y;
      if (!inside) return 'off the map';
      return graph.nodes.reduce((best, node) => (distance(at, node.position) < distance(at, best.position) ? node : best)).terrain;
    };
    const problems: string[] = [];
    for (const item of backdrop) {
      const where = `a mountain at (${item.foot.x.toFixed(1)}, ${item.foot.y.toFixed(1)})`;
      if (item.size < mountains.minSize * SPACING_PX - 1e-9 || item.size > mountains.size * SPACING_PX + 1e-9) {
        problems.push(`${where} is ${item.size.toFixed(1)} across`);
      }
      for (const point of silhouettePoints(item.foot, item.size, ROUGH_SHAPE(item.sprite))) {
        const terrain = terrainAt(point);
        if (terrain !== 'mountain') problems.push(`${where} reaches over ${terrain}`);
      }
    }
    expect(problems).toEqual([]);
    // Covered: most of the mountain ground lies under a mountain's picture,
    // on a grid finer than the mountains are sown on, and most of it under
    // one at least three times as large as a tree.
    const fine = mountains.minSize * scene.spacing * BACKDROP_STEP * 0.5;
    const [trees] = catalog.manifest.terrain.forest.dressing;
    const large = 3 * (trees?.size ?? 0) * SPACING_PX;
    let ground = 0;
    let under = 0;
    let underLarge = 0;
    for (let y = scene.bounds.min.y; y < scene.bounds.max.y; y += fine) {
      for (let x = scene.bounds.min.x; x < scene.bounds.max.x; x += fine) {
        const screen = scene.projection.toScreen({ x, y });
        if (terrainAt(screen) !== 'mountain') continue;
        ground++;
        const covering = backdrop.filter((item) => {
          const box = pictureBox(item.foot, item.size, ROUGH_SHAPE(item.sprite));
          return screen.x >= box.minX && screen.x <= box.maxX && screen.y >= box.minY && screen.y <= box.maxY;
        });
        if (covering.length > 0) under++;
        if (covering.some((item) => item.size >= large)) underLarge++;
      }
    }
    expect(ground).toBeGreaterThan(1000);
    expect(under / ground).toBeGreaterThan(0.9);
    expect(underLarge / ground).toBeGreaterThan(0.5);
    // Painted under the roads and nodes, so nothing keeps them away from either.
    const close = backdrop.filter((item) => {
      const at = scene.projection.toWorld(item.foot);
      return graph.nodes.some((node) => distance(at, node.position) < scene.spacing * 0.3);
    });
    expect(close.length).toBeGreaterThan(backdrop.length / 10);
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

  it("keeps a claimed POI's picture, drops its reward from the screen, and draws its node as an ordinary one", () => {
    const index = game.map.pois.findIndex((poi) => poi.guard !== null);
    const target = game.map.pois[index];
    if (target === undefined) throw new Error('the map has no guarded POI');
    const claimed: GameState = {
      ...game.state,
      poiRuntime: game.state.poiRuntime.map((runtime, at) =>
        at === index ? { claimedBy: game.state.players[0]?.id ?? null, claimedOnTurn: 1 } : runtime,
      ),
    };
    const state = buildStateScene(scene, claimed, catalog);
    expect([...state.claimed]).toEqual([target.node]);
    expect(claimed.poiRuntime.filter(isClaimed)).toHaveLength(1);
    // §4.5: the claimed POI's node loses its guard's colour and (Q80) its dot; no other node changes.
    expect(state.nodes[target.node]).toMatchObject({ guard: null, site: false, radius: catalog.manifest.nodes.radius * scene.spacing });
    expect(siteDot(catalog, state.nodes[target.node] ?? scene.nodes[0]!)).toBeNull();
    expect(guardRing(catalog, scene.spacing, state.nodes[target.node] ?? scene.nodes[0]!)).toBeNull();
    expect(state.nodes.filter((mark, at) => mark !== scene.nodes[at]).map((mark) => mark.node)).toEqual([target.node]);
    expect(buildStateScene(scene, game.state, catalog).nodes).toEqual(scene.nodes);
  });

  it("drops an unguarded POI's dot once it is claimed, and changes no other node", () => {
    // Q80 (Andrei, 2026-09-29): "when a site is claimed, the dot needs to disappear".
    const index = game.map.pois.findIndex((poi) => poi.guard === null);
    const target = game.map.pois[index];
    if (target === undefined) throw new Error('the map has no unguarded POI');
    expect(scene.nodes[target.node]).toMatchObject({ guard: null, site: true });
    const claimed: GameState = {
      ...game.state,
      poiRuntime: game.state.poiRuntime.map((runtime, at) =>
        at === index ? { claimedBy: game.state.players[0]?.id ?? null, claimedOnTurn: 1 } : runtime,
      ),
    };
    const state = buildStateScene(scene, claimed, catalog);
    expect(state.nodes[target.node]).toMatchObject({ guard: null, site: false });
    expect(siteDot(catalog, state.nodes[target.node] ?? scene.nodes[0]!)).toBeNull();
    expect(state.nodes.filter((mark, at) => mark !== scene.nodes[at]).map((mark) => mark.node)).toEqual([target.node]);
  });

  it('draws a site that came back with fewer units than it started with with that many icons, still centred (Q135)', () => {
    const index = game.map.pois.findIndex((poi) => poi.reward.units === 3);
    const target = game.map.pois[index];
    const label = scene.labels.find((candidate) => candidate.node === target?.node);
    if (target === undefined || label === undefined) throw new Error('the map has no 3-unit site');
    const back: GameState = {
      ...game.state,
      poiRuntime: game.state.poiRuntime.map((runtime, at) => (at === index ? { claimedBy: null, claimedOnTurn: null, units: 2 } : runtime)),
    };
    const state = buildStateScene(scene, back, catalog);
    expect([...state.units]).toEqual([[target.node, 2]]);
    expect(buildStateScene(scene, game.state, catalog).units.size).toBe(0);

    const two = withUnits(label, 2);
    expect(two.icons.count).toBe(2);
    const middle = (box: { minX: number; maxX: number }): number => (box.minX + box.maxX) / 2;
    expect(middle(labelBox(two))).toBeCloseTo(middle(labelBox(label)));
  });

  it('draws a walking figure where End Turn has got it to, alone, with its ring', () => {
    const walking = game.state.players[0];
    const neighbour = game.map.graph.adjacency[walking?.position ?? 0]?.[0];
    if (walking === undefined || neighbour === undefined) throw new Error('no one to walk');
    const from = position(game.map.graph, walking.position);
    const to = position(game.map.graph, neighbour);
    const halfway = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const still = buildStateScene(scene, game.state, catalog);
    const moving = buildStateScene(scene, game.state, catalog, { player: walking.id, at: halfway });

    const [mover, other] = moving.characters;
    const foot = scene.projection.toScreen(halfway);
    expect(mover?.player).toBe(walking.id);
    expect(mover?.foot.x).toBeCloseTo(foot.x, 9);
    expect(mover?.foot.y).toBeCloseTo(foot.y + SPACING_PX * 0.12, 9);
    // The other figure no longer shares a node with it, so stands in the middle of its own.
    expect(other?.foot.x).toBeCloseTo(scene.projection.toScreen(from).x, 9);
    expect(other?.foot.x).not.toBe(still.characters[1]?.foot.x);
    // The ring follows the player whose turn it is.
    expect(moving.active?.at.x).toBeCloseTo(scene.projection.toWorld(mover?.foot ?? foot).x, 9);
    expect(moving.nodes).toEqual(still.nodes);
  });

  it('shows no active ring once the game is over', () => {
    expect(buildStateScene(scene, { ...game.state, status: 'finished' }, catalog).active).toBeNull();
  });

  it('rings a player found from their card, the player on turn aside, during the game and after it (Q120)', () => {
    const [onTurn, other] = game.state.players;
    if (onTurn === undefined || other === undefined) throw new Error('two players needed');
    const found = buildStateScene(scene, game.state, catalog, null, null, other.id);
    const figure = found.characters.find((item) => item.player === other.id);
    expect(found.found?.at.x).toBeCloseTo(scene.projection.toWorld(figure?.foot ?? { x: 0, y: 0 }).x, 9);
    expect(found.found?.size).toBe(found.active?.size);
    // The figure on turn keeps its own cue and gets nothing more.
    expect(buildStateScene(scene, game.state, catalog, null, null, onTurn.id).found).toBeNull();
    expect(buildStateScene(scene, game.state, catalog).found).toBeNull();
    const over = buildStateScene(scene, { ...game.state, status: 'finished' }, catalog, null, null, onTurn.id);
    expect(over.found).not.toBeNull();
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

  it('puts no number on a stamina step: its colour says it is not free', () => {
    // Q32: Andrei's 2026-09-23 review dropped §7.1's "-3" labels.
    if (sample === null) throw new Error('no sample');
    const from = game.state.players[0]?.position ?? asNodeId(0);
    const path = buildPathScene(scene, game.map, from, sample.preview, catalog);
    expect(Object.keys(path).sort()).toEqual(['cross', 'dots']);
    expect(path.dots.some((dot) => dot.color === 'stamina')).toBe(true);
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
  });

  it('stands the waypoint flag on its node', () => {
    const node = sample?.waypoint ?? asNodeId(0);
    const flag = buildWaypoint(scene, game.map, node, catalog);
    expect(flag.foot).toEqual(scene.projection.toScreen(position(game.map.graph, node)));
    const atlas = atlasOf(catalog, catalog.manifest.moveProspect.sheet);
    expect(atlas.sprites[flag.sprite.index]?.id).toBe(catalog.manifest.moveProspect.waypoint);
  });
});
