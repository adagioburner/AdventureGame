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
 * *strength* is drawn, because §4.4 makes it a rule, and so is its type, as
 * the colour of the POI's node.
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
  /**
   * [SOURCE §3] A guarded POI is marked in red (fighting) or purple (magic),
   * on its node rather than round its picture since Andrei's 2026-09-23
   * review (Q31). `null` for every other node, and for a claimed POI's.
   */
  readonly guard: GuardType | null;
}

/**
 * `backdrop` is dressing painted on the ground under the roads and nodes;
 * the other three stand up and are depth-sorted together.
 */
export type BillboardLayer = 'backdrop' | 'dressing' | 'pois' | 'characters';

export interface Billboard {
  readonly layer: BillboardLayer;
  readonly sprite: SpriteRef;
  /** Screen pixels at zoom 1: where the sprite's anchor goes. */
  readonly foot: Point;
  /** Screen pixels at zoom 1 that the sheet's typical sprite spans. */
  readonly size: number;
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

  const guards = new Map(map.pois.map((poi) => [poi.node, poi.guard?.type ?? null]));
  const nodes: NodeMark[] = graph.nodes.map((node) => nodeMark(catalog, spacing, node, guards.get(node.id) ?? null));

  const pois: Billboard[] = [];
  const labels: PoiLabel[] = [];
  for (const poi of map.pois) {
    const art = poiArt(catalog, poi);
    const at = projection.toScreen(position(graph, poi.node));
    // The picture stands just behind its node, so the whole node, and the
    // guard's colour on it, is in front of the picture and never hidden by it.
    const reach = nodeReach(catalog, poi.guard?.type ?? null);
    const foot = { x: at.x, y: at.y - reach };
    pois.push({
      layer: 'pois',
      sprite: art.sprite,
      foot,
      size: art.row.size * SPACING_PX,
      node: poi.node,
      depth: foot.y,
    });
    labels.push(poiLabel(catalog, poi.node, at, reach, poi.reward.kind, poi.reward.units, poi.guard));
  }

  const dressing = placeDressing(map, catalog, projection, spacing, bounds);
  const billboards = [...dressing, ...pois].sort(backToFront);
  return { projection, spacing, bounds, terrain, roads, nodes, billboards, labels };
}

/** How a node is drawn: a guarded POI's node larger, in its guard's colour. */
export function nodeMark(
  catalog: ArtCatalog,
  spacing: number,
  node: { readonly id: NodeId; readonly position: Point; readonly terrain: Terrain },
  guard: GuardType | null,
): NodeMark {
  const { manifest } = catalog;
  const radius = guard === null ? manifest.nodes.radius : manifest.guards.nodeRadius;
  return { node: node.id, at: node.position, terrain: node.terrain, radius: radius * spacing, guard };
}

/** The width of a node's outline, in node spacings. */
export function nodeOutlineWidth(catalog: ArtCatalog, guard: GuardType | null): number {
  const { manifest } = catalog;
  return guard === null ? manifest.nodes.radius * 0.28 : manifest.guards.nodeOutlineWidth;
}

/** How far a node's oval, outline included, reaches up and down the screen from its centre, in pixels at zoom 1. */
function nodeReach(catalog: ArtCatalog, guard: GuardType | null): number {
  const radius = guard === null ? catalog.manifest.nodes.radius : catalog.manifest.guards.nodeRadius;
  // The isometric view halves the ground's depth.
  return ((radius + nodeOutlineWidth(catalog, guard) / 2) * SPACING_PX) / 2;
}

