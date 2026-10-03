import type { Point } from '@adventure/core';
import type { IslandCorners, IslandGreens } from '../art/manifest.ts';
import type { Rect } from '../art/pixels.ts';
import type { Affine, Bounds, Projection } from './isometric.ts';

/**
 * [Andrei, 2026-10-01] "I don't like the map floating in the void. Can we add
 * this extension to the bottom to create a Laputa-style floating island?"
 * (Q170). The extension is his picture of a rock wall in a V, which hangs
 * under the map's two front edges, the ones that run down to its bottom corner.
 */

/** The ground's left, bottom and right corners, in screen pixels at zoom 1. */
export function groundCorners(projection: Projection, bounds: Bounds): IslandCorners {
  return {
    left: projection.toScreen({ x: bounds.min.x, y: bounds.max.y }),
    bottom: projection.toScreen(bounds.max),
    right: projection.toScreen({ x: bounds.max.x, y: bounds.min.y }),
  };
}

/**
 * The affine map from the underside picture's pixels to the screen at zoom 1
 * that takes the picture's three `corners` onto the ground's. Three points
 * fix an affine map exactly, so the picture's top edges lie along the map's
 * front edges at any map size, and a picture drawn at another size or slope
 * only needs its own three points in `Art/manifest.json`.
 */
export function undersideMatrix(projection: Projection, bounds: Bounds, corners: IslandCorners): Affine {
  const to = groundCorners(projection, bounds);
  const from = corners;
  const u1 = sub(from.bottom, from.left);
  const u2 = sub(from.right, from.left);
  const det = u1.x * u2.y - u2.x * u1.y;
  if (det === 0) throw new RangeError('the underside corners must not lie on one line');
  const v1 = sub(to.bottom, to.left);
  const v2 = sub(to.right, to.left);
  // Solve [a c; b d] · [u1 u2] = [v1 v2] for the linear part.
  const a = (v1.x * u2.y - v2.x * u1.y) / det;
  const c = (u1.x * v2.x - u2.x * v1.x) / det;
  const b = (v1.y * u2.y - v2.y * u1.y) / det;
  const d = (u1.x * v2.y - u2.x * v1.y) / det;
  return {
    a,
    b,
    c,
    d,
    tx: to.left.x - (a * from.left.x + c * from.left.y),
    ty: to.left.y - (b * from.left.x + d * from.left.y),
  };
}

/**
 * How far the rock reaches below the ground's bottom corner, in screen pixels
 * at zoom 1, for the New game screen's view of the whole island (674; Andrei,
 * 2026-10-01 16:53). `solid` is where the rock lies within its picture, in the
 * picture's pixels, so blank room round it does not count.
 */
export function undersideDepth(projection: Projection, bounds: Bounds, matrix: Affine, solid: Rect): number {
  const ground = groundCorners(projection, bounds).bottom.y;
  const bottom = solid.y + solid.height;
  const lowest = Math.max(applyAffine(matrix, { x: solid.x, y: bottom }).y, applyAffine(matrix, { x: solid.x + solid.width, y: bottom }).y);
  return Math.max(0, lowest - ground);
}

/**
 * Shapes the rock picture to the ground, in place: `pixels` is its RGBA data,
 * `width` pixels across.
 *
 * [Andrei, 2026-10-01] 679: "Is there a way to blur the edge of the map so it
 * blends better with the stone rim?" He picked a soft edge. The rock is drawn
 * over the ground, and the stone tops that rise above the line through
 * `corners` (the ground's front edges) fade into it: fully drawn on the line
 * and below it, gone `fade` pixels above it.
 *
 * 681: "the rock should extend in SW and SE directions but be aligned with
 * the map edge in NW and NE". Its left and right points sit a little in from
 * its ends, so it reaches right up to the ground's side corners, and it is
 * cut off there: nothing of it lies left of the left corner, right of the
 * right one, or above the ground's two back edges.
 */
export function shapeUnderside(pixels: Uint8ClampedArray, width: number, corners: IslandCorners, fade: number): void {
  const height = pixels.length / 4 / width;
  // Where a pixel lies on the ground, which the picture's corners make a
  // parallelogram: `bottom` plus shares of the way to `left` and to `right`.
  // A share over 1 is past one of the back edges.
  const toLeft = sub(corners.left, corners.bottom);
  const toRight = sub(corners.right, corners.bottom);
  const det = toLeft.x * toRight.y - toRight.x * toLeft.y;
  const pastBackEdges = (x: number, y: number): boolean => {
    const p = { x: x - corners.bottom.x, y: y - corners.bottom.y };
    const alongLeft = (p.x * toRight.y - toRight.x * p.y) / det;
    const alongRight = (toLeft.x * p.y - p.x * toLeft.y) / det;
    return alongLeft > 1 || alongRight > 1;
  };
  for (let x = 0; x < width; x++) {
    const across = x + 0.5;
    const outside = across < corners.left.x || across > corners.right.x;
    const [from, to] = across <= corners.bottom.x ? [corners.left, corners.bottom] : [corners.bottom, corners.right];
    const edge = from.y + ((to.y - from.y) * (across - from.x)) / (to.x - from.x);
    for (let y = 0; y < height; y++) {
      const down = y + 0.5;
      const alpha = (y * width + x) * 4 + 3;
      if (outside) pixels[alpha] = 0;
      else if (down >= edge) break;
      else if (pastBackEdges(across, down)) pixels[alpha] = 0;
      else pixels[alpha] = Math.round(pixels[alpha]! * Math.max(0, 1 - (edge - down) / fade));
    }
  }
}

