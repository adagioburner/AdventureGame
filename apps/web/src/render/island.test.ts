import { describe, expect, it } from 'vitest';
import { buildArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { applyAffine, groundCorners, undersideDepth, undersideMatrix } from './island.ts';
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
});
