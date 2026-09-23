import type { Point } from '@adventure/core';

/**
 * [SOURCE §6] "Rendering: isometric view throughout; non-interactive dressing
 * (eye candy) are billboard sprites pasted onto the map by the engine."
 *
 * Isometric here is a projection, not a 3D scene: map coordinates are 2D
 * (§1.3's arbitrary large space) and this converts them to screen space. It is
 * the classic 2:1 game isometric the supplied art is drawn in — the map turned
 * 45° and squashed to half height — so a building's walls run along the same
 * diagonals the roads do.
 *
 * It is an affine map, and `matrix` exposes it as one, so the renderer can lay
 * the whole ground plane (terrain, roads, nodes, the path overlay) through it
 * in a single transform: a circle drawn there comes out as §2's "small oval"
 * and a flat X as §7.1's "isometric cross" with no per-shape maths. Figures
 * stand upright instead, placed at `toScreen` of their foot.
 */
export interface Projection {
  toScreen(world: Point): Point;
  toWorld(screen: Point): Point;
  /** `screen = matrix · world`, in PixiJS's `{a, b, c, d, tx, ty}` layout. */
  readonly matrix: Affine;
}

/** `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`. */
export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

/** How far the ground is squashed: 2:1 isometric. */
export const ISOMETRIC_SQUASH = 0.5;

/**
 * The 2:1 isometric projection at `pixelsPerUnit` screen pixels per world unit
 * (measured along the ground, before the squash).
 */
export function isometricProjection(pixelsPerUnit: number): Projection {
  const k = pixelsPerUnit * Math.SQRT1_2;
  const matrix: Affine = { a: k, b: k * ISOMETRIC_SQUASH, c: -k, d: k * ISOMETRIC_SQUASH, tx: 0, ty: 0 };
  return affineProjection(matrix);
}

/** Any invertible affine map as a `Projection` — the tests use a plain scale. */
export function affineProjection(matrix: Affine): Projection {
  const { a, b, c, d, tx, ty } = matrix;
  const det = a * d - b * c;
  if (det === 0) throw new RangeError('a projection must be invertible');
  return {
    matrix,
    toScreen: (world) => ({ x: a * world.x + c * world.y + tx, y: b * world.x + d * world.y + ty }),
    toWorld: (screen) => {
      const x = screen.x - tx;
      const y = screen.y - ty;
      return { x: (d * x - c * y) / det, y: (a * y - b * x) / det };
    },
  };
}

/**
 * Screen-space camera. [SOURCE §4] Click-drag to pan, `+`/`-` to zoom.
 * `center` is the screen point (at zoom 1) shown in the middle of the viewport.
 */
export interface Camera {
  readonly center: Point;
  readonly zoom: number;
}

export interface Bounds {
  readonly min: Point;
  readonly max: Point;
}

/** The screen-space box a world-space box projects into. */
export function projectBounds(projection: Projection, world: Bounds): Bounds {
  const corners = [
    world.min,
    { x: world.max.x, y: world.min.y },
    world.max,
    { x: world.min.x, y: world.max.y },
  ].map((corner) => projection.toScreen(corner));
  return {
    min: { x: Math.min(...corners.map((p) => p.x)), y: Math.min(...corners.map((p) => p.y)) },
    max: { x: Math.max(...corners.map((p) => p.x)), y: Math.max(...corners.map((p) => p.y)) },
  };
}

/**
 * [SOURCE §1.3, chat] "set the initial camera zoom so the whole map is visible
 * on screen at game start" — players then play zoomed in.
 *
 * `overhang` is screen room (at zoom 1) that pictures standing on the map's
 * farthest nodes need beyond the ground itself, above it most of all.
 */
export function fitToViewport(
  projection: Projection,
  worldBounds: Bounds,
  viewport: Point,
  overhang: { readonly top: number; readonly side: number; readonly bottom: number } = { top: 0, side: 0, bottom: 0 },
): Camera {
  const screen = projectBounds(projection, worldBounds);
  const min = { x: screen.min.x - overhang.side, y: screen.min.y - overhang.top };
  const max = { x: screen.max.x + overhang.side, y: screen.max.y + overhang.bottom };
  const zoom = Math.min(viewport.x / (max.x - min.x), viewport.y / (max.y - min.y));
  return { center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 }, zoom };
}

/** Where a camera puts the zoom-1 screen plane inside a viewport. */
export function cameraTransform(camera: Camera, viewport: Point): Affine {
  return {
    a: camera.zoom,
    b: 0,
    c: 0,
    d: camera.zoom,
    tx: viewport.x / 2 - camera.center.x * camera.zoom,
    ty: viewport.y / 2 - camera.center.y * camera.zoom,
  };
}
