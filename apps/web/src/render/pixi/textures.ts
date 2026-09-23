import { REWARD_KINDS, type GuardType, type RewardKind } from '@adventure/config';
import { CanvasSource, Rectangle, Texture, type TextureSource } from 'pixi.js';
import { atlasOf, type ArtCatalog, type SpriteRef } from '../../art/catalog.ts';
import type { Atlas } from '../../art/atlas.ts';
import { keyShadows, silhouette, solidBounds, typicalSpan } from '../../art/pixels.ts';

/**
 * `Art/` turned into GPU textures, once, when the page opens.
 *
 * Every sheet goes through the same four steps, so a replacement sheet needs
 * nothing but its files and its line in `Art/manifest.json`:
 *
 * 1. its baked-in shadow colours, if the manifest lists any, become a
 *    translucent shadow (`keyShadows`);
 * 2. each sprite's solid extent is measured, and the median of those is the
 *    sheet's typical span, which the manifest's sizes are relative to;
 * 3. the sheet is scaled down so that span is at most `MAX_TYPICAL_PX` — the
 *    supplied sheets are drawn several times larger than they ever appear, and
 *    uploading them whole would cost a phone a few hundred megabytes of GPU
 *    memory;
 * 4. one texture per sprite is cut from the result, mipmapped so a map zoomed
 *    out does not shimmer.
 *
 * A guardian's contour (§3) is built from the same scaled sheet on first use.
 */
export const MAX_TYPICAL_PX = 320;

export interface SheetTextures {
  readonly atlas: Atlas;
  /** One per sprite, in atlas order. */
  readonly frames: readonly Texture[];
  /** Texture pixels per pixel of the original sheet. */
  readonly scale: number;
  /** The typical sprite span, in texture pixels. */
  readonly typical: number;
  /** The same frames with a contour of `radius` texture pixels in the guard's colour. */
  contoured(guard: GuardType, radius: number): readonly Texture[];
}

export interface LoadedArt {
  readonly catalog: ArtCatalog;
  sheet(name: string): SheetTextures;
  frame(ref: SpriteRef): Texture;
  icon(kind: RewardKind): Texture;
  /** A sprite cut out on its own at full resolution, for repeating: terrain textures, the road brush. */
  tile(ref: SpriteRef): Texture;
}

export async function loadArt(catalog: ArtCatalog): Promise<LoadedArt> {
  const names = [...catalog.atlases.keys()];
  const sheets = new Map<string, SheetTextures>();
  const tiles = new Map<string, Texture>();
  const fullSize = new Map<string, HTMLCanvasElement>();

  await Promise.all(
    names.map(async (name) => {
      const image = await loadImage(catalog.sheetUrl(name));
      const { sheet, full } = processSheet(catalog, atlasOf(catalog, name), image);
      sheets.set(name, sheet);
      // Only repeatable sprites keep their full-resolution canvas around.
      if (sheet.atlas.sprites.some((sprite) => sprite.tiles !== null)) fullSize.set(name, full);
    }),
  );

  const icons = new Map<RewardKind, Texture>();
  await Promise.all(
    REWARD_KINDS.map(async (kind) => {
      const image = await loadImage(catalog.iconUrl(kind));
      const scale = Math.min(1, 128 / Math.max(image.width, image.height));
      icons.set(kind, mipmapped(drawScaled(image, scale)));
    }),
  );

  const sheetOf = (name: string): SheetTextures => {
    const sheet = sheets.get(name);
    if (sheet === undefined) throw new Error(`no textures for ${name}`);
    return sheet;
  };

  return {
    catalog,
    sheet: sheetOf,
    frame: (ref) => {
      const frame = sheetOf(ref.sheet).frames[ref.index];
      if (frame === undefined) throw new Error(`${ref.sheet} has no sprite ${ref.index}`);
      return frame;
    },
    icon: (kind) => {
      const icon = icons.get(kind);
      if (icon === undefined) throw new Error(`no icon for ${kind}`);
      return icon;
    },
    tile: (ref) => {
      const key = `${ref.sheet}#${ref.index}`;
      const cached = tiles.get(key);
      if (cached !== undefined) return cached;
      const full = fullSize.get(ref.sheet);
      const sprite = sheetOf(ref.sheet).atlas.sprites[ref.index];
      if (full === undefined || sprite === undefined) throw new Error(`${key} is not a repeatable sprite`);
      const canvas = makeCanvas(sprite.width, sprite.height);
      context(canvas).drawImage(full, sprite.x, sprite.y, sprite.width, sprite.height, 0, 0, sprite.width, sprite.height);
      const texture = mipmapped(canvas);
      texture.source.style.addressMode = 'repeat';
      texture.source.style.update();
      tiles.set(key, texture);
      return texture;
    },
  };
}

