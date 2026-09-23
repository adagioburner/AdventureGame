import { REWARD_KINDS, TERRAINS, type GuardType, type RewardKind } from '@adventure/config';
import type { Poi } from '@adventure/core';
import { ArtError, array, nonNegative, parseAtlas, positive, record, spriteIndex, string, type Atlas } from './atlas.ts';
import { parseManifest, poiArtRow, sheetsNamed, type ArtManifest, type PoiArtRow } from './manifest.ts';

/**
 * Everything in `Art/` the client needs, read and cross-checked, before a
 * single pixel is loaded.
 *
 * Built from plain inputs — parsed JSON and URLs keyed by their path under
 * `Art/` — so the same checks run in a test against the real folder and in the
 * browser on start-up, and a bad art drop fails with every problem named at
 * once rather than as a blank map.
 */
export interface ArtFiles {
  /** Parsed JSON, keyed by path under `Art/`: `"Plains_Fields_atlas.json"`. */
  readonly json: ReadonlyMap<string, unknown>;
  /** Where each image can be fetched from, keyed the same way: `"Icons/gold.png"`. */
  readonly urls: ReadonlyMap<string, string>;
}

export interface ArtCatalog {
  readonly manifest: ArtManifest;
  /** Every sheet the manifest names, by `<Name>`. */
  readonly atlases: ReadonlyMap<string, Atlas>;
  readonly portraits: readonly Portrait[];
  sheetUrl(name: string): string;
  iconUrl(kind: RewardKind): string;
}

/** A sprite, by sheet and position in that sheet's `sprites` list. */
export interface SpriteRef {
  readonly sheet: string;
  readonly index: number;
}

/**
 * Head-and-shoulders boxes cropped from the figurines until the real avatar
 * set arrives (Q26). Cell-relative, like an atlas anchor.
 */
export interface Portrait {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function sheetFile(name: string): string {
  return `${name}_sheet.png`;
}

export function atlasFile(name: string): string {
  return `${name}_atlas.json`;
}

export function buildArtCatalog(files: ArtFiles): ArtCatalog {
  const manifestJson = files.json.get('manifest.json');
  if (manifestJson === undefined) throw new ArtError('Art/manifest.json is missing');
  const manifest = parseManifest(manifestJson);

  const problems: string[] = [];
  const atlases = new Map<string, Atlas>();
  for (const name of sheetsNamed(manifest)) {
    const json = files.json.get(atlasFile(name));
    if (json === undefined) problems.push(`${atlasFile(name)} is missing`);
    if (!files.urls.has(sheetFile(name))) problems.push(`${sheetFile(name)} is missing`);
    if (json === undefined) continue;
    try {
      atlases.set(name, parseAtlas(name, json));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const kind of REWARD_KINDS) {
    if (!files.urls.has(manifest.icons.files[kind])) problems.push(`${manifest.icons.files[kind]} is missing`);
  }

  const check = (what: () => void): void => {
    try {
      what();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  };
  const atlas = (name: string): Atlas | undefined => atlases.get(name);

  for (const terrain of TERRAINS) {
    const texture = atlas(manifest.terrain[terrain].texture);
    if (texture !== undefined && texture.sprites[0]?.tiles !== 'both') {
      problems.push(`${atlasFile(texture.name)}: a terrain texture must tile both ways ("tiles": "both")`);
    }
  }
  const roads = atlas(manifest.roads.sheet);
  if (roads !== undefined) {
    check(() => {
      const sprite = roads.sprites[spriteIndex(roads, manifest.roads.sprite)];
      if (sprite?.tiles !== 'horizontal') {
        problems.push(`${atlasFile(roads.name)}: ${manifest.roads.sprite} must tile ("tiles": "horizontal")`);
      }
    });
  }
  const markers = atlas(manifest.moveProspect.sheet);
  if (markers !== undefined) {
    const prospect = manifest.moveProspect;
    for (const id of [
      ...Object.values(prospect.dot),
      ...Object.values(prospect.cross),
      prospect.waypoint,
      prospect.active,
    ]) {
      check(() => spriteIndex(markers, id));
    }
  }

  let portraits: readonly Portrait[] = [];
  check(() => {
    portraits = parsePortraits(files.json.get(manifest.portraits), manifest.portraits);
  });
  const figurines = atlas(manifest.figurines.sheet);
  if (figurines !== undefined) {
    for (const portrait of portraits) check(() => spriteIndex(figurines, portrait.id));
  }

  if (problems.length > 0) {
    throw new ArtError(`Art/ does not match Art/manifest.json:\n  ${problems.join('\n  ')}`);
  }

  return {
    manifest,
    atlases,
    portraits,
    sheetUrl(name) {
      const url = files.urls.get(sheetFile(name));
      if (url === undefined) throw new ArtError(`${sheetFile(name)} is missing`);
      return url;
    },
    iconUrl(kind) {
      const url = files.urls.get(manifest.icons.files[kind]);
      if (url === undefined) throw new ArtError(`${manifest.icons.files[kind]} is missing`);
      return url;
    },
  };
}

export function atlasOf(catalog: ArtCatalog, name: string): Atlas {
  const atlas = catalog.atlases.get(name);
  if (atlas === undefined) throw new ArtError(`no atlas loaded for ${name}`);
  return atlas;
}

/**
 * The picture a POI is drawn with.
 *
 * `Poi.artVariant` is a stable index drawn from the map's PRNG, so it becomes a
 * position in the chosen sheet's sprite list, modulo its length: the same map
 * always shows the same pictures, and no sheet's sprite count is baked into
 * the generator. It is the only generator field the scene reads besides the
 * rules' own (terrain, reward, guard); `remoteness`, `group` and the map's
 * `attempts` are never looked at.
 */
export interface PoiArt {
  readonly row: PoiArtRow;
  readonly sprite: SpriteRef;
  /** The contour colour's guard type, or `null` for an unguarded POI. */
  readonly contour: GuardType | null;
}

export function poiArt(catalog: ArtCatalog, poi: Poi): PoiArt {
  const guard = poi.guard?.type ?? null;
  const row = poiArtRow(catalog.manifest, poi.terrain, poi.reward.kind, guard);
  const count = atlasOf(catalog, row.sheet).sprites.length;
  return {
    row,
    sprite: { sheet: row.sheet, index: wrapIndex(poi.artVariant, count) },
    contour: guard,
  };
}

export function wrapIndex(variant: number, count: number): number {
  return ((Math.trunc(variant) % count) + count) % count;
}

function parsePortraits(json: unknown, file: string): Portrait[] {
  if (json === undefined) throw new ArtError(`${file} is missing`);
  const root = record(json, file);
  return array(root['portraits'], `${file}: portraits`).map((entry, index) => {
    const where = `${file}: portraits[${index}]`;
    const portrait = record(entry, where);
    return {
      id: string(portrait['id'], `${where}.id`),
      x: nonNegative(portrait['x'], `${where}.x`),
      y: nonNegative(portrait['y'], `${where}.y`),
      width: positive(portrait['width'], `${where}.width`),
      height: positive(portrait['height'], `${where}.height`),
    };
  });
}
