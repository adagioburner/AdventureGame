import type { GuardType, RewardKind, Terrain } from '@adventure/config';
import {
  isClaimed,
  type GameMap,
  type GameState,
  type NodeId,
  type PathPreview,
  type PathStepColor,
  type PlayerId,
  type Point,
} from '@adventure/core';
import { spriteIndex } from '../art/atlas.ts';
import { atlasOf, poiArt, wrapIndex, type ArtCatalog, type SpriteRef } from '../art/catalog.ts';
import { placeBackdrop, placeDressing } from './dressing.ts';
import { distance, nodeBounds, nodeSpacing, position, voronoiCells } from './geometry.ts';
import { isometricProjection, type Bounds, type Projection } from './isometric.ts';
import { placePoiPictures, ROUGH_SHAPE, type Box, type Oval, type PoiPicture, type ShapeOf } from './placement.ts';

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
  /** World units, to the middle of the node's black outline. */
  readonly radius: number;
  /**
   * [SOURCE §3] A guarded POI is marked in red (fighting) or purple (magic),
   * as a ring round its node's black outline rather than round its picture
   * since Andrei's 2026-09-23 review (Q31). `null` for every other node, and
   * for a claimed POI's.
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
  /** Whose figure this is; characters only. */
  readonly player?: PlayerId;
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

/**
 * `shapeOf` gives each sprite's measured shape, which is where pictures and
 * dressing go; without the pixels, `ROUGH_SHAPE` stands in for every sprite.
 */
export function buildMapScene(map: GameMap, catalog: ArtCatalog, shapeOf: ShapeOf = ROUGH_SHAPE): MapScene {
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

  const ovals = nodes.map((mark) => ({ ...nodeOval(catalog, projection, spacing, mark), node: mark.node, poi: guards.has(mark.node) }));
  const labels = map.pois.map((poi) => {
    const oval = ovals[poi.node] as Oval;
    return poiLabel(catalog, poi.node, oval, poi.reward.kind, poi.reward.units, poi.guard);
  });
  const pictures: PoiPicture[] = map.pois.map((poi) => {
    const art = poiArt(catalog, poi);
    return { node: poi.node, oval: ovals[poi.node] as Oval, sprite: art.sprite, size: art.row.size * SPACING_PX };
  });
  const feet = placePoiPictures(
    pictures,
    {
      roads: roads.map((road) => [projection.toScreen(road.from), projection.toScreen(road.to)] as const),
      nodes: ovals,
      labels: labels.map(labelBox),
      onGround: (screen) => {
        const at = projection.toWorld(screen);
        return at.x >= bounds.min.x && at.x <= bounds.max.x && at.y >= bounds.min.y && at.y <= bounds.max.y;
      },
    },
    shapeOf,
  );
  const pois: Billboard[] = pictures.map((picture, index) => {
    const foot = feet[index] as Point;
    return { layer: 'pois', sprite: picture.sprite, foot, size: picture.size, node: picture.node, depth: foot.y };
  });

  const ground = { map, catalog, projection, spacing, bounds, shapeOf };
  const billboards = [...placeBackdrop(ground), ...placeDressing(ground), ...pois].sort(backToFront);
  return { projection, spacing, bounds, terrain, roads, nodes, billboards, labels };
}

/** How a node is drawn. Every node is the same size; a guarded POI's adds a ring in its guard's colour. */
export function nodeMark(
  catalog: ArtCatalog,
  spacing: number,
  node: { readonly id: NodeId; readonly position: Point; readonly terrain: Terrain },
  guard: GuardType | null,
): NodeMark {
  return { node: node.id, at: node.position, terrain: node.terrain, radius: catalog.manifest.nodes.radius * spacing, guard };
}

/** The width of a node's black outline, in node spacings. */
export function nodeOutlineWidth(catalog: ArtCatalog): number {
  return catalog.manifest.nodes.radius * 0.28;
}

/**
 * The guard's ring round a guarded POI's node, in world units: drawn just
 * outside the black outline, which stays (Andrei, 2026-09-23).
 */
export function guardRing(catalog: ArtCatalog, spacing: number, mark: NodeMark): { radius: number; width: number } | null {
  if (mark.guard === null) return null;
  const width = catalog.manifest.guards.ringWidth * spacing;
  return { radius: mark.radius + (nodeOutlineWidth(catalog) * spacing) / 2 + width / 2, width };
}

/** A node's oval on screen at zoom 1, outline and guard's ring included. */
export function nodeOval(catalog: ArtCatalog, projection: Projection, spacing: number, mark: NodeMark): Oval {
  const ring = guardRing(catalog, spacing, mark);
  const reach = ring === null ? mark.radius + (nodeOutlineWidth(catalog) * spacing) / 2 : ring.radius + ring.width / 2;
  const across = (reach * SPACING_PX) / spacing;
  // The isometric view halves the ground's depth.
  return { at: projection.toScreen(mark.at), rx: across, ry: across / 2 };
}

