import { REWARD_KINDS, type RewardKind } from '@adventure/config';
import { CanvasSource, Rectangle, Texture, type TextureSource } from 'pixi.js';
import { atlasOf, type ArtCatalog, type SpriteRef } from '../../art/catalog.ts';
import type { IconBacking } from '../../art/manifest.ts';
import type { Atlas } from '../../art/atlas.ts';
import {
  adjustColors,
  hexToRgb,
  keyShadows,
  outlinePictures,
  solidBands,
  solidBounds,
  solidCircle,
  standingAnchor,
  typicalSpan,
  type Rect,
} from '../../art/pixels.ts';
import { shapeUnderside, turnGreens } from '../island.ts';
import { SHAPE_BANDS, type SpriteShape } from '../placement.ts';

/**
 * `Art/` turned into GPU textures, once, when the page opens.
 *
 * Every sheet goes through the same four steps, so a replacement sheet needs
 * nothing but its files and its line in `Art/manifest.json`:
 *
 * 1. its baked-in shadow colours, if the manifest lists any, become a
 *    translucent shadow (`keyShadows`), and any `adjustments` the manifest
 *    lists for it are made: brighter or richer colour (`adjustColors`), a
 *    contour round each picture (`outlinePictures`);
 * 2. each sprite's solid extent is measured, and the median of those is the
 *    sheet's typical span, which the manifest's sizes are relative to; each
 *    extent, and where the picture lies within it band by band, is also kept
 *    as the sprite's shape, which is where the scene lets it stand;
 * 3. the sheet is scaled down so that span is at most `MAX_TYPICAL_PX` — the
 *    supplied sheets are drawn several times larger than they ever appear, and
 *    uploading them whole would cost a phone a few hundred megabytes of GPU
 *    memory;
 * 4. one texture per sprite is cut from the result, mipmapped so a map zoomed
 *    out does not shimmer.
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
  /** Each sprite's solid picture relative to where it stands, in typical spans; in atlas order. */
  readonly shapes: readonly SpriteShape[];
}

