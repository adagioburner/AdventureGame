import { useEffect, useState, type CSSProperties } from 'react';
import type { RewardKind } from '@adventure/config';
import { spriteIndex } from '../art/atlas.ts';
import { atlasOf, type ArtCatalog } from '../art/catalog.ts';
import { STAT_LABEL } from './journal.ts';

/**
 * Pictures in the page around the map, cut from the same sheets the map draws
 * with and chosen through the same manifest, so a swapped sheet shows up here
 * too.
 */

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const sizes = new Map<string, Promise<{ width: number; height: number }>>();

/** A sheet's pixel size, which CSS needs to scale a crop of it. */
function sheetSize(url: string): Promise<{ width: number; height: number }> {
  let found = sizes.get(url);
  if (found === undefined) {
    found = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error(`could not load ${url}`));
      image.src = url;
    });
    sizes.set(url, found);
  }
  return found;
}

/** `box` of the sheet at `url`, scaled to `size` CSS pixels across its larger side. */
function Crop({ url, box, size, label, className }: { url: string; box: Box; size: number; label: string; className?: string }) {
  const [sheet, setSheet] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let live = true;
    sheetSize(url).then((found) => live && setSheet(found), () => undefined);
    return () => {
      live = false;
    };
  }, [url]);
  const scale = size / Math.max(box.width, box.height);
  const style: CSSProperties = {
    width: box.width * scale,
    height: box.height * scale,
    ...(sheet === null
      ? {}
      : {
          backgroundImage: `url("${url}")`,
          backgroundSize: `${sheet.width * scale}px ${sheet.height * scale}px`,
          backgroundPosition: `${-box.x * scale}px ${-box.y * scale}px`,
        }),
  };
  return <span className={`crop ${className ?? ''}`} role="img" aria-label={label} style={style} />;
}

/**
 * [SOURCE §6] A player's avatar, shown beside their name. The avatar set is
 * still to come (Q26); until it lands, the figurine is cropped to its head and
 * shoulders by the box in `Art/player_avatars_portraits.json`.
 */
export function Portrait({ catalog, avatarId, size, label }: { catalog: ArtCatalog; avatarId: string; size: number; label: string }) {
  const sheet = catalog.manifest.figurines.sheet;
  const atlas = atlasOf(catalog, sheet);
  const sprite = atlas.sprites.find((candidate) => candidate.id === avatarId) ?? atlas.sprites[0];
  if (sprite === undefined) return null;
  const portrait = catalog.portraits.find((candidate) => candidate.id === sprite.id);
  const box = portrait === undefined ? sprite : { x: sprite.x + portrait.x, y: sprite.y + portrait.y, width: portrait.width, height: portrait.height };
  return <Crop url={catalog.sheetUrl(sheet)} box={box} size={size} label={label} className="portrait" />;
}

/** A whole figurine, for choosing one at setup. */
export function Figurine({ catalog, avatarId, size }: { catalog: ArtCatalog; avatarId: string; size: number }) {
  const sheet = catalog.manifest.figurines.sheet;
  const atlas = atlasOf(catalog, sheet);
  const sprite = atlas.sprites[spriteIndex(atlas, avatarId)];
  if (sprite === undefined) return null;
  return <Crop url={catalog.sheetUrl(sheet)} box={sprite} size={size} label={avatarId} />;
}

/** One of §4.1's seven icons, which are also the seven stats (§6). */
export function StatIcon({ catalog, kind, size }: { catalog: ArtCatalog; kind: RewardKind; size: number }) {
  return <img className="stat-icon" src={catalog.iconUrl(kind)} alt={STAT_LABEL[kind]} width={size} height={size} />;
}

/**
 * [SOURCE §10] The die-roll animation. While the roll is in flight the eight
 * tumble sprites loop; once it lands, the face whose `value` is the engine's
 * roll is held. No tumble frame is ever held as the result, since none of them
 * is square to the viewer and none reads as settled.
 */
export function Die({ catalog, value, rolling, size }: { catalog: ArtCatalog; value: number; rolling: boolean; size: number }) {
  const sheet = catalog.manifest.dice.sheet;
  const atlas = atlasOf(catalog, sheet);
  const tumble = atlas.sprites.filter((sprite) => sprite.role === 'tumble');
  const face = atlas.sprites.find((sprite) => sprite.role === 'face' && sprite.value === value);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!rolling) return;
    const timer = window.setInterval(() => setFrame((current) => current + 1), 70);
    return () => window.clearInterval(timer);
  }, [rolling]);
  const sprite = rolling ? tumble[frame % Math.max(1, tumble.length)] : face;
  if (sprite === undefined) return <span className="die-fallback">{rolling ? '…' : value}</span>;
  return <Crop url={catalog.sheetUrl(sheet)} box={sprite} size={size} label={rolling ? 'The die is rolling' : `The die shows ${value}`} />;
}
