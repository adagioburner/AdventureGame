import { TERRAINS, type GuardType, type RewardKind, type Terrain } from '@adventure/config';
import {
  createRng,
  isClaimed,
  type GameMap,
  type GameState,
  type NodeId,
  type PathPreview,
  type PathStepColor,
  type Point,
} from '@adventure/core';
import { spriteIndex } from '../art/atlas.ts';
import { atlasOf, poiArt, wrapIndex, type ArtCatalog, type SpriteRef } from '../art/catalog.ts';
import {
  distance,
  distanceToSegment,
  nodeBounds,
  nodeSpacing,
  ObstacleGrid,
  position,
  voronoiCells,
} from './geometry.ts';
import { isometricProjection, type Bounds, type Projection } from './isometric.ts';

/**
 * The map as a player sees it, as plain data: what to draw, where, and how
 * big, with no PixiJS in it. `pixi/renderer.ts` turns it into pictures; the
 * tests read it directly, which is how they can check what is and is not on
 * screen without a browser.
 *
 * **What is read from the map, and what is not.** The scene reads node
 * positions and terrain, the edges, and for each POI its terrain, reward,
 * guard and `artVariant` — the last only as a sprite index. It never reads
 * `Poi.remoteness`, `Poi.group` or `GameMap.attempts`: [Q15] sends them to
 * every client, and `remoteness` is the generator's own difficulty score,
 * the input to §4.3's rewards and §5.2's guards, so showing it would hand a
 * player something the rules do not (ARCHITECTURE.md §9). A guard's
 * *strength* is drawn, because §4.4 makes it a rule.
 *
 * Positions: the ground (terrain, roads, nodes, path dots) is in world units
 * and goes through `projection.matrix` whole; everything that stands up
 * (billboards, icons, numbers) is in screen pixels at zoom 1.
 */

/** Screen pixels, at zoom 1, per node spacing. */
export const SPACING_PX = 100;

export interface MapScene {
  readonly projection: Projection;
  /** One node spacing — a typical road's length — in world units. */
  readonly spacing: number;
  /** The ground's extent, in world units. */
  readonly bounds: Bounds;
  readonly terrain: readonly TerrainPatch[];
  readonly roads: readonly RoadStroke[];
  readonly nodes: readonly NodeMark[];
  /** Dressing and POI images, back to front. */
  readonly billboards: readonly Billboard[];
  readonly labels: readonly PoiLabel[];
}

export interface TerrainPatch {
  readonly node: NodeId;
  readonly terrain: Terrain;
  /** World units. */
  readonly polygon: readonly Point[];
}

export interface RoadStroke {
  readonly from: Point;
  readonly to: Point;
  /** World units. */
  readonly width: number;
}

export interface NodeMark {
  readonly node: NodeId;
  readonly at: Point;
  readonly terrain: Terrain;
  /** World units. */
  readonly radius: number;
}

export type BillboardLayer = 'dressing' | 'pois' | 'characters';

export interface Billboard {
  readonly layer: BillboardLayer;
  readonly sprite: SpriteRef;
  /** Screen pixels at zoom 1: where the sprite's anchor goes. */
  readonly foot: Point;
  /** Screen pixels at zoom 1 that the sheet's typical sprite spans. */
  readonly size: number;
  /** A guardian's contour colour, per §3. */
  readonly contour: GuardType | null;
  /** The node a POI or character stands on; `null` for dressing. */
  readonly node: NodeId | null;
  /** Back to front: larger is nearer the viewer. */
  readonly depth: number;
}

/** §4.1's icons and §4.4's number for one POI, drawn over everything else. */
export interface PoiLabel {
  readonly node: NodeId;
  readonly icons: {
    readonly kind: RewardKind;
    /** [SOURCE §4.1] "A stack of N same-kind units on one POI shows N (possibly overlapping) icons." */
    readonly count: number;
    /** Screen pixels at zoom 1: the centre of the first icon. */
    readonly first: Point;
    /** How far along each further icon sits. */
    readonly step: number;
    readonly size: number;
  };
  readonly guard: { readonly type: GuardType; readonly strength: number; readonly at: Point; readonly size: number } | null;
}