export interface LoadedArt {
  readonly catalog: ArtCatalog;
  sheet(name: string): SheetTextures;
  frame(ref: SpriteRef): Texture;
  /** A sprite's measured shape, for placing it (`sceneModel.ts`). */
  shape(ref: SpriteRef): SpriteShape;
  /** A reward icon, trimmed to its picture so its size is the size it looks. */
  icon(kind: RewardKind): Texture;
  /** A sprite cut out on its own at full resolution, for repeating: terrain textures, the road brush. */
  tile(ref: SpriteRef): Texture;
  /** [Q170] The rock under the map's front edges, as supplied. */
  readonly underside: Texture;
  /** Where the rock itself lies within its picture, in the picture's pixels: what the New game screen frames (674). */
  readonly undersideSolid: Rect;
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
      const canvas = iconCanvas(image, kind, catalog.manifest.icons.backing);
      const pixels = context(canvas).getImageData(0, 0, canvas.width, canvas.height);
      const whole = { x: 0, y: 0, width: canvas.width, height: canvas.height };
      const solid = solidBounds(pixels.data, canvas.width, whole) ?? whole;
      const source = mipmapped(canvas).source;
      icons.set(kind, new Texture({ source, frame: new Rectangle(solid.x, solid.y, solid.width, solid.height) }));
    }),
  );

  const undersideCanvas = drawScaled(await loadImage(catalog.islandUrls.underside), 1);
  const undersideWhole = { x: 0, y: 0, width: undersideCanvas.width, height: undersideCanvas.height };
  const undersidePixels = context(undersideCanvas).getImageData(0, 0, undersideCanvas.width, undersideCanvas.height);
  // [679, 681] Its stone tops fade into the ground's edge, and it ends where the
  // ground does; [830, 831] its moss takes the forest's green.
  const { corners, fade, greens } = catalog.manifest.island.underside;
  shapeUnderside(undersidePixels.data, undersideCanvas.width, corners, fade);
  turnGreens(undersidePixels.data, greens);
  context(undersideCanvas).putImageData(undersidePixels, 0, 0);
  const undersideSolid = solidBounds(undersidePixels.data, undersideCanvas.width, undersideWhole) ?? undersideWhole;
  const underside = mipmapped(undersideCanvas);

  const sheetOf = (name: string): SheetTextures => {
    const sheet = sheets.get(name);
    if (sheet === undefined) throw new Error(`no textures for ${name}`);
    return sheet;
  };

  return {
    catalog,
    underside,
    undersideSolid,
    sheet: sheetOf,
    frame: (ref) => {
      const frame = sheetOf(ref.sheet).frames[ref.index];
      if (frame === undefined) throw new Error(`${ref.sheet} has no sprite ${ref.index}`);
      return frame;
    },
    shape: (ref) => {
      const shape = sheetOf(ref.sheet).shapes[ref.index];
      if (shape === undefined) throw new Error(`${ref.sheet} has no sprite ${ref.index}`);
      return shape;
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
  if (shadows !== undefined) keyShadows(data.data, full.width, shadows, catalog.manifest.shadows.opacity);
  const adjustment = catalog.manifest.adjustments.get(atlas.name);
  if (adjustment !== undefined) adjustColors(data.data, adjustment.brightness, adjustment.saturation);

  let extents = atlas.sprites.map((sprite) => solidBounds(data.data, full.width, sprite));
  // Measured before any contour, so a contour adds to the picture's size
  // rather than shrinking the picture inside it.
  const typicalOriginal = typicalSpan(extents, Math.max(atlas.cellWidth, atlas.cellHeight));
  const outline = adjustment?.outline ?? null;
  if (outline !== null) {
    outlinePictures(data.data, full.width, atlas.sprites, outline.width * typicalOriginal, hexToRgb(outline.color));
    extents = atlas.sprites.map((sprite) => solidBounds(data.data, full.width, sprite));
  }
  if (shadows !== undefined || adjustment !== undefined) fullContext.putImageData(data, 0, 0);

  const scale = Math.min(1, MAX_TYPICAL_PX / typicalOriginal);
  const scaled = drawScaled(full, scale);
  const source = mipmapped(scaled).source;
  const anchors = atlas.sprites.map((sprite, index) => standingAnchor(sprite, extents[index] ?? null));
  const frames = atlas.sprites.map((sprite, index) => frameTexture(source, sprite, anchors[index] ?? sprite.anchor, scale));

  const shapes = atlas.sprites.map((sprite, index): SpriteShape => {
    const extent = extents[index] ?? sprite;
    const anchor = anchors[index] ?? sprite.anchor;
    const footX = sprite.x + anchor.x;
    const footY = sprite.y + anchor.y;
    const bands = solidBands(data.data, full.width, extent, SHAPE_BANDS).flatMap((band, at) => {
      if (band === null) return [];
      const top = extent.y + (extent.height * at) / SHAPE_BANDS;
      const bottom = extent.y + (extent.height * (at + 1)) / SHAPE_BANDS;
      return [
        {
          left: (band.left - footX) / typicalOriginal,
          top: (top - footY) / typicalOriginal,
          right: (band.right - footX) / typicalOriginal,
          bottom: (bottom - footY) / typicalOriginal,
        },
      ];
    });
    return {
      left: (extent.x - footX) / typicalOriginal,
      top: (extent.y - footY) / typicalOriginal,
      right: (extent.x + extent.width - footX) / typicalOriginal,
      bottom: (extent.y + extent.height - footY) / typicalOriginal,
      bands,
    };
  });
  const sheet: SheetTextures = { atlas, frames, scale, typical: typicalOriginal * scale, shapes };
  return { sheet, full };
}

function frameTexture(
  source: TextureSource,
  sprite: Atlas['sprites'][number],
  anchor: { readonly x: number; readonly y: number },
  scale: number,
): Texture {
  const frame = new Rectangle(sprite.x * scale, sprite.y * scale, sprite.width * scale, sprite.height * scale);
  return new Texture({
    source,
    frame,
    defaultAnchor: { x: anchor.x / sprite.width, y: anchor.y / sprite.height },
  });
}

/** Reward icons are drawn at most this many pixels across. */
const ICON_PX = 128;

/**
 * How far inside a filled icon's picture its disc stops, as a share of the
 * picture's width: half the black rim round the round icons, so the disc's
 * edge is hidden under the rim and never shows round it.
 */
const FILLED_INSET = 0.02;

/**
 * One reward icon as the map draws it (Q61): on a disc with a contour if the
 * manifest circles it, over a disc filling its gaps if it fills it, otherwise
 * as drawn.
 */
function iconCanvas(image: HTMLImageElement, kind: RewardKind, backing: IconBacking): HTMLCanvasElement {
  const contour = backing.circled[kind];
  if (contour !== undefined) {
    const full = drawScaled(image, 1);
    const circle = solidCircle(context(full).getImageData(0, 0, full.width, full.height).data, full.width, full.height);
    const fit = circle ?? { x: full.width / 2, y: full.height / 2, r: Math.max(full.width, full.height) / 2 };
    const canvas = makeCanvas(ICON_PX, ICON_PX);
    const ctx = context(canvas);
    const middle = ICON_PX / 2;
    disc(ctx, middle, middle, middle, contour);
    disc(ctx, middle, middle, middle - backing.contour * ICON_PX, backing.fill);
    const scale = (backing.picture * ICON_PX) / (2 * fit.r);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, middle - fit.x * scale, middle - fit.y * scale, image.width * scale, image.height * scale);
    return canvas;
  }
  const canvas = drawScaled(image, Math.min(1, ICON_PX / Math.max(image.width, image.height)));
  if (!backing.filled.includes(kind)) return canvas;
  const whole = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const solid = solidBounds(context(canvas).getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, whole) ?? whole;
  const filled = makeCanvas(canvas.width, canvas.height);
  const ctx = context(filled);
  const across = Math.min(solid.width, solid.height);
  disc(ctx, solid.x + solid.width / 2, solid.y + solid.height / 2, across / 2 - FILLED_INSET * across, backing.fill);
  ctx.drawImage(canvas, 0, 0);
  return filled;
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
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