function poiLabel(
  catalog: ArtCatalog,
  node: NodeId,
  at: Point,
  reach: number,
  kind: RewardKind,
  units: number,
  guard: { readonly type: GuardType; readonly strength: number } | null,
): PoiLabel {
  const size = catalog.manifest.icons.size * SPACING_PX;
  const step = size * 0.42;
  const rowWidth = size + step * (units - 1);
  const numberSize = catalog.manifest.guards.numberSize * SPACING_PX;
  // In front of the POI's node, so neither the picture nor the node hides the
  // reward; with a guard, the icons and the number are centred together.
  const numberWidth = guard === null ? 0 : numberSize * (String(guard.strength).length * 0.6) + size * 0.2;
  const left = at.x - (rowWidth + numberWidth) / 2;
  const y = at.y + reach + size * 0.55;
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
 * trees. Standing dressing is rejected wherever it would stand on a road or
 * hide a node or a road standing behind it, so it is never in the way of the
 * game. Backdrop dressing is painted under the roads and nodes, so it goes
 * anywhere on its terrain, only kept apart enough not to pile up.
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

  // What standing dressing must not cover, in screen space: every node and every road.
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
  const backdrop: { at: Point; size: number }[] = [];
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

    const options = manifest.terrain[nearest.terrain].dressing;
    if (options.length === 0) continue;
    const total = options.reduce((sum, option) => sum + option.weight, 0);
    let roll = pickDressing * total;
    const option = options.find((candidate) => (roll -= candidate.weight) < 0) ?? options[options.length - 1];
    if (option === undefined) continue;

    const size = option.size * SPACING_PX;
    const foot = projection.toScreen(at);
    if (option.layer === 'backdrop') {
      const apart = option.size * spacing * BACKDROP_GAP;
      if (backdrop.some((other) => distance(at, other.at) < Math.min(apart, other.size * BACKDROP_GAP))) continue;
      backdrop.push({ at, size: option.size * spacing });
    } else {
      if (nearestDistance < spacing * 0.3) continue;
      if (graph.edges.some((edge) => distanceToSegment(at, position(graph, edge.a), position(graph, edge.b)) < spacing * 0.14)) {
        continue;
      }
      // The sprite rises above its foot; a node or road inside that box would
      // be hidden behind it.
      if (obstacles.anyInBox(foot.x - size * 0.45, foot.y - size * 0.9, foot.x + size * 0.45, foot.y + size * 0.05)) {
        continue;
      }
    }

    const count = atlasOf(catalog, option.sheet).sprites.length;
    placed.push({
      layer: option.layer === 'backdrop' ? 'backdrop' : 'dressing',
      sprite: { sheet: option.sheet, index: wrapIndex(pickSprite, count) },
      foot,
      size,
      node: null,
      depth: foot.y,
    });
    quota.set(nearest.terrain, left - 1);
  }
  return placed;
}

/** How close two backdrop sprites may stand, as a share of the smaller one's size. */
export const BACKDROP_GAP = 0.45;

// --- what changes during play ------------------------------------------------

export interface StateScene {
  /** POIs whose reward is gone (§4.5): drawn faded, without icons or a number. */
  readonly claimed: ReadonlySet<NodeId>;
  /**
   * Every node as it is drawn now. [SOURCE §4.5] A claimed POI "behaves like
   * an ordinary node", so its node loses its guard's colour.
   */
  readonly nodes: readonly NodeMark[];
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
  const nodes = scene.nodes.map((mark) =>
    mark.guard !== null && claimed.has(mark.node)
      ? nodeMark(catalog, scene.spacing, { id: mark.node, position: mark.at, terrain: mark.terrain }, null)
      : mark,
  );

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
  return { claimed, nodes, characters, active };
}

// --- a prospective move ------------------------------------------------------

export interface PathScene {
  /** [SOURCE §7.1] The thick dotted line, one dot at a time, in world units. */
  readonly dots: readonly { readonly at: Point; readonly color: PathStepColor; readonly size: number }[];
  /** The isometric cross at the destination; grey when it cannot be reached this turn. */
  readonly cross: { readonly at: Point; readonly color: PathStepColor; readonly size: number };
}

/**
 * Draws a `PathPreview` exactly as `@adventure/core` computed it: each dot
 * takes the colour of the step it leads into, and nothing here re-derives a
 * cost or a reachability — the client computes no rules (ARCHITECTURE.md §9).
 *
 * A yellow step carries no number: since Andrei's 2026-09-23 review the
 * colour alone says a step costs stamina (Q32).
 */
export function buildPathScene(scene: MapScene, map: GameMap, from: NodeId, preview: PathPreview, catalog: ArtCatalog): PathScene {
  const prospect = catalog.manifest.moveProspect;
  const dots: { at: Point; color: PathStepColor; size: number }[] = [];
  const gap = prospect.dotSpacing * scene.spacing;
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
    previous = next;
  }
  const last = preview.steps[preview.steps.length - 1];
  const crossColor: PathStepColor = preview.destinationReachable ? (last?.color ?? 'free') : 'unreachable';
  return {
    dots,
    cross: { at: position(map.graph, preview.destination), color: crossColor, size: prospect.crossSize * scene.spacing },
  };
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
    node,
    depth: foot.y + 1,
  };
}
