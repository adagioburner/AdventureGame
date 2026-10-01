import type { Point } from '@adventure/core';
import type { ArtCatalog } from '../art/catalog.ts';
import type { Camera } from '../render/isometric.ts';

/**
 * [Andrei, 2026-10-01] "For the background, I was thinking of a grey-blue
 * cloudy sky, not very bright" (Q170), and he drew one. It fills the map's
 * box behind the map (`.map-sky` in index.html).
 *
 * `Art/manifest.json` names the picture and how much it is darkened, and the
 * page's stylesheet reads them from these properties of the page's root, a
 * light or a dark screen picking its own shade.
 */
export function skyProperties(catalog: ArtCatalog): Readonly<Record<string, string>> {
  const { shade } = catalog.manifest.island.sky;
  return {
    '--map-sky': `url("${catalog.islandUrls.sky}")`,
    '--map-sky-shade-light': String(shade.light),
    '--map-sky-shade-dark': String(shade.dark),
  };
}

/** Puts the sky behind every map on the page. */
export function paintSky(catalog: ArtCatalog, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(skyProperties(catalog))) root.style.setProperty(name, value);
}

/**
 * [Andrei, 2026-10-01] 676: "I am afraid that background that does not move
 * at all will create an unnatural feeling." He tried a sky that slides with
 * the map and settled on 677 at 17:09: "Let's make it still, but growing with
 * the zoom". So it does not slide when the map is dragged (`SKY_DRIFT` 0) and
 * grows a little as the map is zoomed in (`SKY_ZOOM_GROWTH`).
 */

/**
 * How far the sky slides for each step the map moves at the whole-map view,
 * and less as the map is zoomed in, as a faraway sky would; 0 keeps it still.
 */
export const SKY_DRIFT = 0;

/**
 * [678] How much the sky grows as the map is zoomed in, as a sky this share as
 * near as the map would: about a tenth at the closest zoom. 0 keeps its size.
 * It never shrinks below its size at the whole-map view.
 */
export const SKY_ZOOM_GROWTH = 0.1;

/**
 * How many times the box's width and height the sky is drawn, so it has room
 * to slide: at the whole-map view, enough to follow the map until its middle
 * reaches the box's edge. 1, the box's own size, while it does not slide.
 */
export function skyRoom(drift: number = SKY_DRIFT): number {
  return 1 + drift;
}

/** Where the sky goes: moved by `x` and `y` in CSS pixels, and grown by `scale`, from centred in its box. */
export interface SkyPlacement {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/**
 * Where the sky goes behind a map seen through `camera`, whose whole-map view
 * is `fit`. `box` is the size of the box the sky fills, which it is drawn
 * `skyRoom` times as large as; it stops at its own edge rather than show it.
 */
export function skyPlacement(
  box: Point,
  fit: Camera,
  camera: Camera,
  drift: number = SKY_DRIFT,
  growth: number = SKY_ZOOM_GROWTH,
): SkyPlacement {
  const closer = camera.zoom / fit.zoom;
  // As if the sky were far behind the map: zooming in, which brings the map
  // `closer` times nearer, brings the sky only a little nearer.
  const scale = Math.max(1, 1 / (growth / closer + 1 - growth));
  const room = skyRoom(drift);
  const along = (fitCenter: number, center: number, size: number): number => {
    const spare = (size * room * scale - size) / 2;
    const moved = drift * scale * (fitCenter - center) * fit.zoom;
    return Math.max(-spare, Math.min(spare, moved));
  };
  return { x: along(fit.center.x, camera.center.x, box.x), y: along(fit.center.y, camera.center.y, box.y), scale };
}
