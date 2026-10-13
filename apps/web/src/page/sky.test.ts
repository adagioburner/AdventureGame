import { describe, expect, it } from 'vitest';
import { buildArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { skyProperties, skyScale } from './sky.ts';

describe('the sky behind the map (Q170)', () => {
  it("puts Andrei's sky behind the map, as drawn on a light screen and darkened for night on a dark one (671, 673, 682)", () => {
    const catalog = buildArtCatalog(ART_FILES);
    expect(skyProperties(catalog)).toEqual({
      '--map-sky': `url("${catalog.islandUrls.sky}")`,
      '--map-sky-color': '#809ab4',
      '--map-sky-shade-light': '0',
      '--map-sky-shade-dark': '0.3',
    });
  });

  const fit = { center: { x: 500, y: 300 }, zoom: 0.5 };
  /** The map dragged `by` pixels at `zoom`. */
  const dragged = (by: { x: number; y: number }, zoom: number) => ({ center: { x: 500 - by.x / zoom, y: 300 - by.y / zoom }, zoom });

  it('is drawn at its own size at the whole-map view', () => {
    expect(skyScale(fit, fit)).toBeCloseTo(1, 9);
  });

  it('keeps its size when the map is dragged (677)', () => {
    expect(skyScale(fit, dragged({ x: 200, y: 100 }, 0.5))).toBeCloseTo(1, 9);
  });

  it('grows a little as the map is zoomed in, by about a tenth at the closest zoom, and never shrinks (678)', () => {
    // Twice as close as the whole-map view, and dragged.
    const near = skyScale(fit, dragged({ x: 300, y: -200 }, 1));
    expect(near).toBeGreaterThan(1.04);
    expect(near).toBeLessThan(1.06);
    const closest = skyScale(fit, { center: fit.center, zoom: 4 * 2.5 });
    expect(closest).toBeGreaterThan(1.09);
    expect(closest).toBeLessThan(1.11);
    expect(skyScale(fit, { center: fit.center, zoom: 0.4 })).toBe(1);
    expect(skyScale(fit, { center: fit.center, zoom: 4 }, 0)).toBe(1);
  });
});