/**
 * Turns the rock's moss and ivy towards the map's forest green, in place:
 * `pixels` is the picture's RGBA data.
 *
 * [Andrei, 2026-10-02] "The green on the background rocks and roots that
 * extend down from the "skyholm" does not quite match what is prominently
 * used in the map. Can we make them agree a little more?" 830: he picked the
 * rock's greens moving all the way to the forest's, the map left as it is,
 * "but I think the rock's green is too bright, it needs to be darker" (831).
 *
 * A green's hue turns by `hue` degrees, its saturation is scaled by
 * `saturation`, and it is darkened by `darken` (0 leaves it as bright, 1 makes
 * it black). Only greens change: the stone and roots, which are browns and
 * yellows below hue 42, the greyish pixels, and the palest sunlit spots stay
 * as drawn, and a pixel near those limits changes partly, so moss shades off
 * into the stone rather than ending in a hard line.
 */
export function turnGreens(pixels: Uint8ClampedArray, greens: IslandGreens): void {
  if (greens.hue === 0 && greens.saturation === 1 && greens.darken === 0) return;
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i + 3] as number) === 0) continue;
    const r = (pixels[i] as number) / 255;
    const g = (pixels[i + 1] as number) / 255;
    const b = (pixels[i + 2] as number) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma === 0) continue;
    const lightness = (max + min) / 2;
    const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
    const hue = 60 * (max === r ? (((g - b) / chroma) % 6 + 6) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4);
    const share =
      ramp(hue, GREEN_HUES.from, GREEN_HUES.full) *
      ramp(hue, GREEN_HUES.to, GREEN_HUES.to - (GREEN_HUES.full - GREEN_HUES.from)) *
      ramp(saturation, GREEN_SATURATION.from, GREEN_SATURATION.full) *
      ramp(lightness, GREEN_LIGHTNESS.none, GREEN_LIGHTNESS.full);
    if (share === 0) continue;
    const [r2, g2, b2] = hslToRgb(
      (hue + greens.hue * share + 360) % 360,
      Math.min(1, saturation * (1 + (greens.saturation - 1) * share)),
      lightness,
    );
    const shade = 1 - greens.darken * share;
    pixels[i] = Math.round(r2 * shade * 255);
    pixels[i + 1] = Math.round(g2 * shade * 255);
    pixels[i + 2] = Math.round(b2 * shade * 255);
  }
}

/**
 * Which hues count as green: none below `from` (the stone's browns and
 * yellows), all from `full`, and none past `to` (blues), shading off over as
 * many degrees there as between `from` and `full`.
 */
const GREEN_HUES = { from: 42, full: 50, to: 160 } as const;
/** Greyish pixels, below `from` in HSL saturation, are not greens; from `full` they are. */
const GREEN_SATURATION = { from: 0.15, full: 0.3 } as const;
/**
 * The palest pixels, from `none` in HSL lightness, are sunlit spots on the
 * stone and stay as drawn; up to `full` they are greens. Turned and darkened,
 * they showed as grey-green specks on the stone.
 */
const GREEN_LIGHTNESS = { full: 0.6, none: 0.72 } as const;

/** 0 at `from`, 1 at `full`, in a straight line between and clamped outside. */
function ramp(value: number, from: number, full: number): number {
  return Math.min(1, Math.max(0, (value - from) / (full - from)));
}

/** HSL (hue in degrees, saturation and lightness 0 to 1) to RGB 0 to 1. */
function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const m = lightness - chroma / 2;
  const [r, g, b] =
    sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return [r + m, g + m, b + m];
}

/** `matrix` applied to a point. */
export function applyAffine(matrix: Affine, point: Point): Point {
  return { x: matrix.a * point.x + matrix.c * point.y + matrix.tx, y: matrix.b * point.x + matrix.d * point.y + matrix.ty };
}

function sub(p: Point, q: Point): Point {
  return { x: p.x - q.x, y: p.y - q.y };
}
