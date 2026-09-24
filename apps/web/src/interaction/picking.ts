import type { GameMap, NodeId, PlayerId, Point } from '@adventure/core';
import type { Camera } from '../render/isometric.ts';
import { grow, pictureBox, type Box, type ShapeOf } from '../render/placement.ts';
import { SPACING_PX, type Billboard, type MapScene } from '../render/sceneModel.ts';
import { position } from '../render/geometry.ts';

/**
 * What a click or a tap landed on. Everything here works in the zoom-1 screen
 * plane the scene is laid out in, so it needs no PixiJS and is tested headless.
 */
export interface Pick {
  /**
   * Every figure under the click, frontmost first: clicking your own enters
   * move mode (§7.1). Players sharing a node stand close enough that one
   * click can land on two, so the page picks whose turn it is among them.
   */
  readonly players: readonly PlayerId[];
  /** The node the click means, when it means one. */
  readonly node: NodeId | null;
}

/** The zoom-1 screen-plane point under `screen`, a point in the viewport. */
export function screenToPlane(camera: Camera, viewport: Point, screen: Point): Point {
  return {
    x: camera.center.x + (screen.x - viewport.x / 2) / camera.zoom,
    y: camera.center.y + (screen.y - viewport.y / 2) / camera.zoom,
  };
}

/** Where a zoom-1 plane point shows in the viewport: the inverse of `screenToPlane`. */
export function planeToScreen(camera: Camera, viewport: Point, plane: Point): Point {
  return {
    x: viewport.x / 2 + (plane.x - camera.center.x) * camera.zoom,
    y: viewport.y / 2 + (plane.y - camera.center.y) * camera.zoom,
  };
}

/**
 * A finger is about this wide on screen, whatever the zoom: a node counts as
 * tapped within half a node spacing, or within this many screen pixels when
 * the map is zoomed so far out that half a spacing is smaller.
 */
export const TOUCH_SLOP_PX = 22;

export function pick(
  scene: MapScene,
  map: GameMap,
  characters: readonly Billboard[],
  pictures: readonly Billboard[],
  shapeOf: ShapeOf,
  plane: Point,
  zoom: number,
): Pick {
  return { players: pickCharacters(characters, shapeOf, plane), node: pickNode(scene, map, pictures, shapeOf, plane, zoom) };
}

/** The figures whose pictures cover `plane`, frontmost first. */
export function pickCharacters(characters: readonly Billboard[], shapeOf: ShapeOf, plane: Point): PlayerId[] {
  return [...characters]
    .sort((p, q) => q.depth - p.depth)
    .filter((figure) => inside(grow(pictureBox(figure.foot, figure.size, shapeOf(figure.sprite)), figure.size * 0.1), plane))
    .flatMap((figure) => (figure.player === undefined ? [] : [figure.player]));
}

/**
 * The middle of the top of `player`'s figure, in the plane: where an unguarded
 * claim's notice floats up from. `null` if the player has no figure drawn.
 */
export function figureTop(characters: readonly Billboard[], shapeOf: ShapeOf, player: PlayerId): Point | null {
  const figure = characters.find((item) => item.player === player);
  if (figure === undefined) return null;
  const box = pictureBox(figure.foot, figure.size, shapeOf(figure.sprite));
  return { x: (box.minX + box.maxX) / 2, y: box.minY };
}

/**
 * The node nearest `plane` on the ground, if it is near enough; failing that,
 * the node of a POI whose picture was tapped, since the castle is what a player
 * aims at.
 *
 * Distances are measured on the ground, undoing the isometric squash, so a
 * node's catchment is round on the map rather than on screen.
 */
export function pickNode(
  scene: MapScene,
  map: GameMap,
  pictures: readonly Billboard[],
  shapeOf: ShapeOf,
  plane: Point,
  zoom: number,
): NodeId | null {
  const reach = Math.max(SPACING_PX * 0.5, TOUCH_SLOP_PX / zoom);
  let best: { node: NodeId; distance: number } | null = null;
  for (const node of map.graph.nodes) {
    const at = scene.projection.toScreen(position(map.graph, node.id));
    const distance = Math.hypot(plane.x - at.x, (plane.y - at.y) * 2);
    if (distance <= reach && (best === null || distance < best.distance)) best = { node: node.id, distance };
  }
  if (best !== null) return best.node;

  const frontFirst = [...pictures].sort((p, q) => q.depth - p.depth);
  for (const picture of frontFirst) {
    if (picture.node === null) continue;
    if (inside(pictureBox(picture.foot, picture.size, shapeOf(picture.sprite)), plane)) return picture.node;
  }
  return null;
}

function inside(box: Box, point: Point): boolean {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}