export function buildMapScene(map: GameMap, catalog: ArtCatalog): MapScene {
  const { manifest } = catalog;
  const graph = map.graph;
  const spacing = nodeSpacing(graph);
  const projection = isometricProjection(SPACING_PX / spacing);
  const bounds = nodeBounds(graph, spacing * 0.6);

  const cells = voronoiCells(
    graph.nodes.map((node) => node.position),
    bounds,
  );
  const terrain: TerrainPatch[] = graph.nodes.map((node, index) => ({
    node: node.id,
    terrain: node.terrain,
    polygon: cells[index] ?? [],
  }));

  const roads: RoadStroke[] = graph.edges.map((edge) => ({
    from: position(graph, edge.a),
    to: position(graph, edge.b),
    width: manifest.roads.width * spacing,
  }));

  const nodes: NodeMark[] = graph.nodes.map((node) => ({
    node: node.id,
    at: node.position,
    terrain: node.terrain,
    radius: manifest.nodes.radius * spacing,
  }));

  const pois: Billboard[] = [];
  const labels: PoiLabel[] = [];
  for (const poi of map.pois) {
    const art = poiArt(catalog, poi);
    const foot = projection.toScreen(position(graph, poi.node));
    pois.push({
      layer: 'pois',
      sprite: art.sprite,
      foot,
      size: art.row.size * SPACING_PX,
      contour: art.contour,
      node: poi.node,
      depth: foot.y,
    });
    labels.push(poiLabel(catalog, poi.node, foot, poi.reward.kind, poi.reward.units, poi.guard));
  }

  const dressing = placeDressing(map, catalog, projection, spacing, bounds);
  const billboards = [...dressing, ...pois].sort(backToFront);
  return { projection, spacing, bounds, terrain, roads, nodes, billboards, labels };
}

function poiLabel(
  catalog: ArtCatalog,
  node: NodeId,
  foot: Point,
  kind: RewardKind,
  units: number,
  guard: { readonly type: GuardType; readonly strength: number } | null,
): PoiLabel {
  const size = catalog.manifest.icons.size * SPACING_PX;
  const step = size * 0.42;
  const rowWidth = size + step * (units - 1);
  const numberSize = catalog.manifest.guards.numberSize * SPACING_PX;
  // In front of the POI's foot, so the picture never hides its own reward;
  // with a guard, the icons and the number are centred together.
  const numberWidth = guard === null ? 0 : numberSize * (String(guard.strength).length * 0.6) + size * 0.2;
  const left = foot.x - (rowWidth + numberWidth) / 2;
  const y = foot.y + size * 0.62;
  return {
    node,
    icons: { kind, count: units, first: { x: left + size / 2, y }, step, size },
    guard:
      guard === null
        ? null
        : { type: guard.type, strength: guard.strength, at: { x: left + rowWidth + size * 0.2, y }, size: numberSize },
  };
}

function backToFront(p: Billboard, q: Billboard): number {
  return p.depth - q.depth || p.foot.x - q.foot.x;
}

/**
 * [SOURCE §6] "non-interactive dressing (eye candy) are billboard sprites
 * pasted onto the map by the engine."
 *
 * Scattered over each terrain's ground at the manifest's density, from a
 * stream forked off the map seed so the same map always carries the same
 * trees, and rejected wherever a sprite would stand on a road or hide a node
 * or a road standing behind it — dressing is never in the way of the game.
 */
