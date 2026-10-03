import { describe, expect, it } from 'vitest';
import { buildArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { applyAffine, groundCorners, shapeUnderside, turnGreens, undersideDepth, undersideMatrix } from './island.ts';
import { isometricProjection } from './isometric.ts';

describe("the rock under the map's front edges (Q170)", () => {
  const projection = isometricProjection(0.01);
  const bounds = { min: { x: -500, y: 200 }, max: { x: 9000, y: 9700 } };
  const corners = { left: { x: 18, y: 85.5 }, bottom: { x: 772.3, y: 467.7 }, right: { x: 1516, y: 89.3 } };

  it("puts the picture's three corners on the ground's left, bottom and right corners", () => {
    const matrix = undersideMatrix(projection, bounds, corners);
    const ground = groundCorners(projection, bounds);
    for (const corner of ['left', 'bottom', 'right'] as const) {
      const at = applyAffine(matrix, corners[corner]);
      expect(at.x).toBeCloseTo(ground[corner].x, 6);
      expect(at.y).toBeCloseTo(ground[corner].y, 6);
    }
  });

  it('keeps the rest of the picture below the front edges, not turned over', () => {
    const matrix = undersideMatrix(projection, bounds, corners);
    const ground = groundCorners(projection, bounds);
    // A point lower in the picture lands lower on the screen, and nearly straight down.
    const below = applyAffine(matrix, { x: corners.bottom.x, y: corners.bottom.y + 300 });
    expect(below.y).toBeGreaterThan(ground.bottom.y);
    expect(Math.abs(below.x - ground.bottom.x)).toBeLessThan((below.y - ground.bottom.y) * 0.05);
  });

  it('is the same rock at any map size, scaled with the map', () => {
    const small = undersideMatrix(projection, bounds, corners);
    const larger = undersideMatrix(projection, { min: bounds.min, max: { x: bounds.max.x * 1.4, y: bounds.max.y * 1.4 } }, corners);
    expect(larger.a / small.a).toBeGreaterThan(1.3);
    expect(larger.d / small.d).toBeCloseTo(larger.a / small.a, 3);
  });

  it("reaches down to the rock's lowest point, not to blank room under it", () => {
    const matrix = undersideMatrix(projection, bounds, corners);
    const ground = groundCorners(projection, bounds);
    const solid = { x: 18, y: 82, width: 1500, height: 917 };
    const depth = undersideDepth(projection, bounds, matrix, solid);
    const tip = applyAffine(matrix, { x: corners.bottom.x, y: 999 });
    expect(depth).toBeCloseTo(tip.y - ground.bottom.y, -1);
    expect(undersideDepth(projection, bounds, matrix, { ...solid, height: 1200 })).toBeGreaterThan(depth);
  });

  it("matches Art/manifest.json's picture to the ground's slope, so its height is hardly changed", () => {
    const { island } = buildArtCatalog(ART_FILES).manifest;
    const matrix = undersideMatrix(projection, bounds, island.underside.corners);
    // Stretched across and down by nearly the same amount, and not sheared.
    expect(matrix.d / matrix.a).toBeGreaterThan(0.97);
    expect(matrix.d / matrix.a).toBeLessThan(1.03);
    expect(Math.abs(matrix.b / matrix.a)).toBeLessThan(0.02);
    expect(Math.abs(matrix.c / matrix.a)).toBeLessThan(0.02);
  });

  it("fades the stone tops above the ground's edge into it, and leaves the rest as drawn (679)", () => {
    // A 9 by 12 picture whose edge runs from (0, 2) down to (4.5, 6.5) and back up to (9, 2).
    const width = 9;
    const height = 12;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(200);
    const v = { left: { x: 0, y: 2 }, bottom: { x: 4.5, y: 6.5 }, right: { x: 9, y: 2 } };
    shapeUnderside(pixels, width, v, 4);
    const alpha = (x: number, y: number) => pixels[(y * width + x) * 4 + 3];
    // The middle column's edge runs through the middle of its row 6: drawn there
    // and below, half gone 2 above, gone 4 above.
    expect(alpha(4, 6)).toBe(200);
    expect(alpha(4, 11)).toBe(200);
    expect(alpha(4, 4)).toBe(100);
    expect(alpha(4, 2)).toBe(0);
    // Colours are left alone; only how solid the stone is changes.
    expect(pixels[(1 * width + 4) * 4]).toBe(200);
    // Both slopes alike.
    expect(alpha(0, 1)).toBe(alpha(8, 1));
  });

  it("ends the rock where the ground ends: at its side corners and its back edges (681)", () => {
    // Corners at (4, 3), (8.5, 7.5) and (13, 3) in a 17 by 12 picture: its first and last 4 columns lie past the ground.
    const width = 17;
    const pixels = new Uint8ClampedArray(width * 12 * 4).fill(200);
    shapeUnderside(pixels, width, { left: { x: 4, y: 3 }, bottom: { x: 8.5, y: 7.5 }, right: { x: 13, y: 3 } }, 4);
    const alpha = (x: number, y: number) => pixels[(y * width + x) * 4 + 3];
    // Left of the left corner and right of the right one, all the way down: gone.
    for (const y of [1, 5, 11]) {
      expect(alpha(1, y)).toBe(0);
      expect(alpha(15, y)).toBe(0);
    }
    // Over the ground just inside a corner: faded. Past a back edge beside it: gone.
    expect(alpha(5, 2)).toBe(100);
    expect(alpha(4, 0)).toBe(0);
    expect(alpha(12, 0)).toBe(0);
    // Under the front edges, between the corners: as drawn.
    expect(alpha(5, 11)).toBe(200);
    expect(alpha(8, 10)).toBe(200);
    expect(alpha(12, 11)).toBe(200);
  });

  describe("the rock's moss in the forest's green (830, 831)", () => {
    const greens = { hue: 42, saturation: 0.75, darken: 0.25 };
    const turned = (...rgba: number[]) => {
      const pixels = new Uint8ClampedArray(rgba);
      turnGreens(pixels, greens);
      return [...pixels];
    };
    const hsl = ([r, g, b]: number[]) => {
      const [red, green, blue] = [r! / 255, g! / 255, b! / 255];
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const chroma = max - min;
      const lightness = (max + min) / 2;
      const hue = 60 * (max === red ? (green - blue) / chroma : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4);
      return { hue, saturation: chroma / (1 - Math.abs(2 * lightness - 1)), lightness };
    };

    it('turns the olive moss to green, less saturated and darker', () => {
      const moss = [119, 112, 41, 255];
      const before = hsl(moss);
      const after = hsl(turned(...moss));
      expect(after.hue).toBeCloseTo(before.hue + 42, 0);
      expect(after.saturation).toBeCloseTo(before.saturation * 0.75, 1);
      expect(after.lightness).toBeCloseTo(before.lightness * 0.75, 2);
      expect(turned(...moss)[3]).toBe(255);
    });

    it('leaves the stone, the roots, greys, the palest sunlit spots and see-through pixels as drawn', () => {
      for (const pixel of [
        [200, 180, 140, 255], // sunlit stone, hue 40
        [122, 90, 58, 255], // a root's wood
        [128, 128, 128, 255], // grey
        [240, 236, 200, 255], // a pale sunlit spot, yellow-green but nearly white
        [119, 112, 41, 0], // see-through
      ]) {
        expect(turned(...pixel)).toEqual(pixel);
      }
    });

    it('turns a green at the edge of the stone\'s yellows part of the way, so moss shades off into stone', () => {
      const edge = [150, 133, 60, 255]; // hue about 49
      const turn = hsl(turned(...edge)).hue - hsl(edge).hue;
      expect(turn).toBeGreaterThan(5);
      expect(turn).toBeLessThan(42);
    });

    it('changes nothing when the manifest leaves the greens as drawn', () => {
      const pixels = new Uint8ClampedArray([119, 112, 41, 255]);
      turnGreens(pixels, { hue: 0, saturation: 1, darken: 0 });
      expect([...pixels]).toEqual([119, 112, 41, 255]);
    });
  });
});
