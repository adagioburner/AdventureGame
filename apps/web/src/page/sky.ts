import type { ArtCatalog } from '../art/catalog.ts';
import type { Camera } from '../render/isometric.ts';

/**
 * [Andrei, 2026-10-01] "For the background, I was thinking of a grey-blue
 * cloudy sky, not very bright" (Q170), and he drew one. It fills the map's
 * box behind the map (`.map-sky` in index.html).
 *
 * `Art/manifest.json` names the picture, its average colour, shown while it
 * loads (680), and how much both are darkened, and the page's stylesheet reads
 * them from these properties of the page's root, a light or a dark screen
 * picking its own shade.
 */
export function skyProperties(catalog: ArtCatalog): Readonly<Record<string, string>> {
  const { color, shade } = catalog.manifest.island.sky;
  return {
    '--map-sky': `url("${catalog.islandUrls.sky}")`,
    '--map-sky-color': color,
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
 * at all will create an unnatural feeling." 677 at 17:09: "Let's make it
 * still, but growing with the zoom". So it does not slide when the map is
 * dragged and grows a little as the map is zoomed in (`SKY_ZOOM_GROWTH`).
 */

/**
 * [678] How much the sky grows as the map is zoomed in, as a sky this share as
 * near as the map would: about a tenth at the closest zoom. 0 keeps its size.
 * It never shrinks below its size at the whole-map view.
 */
export const SKY_ZOOM_GROWTH = 0.1;

/**
 * How much the sky behind a map seen through `camera`, whose whole-map view is
 * `fit`, is grown from its size in its box, centred in it.
 */
export function skyScale(fit: Camera, camera: Camera, growth: number = SKY_ZOOM_GROWTH): number {
  const closer = camera.zoom / fit.zoom;
  // As if the sky were far behind the map: zooming in, which brings the map
  // `closer` times nearer, brings the sky only a little nearer.
  return Math.max(1, 1 / (growth / closer + 1 - growth));
}