export function placeDressing(
  map: GameMap,
  catalog: ArtCatalog,
  projection: Projection,
  spacing: number,
  bounds: Bounds,
): Billboard[] {
  const { manifest } = catalog;
  const graph = map.graph;
  const rng = createRng(map.seed).fork('dressing');

  // What dressing must not cover, in screen space: every node and every road.
  const obstacles = new ObstacleGrid(SPACING_PX);
  for (const node of graph.nodes) obstacles.addPoint(projection.toScreen(node.position));
  for (const edge of graph.edges) {
    obstacles.addSegment(projection.toScreen(position(graph, edge.a)), projection.toScreen(position(graph, edge.b)));
  }

  const quota = new Map<Terrain, number>();
  for (const terrain of TERRAINS) {
    const count = graph.nodes.filter((node) => node.terrain === terrain).length;
    quota.set(terrain, Math.round(count * manifest.terrain[terrain].dressingDensity));
  }
  const wanted = [...quota.values()].reduce((sum, n) => sum + n, 0);

  const placed: Billboard[] = [];
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  for (let attempt = 0; attempt < wanted * 40 && placed.length < wanted; attempt++) {
    const at = { x: bounds.min.x + rng.nextFloat() * width, y: bounds.min.y + rng.nextFloat() * height };
    const pickDressing = rng.nextFloat();
    const pickSprite = rng.nextUint32();

    let nearest = graph.nodes[0];
    let nearestDistance = Infinity;
    for (const node of graph.nodes) {
      const d = distance(at, node.position);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = node;
      }
    }
    if (nearest === undefined) break;
    const left = quota.get(nearest.terrain) ?? 0;
    if (left <= 0) continue;
    if (nearestDistance < spacing * 0.3) continue;
    if (graph.edges.some((edge) => distanceToSegment(at, position(graph, edge.a), position(graph, edge.b)) < spacing * 0.14)) {
      continue;
    }

    const options = manifest.terrain[nearest.terrain].dressing;
    if (options.length === 0) continue;
    const total = options.reduce((sum, option) => sum + option.weight, 0);
    let roll = pickDressing * total;
    const option = options.find((candidate) => (roll -= candidate.weight) < 0) ?? options[options.length - 1];
    if (option === undefined) continue;

    const size = option.size * SPACING_PX;
    const foot = projection.toScreen(at);
    // The sprite rises above its foot; a node or road inside that box would
    // be hidden behind it.
    if (obstacles.anyInBox(foot.x - size * 0.45, foot.y - size * 0.9, foot.x + size * 0.45, foot.y + size * 0.05)) {
      continue;
    }

    const count = atlasOf(catalog, option.sheet).sprites.length;
    placed.push({
      layer: 'dressing',
      sprite: { sheet: option.sheet, index: wrapIndex(pickSprite, count) },
      foot,
      size,
      contour: null,
      node: null,
      depth: foot.y,
    });
    quota.set(nearest.terrain, left - 1);
  }
  return placed;
}

// --- what changes during play ------------------------------------------------

export interface StateScene {
  /** POIs whose reward is gone (§4.5): drawn faded, without icons or a number. */
  readonly claimed: ReadonlySet<NodeId>;
  readonly characters: readonly Billboard[];
  /** [SOURCE §7.2] The current player's character is highlighted on the map. */
  readonly active: { readonly at: Point; readonly size: number; readonly sprite: SpriteRef } | null;
}

export function buildStateScene(scene: MapScene, state: GameState, catalog: ArtCatalog): StateScene {
  const { manifest } = catalog;
  const claimed = new Set<NodeId>();
  state.map.pois.forEach((poi, index) => {
    const runtime = state.poiRuntime[index];
    if (runtime !== undefined && isClaimed(runtime)) claimed.add(poi.node);
  });

  const figurines = atlasOf(catalog, manifest.figurines.sheet);
  const size = manifest.figurines.size * SPACING_PX;
  // Players sharing a node (§8 allows any number) stand side by side.
  const byNode = new Map<NodeId, number[]>();
  state.players.forEach((player, index) => {
    byNode.set(player.position, [...(byNode.get(player.position) ?? []), index]);
  });

  const characters: Billboard[] = [];
  let active: StateScene['active'] = null;
  state.players.forEach((player, index) => {
    const together = byNode.get(player.position) ?? [index];
    const slot = together.indexOf(index);
    const base = scene.projection.toScreen(position(state.map.graph, player.position));
    // A little in front of the node, so a figure is never behind the POI it
    // stands on.
    const foot = { x: base.x + (slot - (together.length - 1) / 2) * size * 0.45, y: base.y + SPACING_PX * 0.12 };
    const found = figurines.sprites.findIndex((sprite) => sprite.id === player.avatarId);
    const sprite = { sheet: figurines.name, index: found >= 0 ? found : wrapIndex(player.seat - 1, figurines.sprites.length) };
    characters.push({
      layer: 'characters',
      sprite,
      foot,
      size,
      contour: null,
      node: player.position,
      depth: foot.y + 0.5,
    });
    if (player.seat === state.turn.activeSeat && state.status !== 'finished') {
      active = {
        at: scene.projection.toWorld(foot),
        size: manifest.moveProspect.activeSize * scene.spacing,
        sprite: { sheet: manifest.moveProspect.sheet, index: spriteIndex(atlasOf(catalog, manifest.moveProspect.sheet), manifest.moveProspect.active) },
      };
    }
  });
  return { claimed, characters, active };
}

// --- a prospective move ------------------------------------------------------

export interface PathScene {
  /** [SOURCE §7.1] The thick dotted line, one dot at a time, in world units. */
  readonly dots: readonly { readonly at: Point; readonly color: PathStepColor; readonly size: number }[];
  /** The isometric cross at the destination; grey when it cannot be reached this turn. */
  readonly cross: { readonly at: Point; readonly color: PathStepColor; readonly size: number };
  /** [SOURCE §7.1] Yellow steps are "labeled with the stamina cost, e.g. '-3'". Screen pixels. */
  readonly costs: readonly { readonly at: Point; readonly text: string; readonly size: number }[];
}

