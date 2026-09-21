import type { Point } from '@adventure/core';

/**
 * [SOURCE §6] "Rendering: isometric view throughout; non-interactive dressing
 * (eye candy) are billboard sprites pasted onto the map by the engine."
 *
 * Isometric here is a projection, not a 3D scene: map coordinates are 2D
 * (§1.3's arbitrary large space) and this converts them to screen space. Keeping
 * it a single interface means the whole renderer can be tested against a
 * trivial orthographic projection.
 */
export interface Projection {
  toScreen(world: Point): Point;
  toWorld(screen: Point): Point;
}

/** Screen-space camera. [SOURCE §4] Click-drag to pan, `+`/`-` to zoom. */
export interface Camera {
  readonly center: Point;
  readonly zoom: number;
}

/**
 * [SOURCE §1.3, chat] "set the initial camera zoom so the whole map is visible
 * on screen at game start" — players then play zoomed in.
 */
export function fitToViewport(_worldBounds: { min: Point; max: Point }, _viewport: Point): Camera {
  throw new Error('fitToViewport: implement with the renderer (GDD.md §1.3, §7.1)');
}