function processSheet(
  catalog: ArtCatalog,
  atlas: Atlas,
  image: HTMLImageElement,
): { sheet: SheetTextures; full: HTMLCanvasElement } {
  const full = makeCanvas(image.width, image.height);
  const fullContext = context(full);
  fullContext.drawImage(image, 0, 0);
  const data = fullContext.getImageData(0, 0, full.width, full.height);

  const shadows = catalog.manifest.shadows.sheets.get(atlas.name);
  if (shadows !== undefined) {
    keyShadows(data.data, full.width, shadows, catalog.manifest.shadows.opacity);
    fullContext.putImageData(data, 0, 0);
  }

  const extents = atlas.sprites.map((sprite) => solidBounds(data.data, full.width, sprite));
  const typicalOriginal = typicalSpan(extents, Math.max(atlas.cellWidth, atlas.cellHeight));
  const scale = Math.min(1, MAX_TYPICAL_PX / typicalOriginal);
  const scaled = drawScaled(full, scale);
  const source = mipmapped(scaled).source;
  const frames = atlas.sprites.map((sprite) => frameTexture(source, sprite, scale));

  const contours = new Map<string, readonly Texture[]>();
  const sheet: SheetTextures = {
    atlas,
    frames,
    scale,
    typical: typicalOriginal * scale,
    contoured(guard, radius) {
      const key = `${guard}:${radius.toFixed(1)}`;
      const cached = contours.get(key);
      if (cached !== undefined) return cached;
      const outlined = contourSheet(scaled, atlas, scale, catalog.manifest.guards.colors[guard], radius);
      const outlinedSource = mipmapped(outlined).source;
      const result = atlas.sprites.map((sprite) => frameTexture(outlinedSource, sprite, scale));
      contours.set(key, result);
      return result;
    },
  };
  return { sheet, full };
}

/**
 * [SOURCE §3] A guardian's image carries "a red (fighting) or purple (magic)
 * contour". The supplied sheets have none, so it is drawn here: the solid
 * silhouette in the guard's colour, stamped in a ring around each sprite, with
 * the sprite (and its translucent shadow) on top.
 */
function contourSheet(
  scaled: HTMLCanvasElement,
  atlas: Atlas,
  scale: number,
  color: string,
  radius: number,
): HTMLCanvasElement {
  const mask = makeCanvas(scaled.width, scaled.height);
  const maskContext = context(mask);
  maskContext.drawImage(scaled, 0, 0);
  const data = maskContext.getImageData(0, 0, mask.width, mask.height);
  silhouette(data.data, mask.width, color);
  maskContext.putImageData(data, 0, 0);

  const out = makeCanvas(scaled.width, scaled.height);
  const outContext = context(out);
  // Two rings of stamps, so a wide contour has no gaps between them.
  const stamps: [number, number][] = [];
  for (const ring of [radius * 0.5, radius]) {
    const steps = Math.max(12, Math.ceil(ring * 2));
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      stamps.push([Math.cos(angle) * ring, Math.sin(angle) * ring]);
    }
  }
  for (const sprite of atlas.sprites) {
    outContext.save();
    outContext.beginPath();
    outContext.rect(sprite.x * scale, sprite.y * scale, sprite.width * scale, sprite.height * scale);
    outContext.clip();
    for (const [dx, dy] of stamps) outContext.drawImage(mask, dx, dy);
    outContext.restore();
  }
  outContext.drawImage(scaled, 0, 0);
  return out;
}

function frameTexture(source: TextureSource, sprite: Atlas['sprites'][number], scale: number): Texture {
  const frame = new Rectangle(sprite.x * scale, sprite.y * scale, sprite.width * scale, sprite.height * scale);
  return new Texture({
    source,
    frame,
    defaultAnchor: { x: sprite.anchor.x / sprite.width, y: sprite.anchor.y / sprite.height },
  });
}

function mipmapped(canvas: HTMLCanvasElement): Texture {
  const source = new CanvasSource({ resource: canvas, autoGenerateMipmaps: true, scaleMode: 'linear' });
  return new Texture({ source });
}

function drawScaled(image: CanvasImageSource & { width: number; height: number }, scale: number): HTMLCanvasElement {
  const canvas = makeCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const ctx = context(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('this browser gave no 2D canvas');
  return ctx;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`could not load ${url}`));
    image.src = url;
  });
}