function poiLabel(
  catalog: ArtCatalog,
  node: NodeId,
  oval: Oval,
  kind: RewardKind,
  units: number,
  guard: { readonly type: GuardType; readonly strength: number } | null,
): PoiLabel {
  const size = catalog.manifest.icons.size * SPACING_PX;
  const step = size * 0.42;
  const rowWidth = size + step * (units - 1);
  const numberSize = catalog.manifest.guards.numberSize * SPACING_PX;
  // Just in front of the POI's node, touching its oval, so nothing standing
  // hides the reward and the reward hides nothing of the node; with a guard,
  // the icons and the number are centred together.
  const numberWidth = guard === null ? 0 : numberSize * (String(guard.strength).length * 0.6) + size * 0.2;
  const left = oval.at.x - (rowWidth + numberWidth) / 2;
  const y = oval.at.y + oval.ry + size * ICON_TOUCH;
  return {
    node,
    icons: { kind, count: units, first: { x: left + size / 2, y }, step, size },
    guard:
      guard === null
        ? null
        : { type: guard.type, strength: guard.strength, at: { x: left + rowWidth + size * 0.2, y }, size: numberSize },
  };
}

/** Where an icon's centre sits below its node's oval, as a share of its size: just under a half, so the two touch. */
export const ICON_TOUCH = 0.45;

/** The screen box a POI's icons and number cover. */
export function labelBox(label: PoiLabel): Box {
  const { icons, guard } = label;
  const right = guard === null ? icons.first.x + icons.step * (icons.count - 1) + icons.size / 2 : guard.at.x + guard.size * 0.6 * String(guard.strength).length;
  const half = Math.max(icons.size, guard?.size ?? 0) / 2;
  return { minX: icons.first.x - icons.size / 2, minY: icons.first.y - half, maxX: right, maxY: icons.first.y + half };
}

function backToFront(p: Billboard, q: Billboard): number {
  return p.depth - q.depth || p.foot.x - q.foot.x;
}

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

/**
 * A figure on its way between nodes while End Turn plays out (§7.1: "the
 * character walks to the destination or as far as it gets"). Where it stands is
 * animation, not state: the engine has already moved it.
 */
export interface Walker {
  readonly player: PlayerId;
  /** World units, anywhere along the road it is walking. */
  readonly at: Point;
}

/**
 * How the current player's figure calls attention to itself (Andrei's review,
 * 2026-09-23: "hard to find your character"): it blinks while it is their
 * turn and they have not picked it up yet, and is highlighted, steady, while
 * they plan. `none` while a turn plays out and once the game is over.
 */
export type FigureCue = 'blink' | 'selected' | 'none';

export function buildStateScene(scene: MapScene, state: GameState, catalog: ArtCatalog, walker: Walker | null = null): StateScene {
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
  return { claimed, nodes, ...buildCharacters(scene, state, catalog, walker) };
}

/**
 * The figures, and the highlight under the current player's (§7.2). Split out
 * so a walking figure redraws only these.
 */
export function buildCharacters(
  scene: MapScene,
  state: GameState,
  catalog: ArtCatalog,
  walker: Walker | null = null,
): Pick<StateScene, 'characters' | 'active'> {
  const { manifest } = catalog;
  const figurines = atlasOf(catalog, manifest.figurines.sheet);
  const size = manifest.figurines.size * SPACING_PX;
  // Players sharing a node (§8 allows any number) stand side by side.
  const byNode = new Map<NodeId, number[]>();
  state.players.forEach((player, index) => {
    if (player.id === walker?.player) return;
    byNode.set(player.position, [...(byNode.get(player.position) ?? []), index]);
  });

  const characters: Billboard[] = [];
  let active: StateScene['active'] = null;
  state.players.forEach((player, index) => {
    const walking = player.id === walker?.player;
    const together = walking ? [index] : (byNode.get(player.position) ?? [index]);
    const slot = together.indexOf(index);
    const base = scene.projection.toScreen(walking ? walker.at : position(state.map.graph, player.position));
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
      player: player.id,
    });
    if (player.seat === state.turn.activeSeat && state.status !== 'finished') {
      active = {
        at: scene.projection.toWorld(foot),
        size: manifest.moveProspect.activeSize * scene.spacing,
        sprite: { sheet: manifest.moveProspect.sheet, index: spriteIndex(atlasOf(catalog, manifest.moveProspect.sheet), manifest.moveProspect.active) },
      };
    }
  });
  return { characters, active };
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
