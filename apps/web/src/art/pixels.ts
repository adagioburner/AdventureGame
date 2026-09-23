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
 * as a pale blob on the ground.
 *
 * `opacity` stays below `SOLID_ALPHA / 255`, so a keyed shadow never counts
 * as picture when the sprite's extent is measured.
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
  // pixels whose solid ones are all rim-range greys. Faint pixels are not
  // judged: a canvas stores colour premultiplied by alpha, so reading one back
  // can move a nearly clear pixel's grey well outside the range.
  const visited = new Uint8Array(keyed.length);
  for (let start = 0; start < keyed.length; start++) {
    if (keyed[start] === 1 || visited[start] === 1 || (pixels[start * 4 + 3] as number) === 0) continue;
    const patch = [start];
    visited[start] = 1;
    let shadow = true;
    for (let k = 0; k < patch.length; k++) {
      const p = patch[k] as number;
      if (shadow && (pixels[p * 4 + 3] as number) >= SOLID_ALPHA && !near(p * 4, 3, 8, 16)) shadow = false;
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

/**
 * Lighten and enrich a sheet's colours in place (`Art/manifest.json`'s
 * `adjustments`). `brightness` raises each channel `c` in 0..1 to
 * `c ** (1 / brightness)`, so darks and midtones lift most and white stays
 * white instead of clipping; `saturation` then scales each colour's distance
 * from its own grey (Rec. 601 luma). Alpha is untouched, and a keyed shadow,
 * being black, stays black.
 */
export function adjustColors(pixels: Uint8ClampedArray, brightness: number, saturation: number): void {
  if (brightness === 1 && saturation === 1) return;
  const lift = new Uint8ClampedArray(256);
  for (let c = 0; c < 256; c++) lift[c] = Math.round(255 * (c / 255) ** (1 / brightness));
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i + 3] as number) === 0) continue;
    const r = lift[pixels[i] as number] as number;
    const g = lift[pixels[i + 1] as number] as number;
    const b = lift[pixels[i + 2] as number] as number;
    const grey = 0.299 * r + 0.587 * g + 0.114 * b;
    pixels[i] = grey + (r - grey) * saturation;
    pixels[i + 1] = grey + (g - grey) * saturation;
    pixels[i + 2] = grey + (b - grey) * saturation;
  }
}

/**
 * Draw a contour `radius` pixels thick round the picture in each of `rects`
 * (a sheet's sprites), in place. The contour lies behind the picture, so the
 * picture's soft edge blends into it rather than into the ground, and over
 * anything else in the cell, a keyed shadow included. Each sprite is
 * outlined within its own rect, so a contour never spills into a neighbour.
 *
 * Distances are exact (a Euclidean distance transform), so the contour is as
 * thick on a diagonal as along an edge, and its outer edge is anti-aliased.
 */
export function outlinePictures(
  pixels: Uint8ClampedArray,
  stride: number,
  rects: readonly Rect[],
  radius: number,
  color: readonly [number, number, number],
): void {
  const rows = pixels.length / 4 / stride;
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const width = Math.min(stride, Math.floor(rect.x + rect.width)) - x0;
    const height = Math.min(rows, Math.floor(rect.y + rect.height)) - y0;
    if (width <= 0 || height <= 0) continue;
    const solid = new Uint8Array(width * height);
    let any = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if ((pixels[((y0 + y) * stride + x0 + x) * 4 + 3] as number) >= SOLID_ALPHA) {
          solid[y * width + x] = 1;
          any = true;
        }
      }
    }
    if (!any) continue;
    const distance = squaredDistances(solid, width, height);
    // A pixel `d` from the nearest picture pixel's centre lies between
    // `d - 1` and `d` past the picture's edge, so the contour covers
    // `radius + 1 - d` of it.
    const reach = (radius + 1) ** 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const i = ((y0 + y) * stride + x0 + x) * 4;
        const alpha = (pixels[i + 3] as number) / 255;
        if (solid[p] === 1) {
          // The picture over its contour: opaque, its soft edge tinted by it.
          for (let c = 0; c < 3; c++) pixels[i + c] = (pixels[i + c] as number) * alpha + color[c]! * (1 - alpha);
          pixels[i + 3] = 255;
          continue;
        }
        if ((distance[p] as number) >= reach) continue;
        const cover = Math.min(1, radius + 1 - Math.sqrt(distance[p] as number));
        // The contour over whatever else is there.
        const out = cover + alpha * (1 - cover);
        for (let c = 0; c < 3; c++) {
          pixels[i + c] = (color[c]! * cover + (pixels[i + c] as number) * alpha * (1 - cover)) / out;
        }
        pixels[i + 3] = out * 255;
      }
    }
  }
}

/**
 * Squared distance from every cell to the nearest set cell of `mask`, by
 * Felzenszwalb and Huttenlocher's separable transform: columns, then rows.
 */
function squaredDistances(mask: Uint8Array, width: number, height: number): Float64Array {
  const far = (width + height) ** 2;
  const grid = new Float64Array(width * height);
  for (let p = 0; p < grid.length; p++) grid[p] = mask[p] === 1 ? 0 : far;
  const size = Math.max(width, height);
  const line = new Float64Array(size);
  const hull = new Int32Array(size);
  const bounds = new Float64Array(size + 1);
  // One column or row: `count` cells from `first`, `step` apart.
  const pass = (first: number, step: number, count: number): void => {
    for (let k = 0; k < count; k++) line[k] = grid[first + k * step] as number;
    let top = 0;
    hull[0] = 0;
    bounds[0] = -Infinity;
    bounds[1] = Infinity;
    for (let q = 1; q < count; q++) {
      const fq = (line[q] as number) + q * q;
      let v = hull[top] as number;
      let s = (fq - ((line[v] as number) + v * v)) / (2 * (q - v));
      while (s <= (bounds[top] as number)) {
        top--;
        v = hull[top] as number;
        s = (fq - ((line[v] as number) + v * v)) / (2 * (q - v));
      }
      top++;
      hull[top] = q;
      bounds[top] = s;
      bounds[top + 1] = Infinity;
    }
    let at = 0;
    for (let q = 0; q < count; q++) {
      while ((bounds[at + 1] as number) < q) at++;
      const v = hull[at] as number;
      grid[first + q * step] = (q - v) * (q - v) + (line[v] as number);
    }
  };
  for (let x = 0; x < width; x++) pass(x, width, height);
  for (let y = 0; y < height; y++) pass(y * width, 1, width);
  return grid;
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

export function hexToRgb(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