/**
 * Draws a `PathPreview` exactly as `@adventure/core` computed it: each dot
 * takes the colour of the step it leads into, and nothing here re-derives a
 * cost or a reachability — the client computes no rules (ARCHITECTURE.md §9).
 */
export function buildPathScene(scene: MapScene, map: GameMap, from: NodeId, preview: PathPreview, catalog: ArtCatalog): PathScene {
  const prospect = catalog.manifest.moveProspect;
  const dots: { at: Point; color: PathStepColor; size: number }[] = [];
  const costs: { at: Point; text: string; size: number }[] = [];
  const gap = prospect.dotSpacing * scene.spacing;
  const busy = labelPoints(scene);
  let previous = position(map.graph, from);
  for (const step of preview.steps) {
    const next = position(map.graph, step.node);
    const length = distance(previous, next);
    const count = Math.max(1, Math.round(length / gap));
    for (let i = 1; i <= count; i++) {
      const t = i / count;
      dots.push({
        at: { x: previous.x + (next.x - previous.x) * t, y: previous.y + (next.y - previous.y) * t },
        color: step.color,
        size: prospect.dotSize * scene.spacing,
      });
    }
    if (step.color === 'stamina' && step.staminaCost > 0) {
      costs.push({ at: costPosition(scene, previous, next, busy), text: `-${step.staminaCost}`, size: SPACING_PX * COST_SIZE });
    }
    previous = next;
  }
  const last = preview.steps[preview.steps.length - 1];
  const crossColor: PathStepColor = preview.destinationReachable ? (last?.color ?? 'free') : 'unreachable';
  return {
    dots,
    cross: { at: position(map.graph, preview.destination), color: crossColor, size: prospect.crossSize * scene.spacing },
    costs,
  };
}

/** A stamina cost's height, in node spacings. */
const COST_SIZE = 0.22;

/**
 * A step's cost sits beside the middle of the road it pays for. Middle,
 * because that is as far as the step gets from any node, and so from the
 * reward icons and guard numbers drawn under each POI; beside, so the dots of
 * the route stay visible under it. Of the road's two sides it takes the one
 * further from every node and every POI's icons and number, above the road
 * when the two are equally clear.
 */
function costPosition(scene: MapScene, from: Point, to: Point, busy: readonly Point[]): Point {
  const a = scene.projection.toScreen(from);
  const b = scene.projection.toScreen(to);
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  // The road's normal, turned to point up the screen.
  let nx = -(b.y - a.y) / length;
  let ny = (b.x - a.x) / length;
  if (ny > 0 || (ny === 0 && nx > 0)) {
    nx = -nx;
    ny = -ny;
  }
  const offset = SPACING_PX * (COST_SIZE * 0.5 + 0.08);
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const above = { x: middle.x + nx * offset, y: middle.y + ny * offset };
  const below = { x: middle.x - nx * offset, y: middle.y - ny * offset };
  const clearance = (at: Point): number => Math.min(...busy.map((point) => distance(point, at)));
  return clearance(below) > clearance(above) + 1e-9 ? below : above;
}

/** Every node, reward icon and guard number on screen, for labels to keep clear of. */
function labelPoints(scene: MapScene): Point[] {
  const points = scene.nodes.map((node) => scene.projection.toScreen(node.at));
  for (const label of scene.labels) {
    for (let i = 0; i < label.icons.count; i++) {
      points.push({ x: label.icons.first.x + i * label.icons.step, y: label.icons.first.y });
    }
    if (label.guard !== null) {
      points.push(label.guard.at, { x: label.guard.at.x + label.guard.size * 0.6, y: label.guard.at.y });
    }
  }
  return points;
}

/** [SOURCE §4] The shift-click waypoint marker, standing on its node. */
export function buildWaypoint(scene: MapScene, map: GameMap, node: NodeId, catalog: ArtCatalog): Billboard {
  const prospect = catalog.manifest.moveProspect;
  const foot = scene.projection.toScreen(position(map.graph, node));
  return {
    layer: 'characters',
    sprite: { sheet: prospect.sheet, index: spriteIndex(atlasOf(catalog, prospect.sheet), prospect.waypoint) },
    foot,
    size: prospect.waypointSize * SPACING_PX,
    contour: null,
    node,
    depth: foot.y + 1,
  };
}
