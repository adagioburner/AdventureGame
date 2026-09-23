/**
 * Pixel work done once, on load, on a sheet's RGBA bytes. Pure functions over
 * a `Uint8ClampedArray` so they run the same in a test as on a canvas.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Anything at least this opaque is part of the picture rather than its shadow. */
export const SOLID_ALPHA = 128;

/**
 * Most supplied sheets bake their drop shadow in as one opaque flat grey
 * (`#bbbbbb`), which would sit on the terrain as a grey patch. Every pixel
 * within one step of a listed colour becomes black at `opacity` instead, so the
 * shadow darkens whatever ground it falls on. Returns how many pixels changed.
 *
 * A shadow's rim is not quite its colour: the artist's export left a band a
 * few pixels wide of near-greys (184–195 around `#bbbbbb`) between it and the
 * clear background. Those are keyed too, but only by growing out from the
 * shadow itself — `RIM_PIXELS` steps into neutral greys near the key — so a
 * knight's grey armour elsewhere in the sprite is never touched.
 *
 * Some shadows also carry patches of their own a shade lighter (190–200 under
 * a horse's hooves, say) that touch no pixel of the key and so are not reached
 * by that growth. A patch lying apart from the picture and made only of those
 * greys is shadow too, and is keyed with it; left alone, each would be drawn
 * as a pale blob on the ground with a ring of guardian contour round it.
 *
 * `opacity` stays below `SOLID_ALPHA / 255`, so a keyed shadow never counts
 * as picture when the sprite's extent is measured or its contour drawn.
 */
export const RIM_PIXELS = 6;

export function keyShadows(
  pixels: Uint8ClampedArray,
  width: number,
  colors: readonly string[],
  opacity: number,
): number {
  const keys = colors.map(hexToRgb);
  const alpha = Math.round(Math.min(opacity, (SOLID_ALPHA - 1) / 255) * 255);
  const height = pixels.length / 4 / width;
  const keyed = new Uint8Array(width * height);
  // Within `below`/`above` of a key on every channel, and at most
  // `tolerance` away from a neutral grey.
  const near = (i: number, tolerance: number, below: number, above: number): boolean => {
    if ((pixels[i + 3] as number) === 0) return false;
    const rgb = [pixels[i] as number, pixels[i + 1] as number, pixels[i + 2] as number];
    if (Math.max(...rgb) - Math.min(...rgb) > tolerance) return false;
    return keys.some((key) => rgb.every((value, c) => value >= key[c]! - below && value <= key[c]! + above));
  };

  let frontier: number[] = [];
  for (let p = 0; p < keyed.length; p++) {
    if (near(p * 4, 2, 1, 1)) {
      keyed[p] = 1;
      frontier.push(p);
    }
  }
  for (let step = 0; step < RIM_PIXELS && frontier.length > 0; step++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % width;
      for (const q of [p - 1, p + 1, p - width, p + width]) {
        if (q < 0 || q >= keyed.length || keyed[q] === 1) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === width - 1)) continue;
        if (near(q * 4, 3, 8, 16)) {
          keyed[q] = 1;
          next.push(q);
        }
      }
    }
    frontier = next;
  }

  // Detached patches of shadow grey: every connected run of visible, unkeyed
  // pixels that holds nothing but rim-range greys.
  const visited = new Uint8Array(keyed.length);
  for (let start = 0; start < keyed.length; start++) {
    if (keyed[start] === 1 || visited[start] === 1 || (pixels[start * 4 + 3] as number) === 0) continue;
    const patch = [start];
    visited[start] = 1;
    let shadow = true;
    for (let k = 0; k < patch.length; k++) {
      const p = patch[k] as number;
      if (shadow && !near(p * 4, 3, 8, 16)) shadow = false;
      const x = p % width;
      for (const q of [p - 1, p + 1, p - width, p + width]) {
        if (q < 0 || q >= keyed.length || keyed[q] === 1 || visited[q] === 1) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === width - 1)) continue;
        if ((pixels[q * 4 + 3] as number) === 0) continue;
        visited[q] = 1;
        patch.push(q);
      }
    }
    if (shadow) for (const p of patch) keyed[p] = 1;
  }

  let changed = 0;
  for (let p = 0; p < keyed.length; p++) {
    if (keyed[p] !== 1) continue;
    const i = p * 4;
    pixels[i + 3] = Math.round((alpha * (pixels[i + 3] as number)) / 255);
    pixels[i] = 0;
    pixels[i + 1] = 0;
    pixels[i + 2] = 0;
    changed++;
  }
  return changed;
}

