import { describe, expect, it } from 'vitest';
import { buildArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { skyPlacement, skyProperties, skyRoom } from './sky.ts';

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

  const box = { x: 1000, y: 600 };
  const fit = { center: { x: 500, y: 300 }, zoom: 0.5 };
  /** The map dragged `by` pixels at `zoom`. */
  const dragged = (by: { x: number; y: number }, zoom: number) => ({ center: { x: 500 - by.x / zoom, y: 300 - by.y / zoom }, zoom });

  /** Whether the sky is at rest in the middle of its box, at `scale`. */
  const atRest = (placed: { x: number; y: number; scale: number }, scale: number) => {
    expect(Math.abs(placed.x)).toBe(0);
    expect(Math.abs(placed.y)).toBe(0);
    expect(placed.scale).toBeCloseTo(scale, 9);
  };

  it('sits in the middle, as drawn, at the whole-map view', () => {
    atRest(skyPlacement(box, fit, fit), 1);
  });

  it('stays still when the map is dragged (677)', () => {
    atRest(skyPlacement(box, fit, dragged({ x: 200, y: 100 }, 0.5)), 1);
    expect(skyRoom()).toBe(1);
  });

  it('grows a little as the map is zoomed in, by about a tenth at the closest zoom, and never shrinks (678)', () => {
    // Twice as close as the whole-map view, and dragged.
    const near = skyPlacement(box, fit, dragged({ x: 300, y: -200 }, 1));
    atRest(near, near.scale);
    expect(near.scale).toBeGreaterThan(1.04);
    expect(near.scale).toBeLessThan(1.06);
    const closest = skyPlacement(box, fit, { center: fit.center, zoom: 4 * 2.5 });
    expect(closest.scale).toBeGreaterThan(1.09);
    expect(closest.scale).toBeLessThan(1.11);
    expect(skyPlacement(box, fit, { center: fit.center, zoom: 0.4 }).scale).toBe(1);
    expect(skyPlacement(box, fit, { center: fit.center, zoom: 4 }, 0, 0).scale).toBe(1);
  });

  it('with a drift, moves that share as far as the map at the whole-map view, the same way', () => {
    const placed = skyPlacement(box, fit, dragged({ x: 200, y: 100 }, 0.5), 0.1);
    expect(placed.x).toBeCloseTo(20);
    expect(placed.y).toBeCloseTo(10);
    // Less for the same drag when zoomed in.
    expect(skyPlacement(box, fit, dragged({ x: 200, y: 0 }, 4), 0.1).x).toBeLessThan(5);
  });

  it('with a drift, never shows its edge, however far the map is dragged', () => {
    for (const zoom of [0.4, 0.5, 4]) {
      const placed = skyPlacement(box, fit, { center: { x: -1e6, y: 1e6 }, zoom }, 0.1);
      const size = { x: box.x * skyRoom(0.1) * placed.scale, y: box.y * skyRoom(0.1) * placed.scale };
      expect(Math.abs(placed.x)).toBeLessThanOrEqual((size.x - box.x) / 2 + 1e-9);
      expect(Math.abs(placed.y)).toBeLessThanOrEqual((size.y - box.y) / 2 + 1e-9);
    }
    // Room enough at the whole-map view until the map's middle reaches the box's edge.
    const edge = skyPlacement(box, fit, dragged({ x: 500, y: 0 }, 0.5), 0.1);
    expect(edge.x).toBeCloseTo(50);
    expect(edge.x).toBeLessThanOrEqual((box.x * skyRoom(0.1) - box.x) / 2);
  });
});