/** The smallest box inside `rect` holding every solid pixel, or `null` if none. */
export function solidBounds(pixels: Uint8ClampedArray, stride: number, rect: Rect): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const x0 = Math.floor(rect.x);
  const y0 = Math.floor(rect.y);
  for (let y = y0; y < y0 + rect.height; y++) {
    for (let x = x0; x < x0 + rect.width; x++) {
      if ((pixels[(y * stride + x) * 4 + 3] as number) >= SOLID_ALPHA) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * A sheet's typical sprite span: the median, over its sprites, of the larger
 * side of each one's solid extent. `Art/manifest.json`'s sizes are measured
 * against this, which is what lets a replacement sheet at another resolution,
 * or with more padding in its cells, come out the same size on the map.
 */
export function typicalSpan(extents: readonly (Rect | null)[], fallback: number): number {
  const spans = extents
    .filter((extent): extent is Rect => extent !== null)
    .map((extent) => Math.max(extent.width, extent.height))
    .sort((p, q) => p - q);
  const middle = spans[Math.floor(spans.length / 2)];
  return middle ?? fallback;
}

/**
 * Where a sprite stands, cell-relative. The atlas anchor, unless it sits below
 * the picture's lowest solid pixel: most supplied sheets put the anchor at the
 * foot of the baked shadow, which falls towards the viewer, and a guardian
 * stood there floats a good way behind its node. Once the shadow is keyed it is
 * not picture any more, so the sprite stands on its own lowest solid pixel
 * instead. An anchor already inside the picture (a marker's centre, a figure
 * anchored at its feet) is kept as it is.
 */
export function standingAnchor(
  sprite: Rect & { readonly anchor: { readonly x: number; readonly y: number } },
  extent: Rect | null,
): { readonly x: number; readonly y: number } {
  if (extent === null) return sprite.anchor;
  const lowest = extent.y + extent.height - sprite.y;
  return { x: sprite.anchor.x, y: Math.min(sprite.anchor.y, lowest) };
}

/**
 * Turn every solid pixel `color` and every other one clear: a guardian's
 * silhouette, for its contour. Specks of one or two stray pixels — export
 * noise at the edge of a shadow — are dropped first (a morphological
 * opening), or each would come out as its own little ring of contour.
 */
export function silhouette(pixels: Uint8ClampedArray, width: number, color: string): void {
  const [r, g, b] = hexToRgb(color);
  const count = pixels.length / 4;
  const solid = new Uint8Array(count);
  for (let p = 0; p < count; p++) solid[p] = (pixels[p * 4 + 3] as number) >= SOLID_ALPHA ? 1 : 0;
  const neighbours = (p: number): number[] => {
    const x = p % width;
    const around = [p - width, p + width];
    if (x > 0) around.push(p - 1);
    if (x < width - 1) around.push(p + 1);
    return around.filter((q) => q >= 0 && q < count);
  };
  const eroded = new Uint8Array(count);
  for (let p = 0; p < count; p++) eroded[p] = solid[p] === 1 && neighbours(p).every((q) => solid[q] === 1) ? 1 : 0;
  for (let p = 0; p < count; p++) {
    const keep = eroded[p] === 1 || (solid[p] === 1 && neighbours(p).some((q) => eroded[q] === 1));
    const i = p * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = keep ? 255 : 0;
  }
}

export function hexToRgb(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
