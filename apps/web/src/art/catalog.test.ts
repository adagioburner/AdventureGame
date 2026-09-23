import { describe, expect, it } from 'vitest';
import { DEFAULT_RULESET, REWARD_KINDS, TERRAINS, type GuardType, type RewardKind, type Terrain } from '@adventure/config';
import { asNodeId, type Poi } from '@adventure/core';
import { ArtError, atlasExtent } from './atlas.ts';
import { atlasOf, buildArtCatalog, poiArt, sheetFile, wrapIndex, type ArtFiles } from './catalog.ts';
import { ART_FILES } from './files.ts';
import { parseManifest, poiArtRow, sheetsNamed } from './manifest.ts';

/**
 * The real `Art/` folder against the real `Art/manifest.json`. This is the test
 * that tells whoever swaps a picture whether the swap will load — every sheet
 * named, every sprite id, every icon, and every PNG big enough for its atlas.
 */

// The PNG bytes themselves, only for their IHDR header: width and height.
const inlinePngs = import.meta.glob<string>(['../../../../Art/*.png'], {
  query: '?inline',
  import: 'default',
  eager: true,
});

function pngSize(dataUrl: string): { width: number; height: number } {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 1 + 32);
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe('the art catalog built from Art/', () => {
  const catalog = buildArtCatalog(ART_FILES);

  it('finds an atlas and a sheet for every sheet the manifest names', () => {
    for (const name of sheetsNamed(catalog.manifest)) {
      expect(catalog.atlases.has(name), name).toBe(true);
      expect(catalog.sheetUrl(name)).toBeTruthy();
    }
    for (const kind of REWARD_KINDS) expect(catalog.iconUrl(kind)).toBeTruthy();
  });

  it('has every sheet big enough for every sprite its atlas describes', () => {
    for (const name of sheetsNamed(catalog.manifest)) {
      const dataUrl = inlinePngs[`../../../../Art/${sheetFile(name)}`];
      expect(dataUrl, sheetFile(name)).toBeDefined();
      const size = pngSize(dataUrl as string);
      const extent = atlasExtent(atlasOf(catalog, name));
      expect(size.width, `${sheetFile(name)} width`).toBeGreaterThanOrEqual(extent.width);
      expect(size.height, `${sheetFile(name)} height`).toBeGreaterThanOrEqual(extent.height);
    }
  });

  it('has a picture for every kind of POI the default rules can generate', () => {
    // The §4.2 rows, stamina on any terrain (surplus leaves), and gold whose
    // guard §5.2 capped at 0, which the map carries as unguarded.
    const cases: [Terrain, RewardKind, GuardType | null][] = [];
    for (const terrain of TERRAINS) {
      for (const row of DEFAULT_RULESET.content.REWARD_TABLE[terrain]) {
        cases.push([terrain, row.kind, row.guard]);
        if (row.guard !== null) cases.push([terrain, row.kind, null]);
      }
      cases.push([terrain, 'stamina', null]);
    }
    for (const [terrain, kind, guard] of cases) {
      const row = poiArtRow(catalog.manifest, terrain, kind, guard);
      expect(catalog.atlases.has(row.sheet)).toBe(true);
    }
  });

  it('keeps the two Q20 substitutions in the table, each saying why', () => {
    const forestGold = poiArtRow(catalog.manifest, 'forest', 'gold', 'fighting');
    expect(forestGold.sheet).toBe('Mountains_GoldGuardedByFighting');
    expect(forestGold.borrowed).toMatch(/Q20/);
    for (const terrain of TERRAINS) {
      const stamina = poiArtRow(catalog.manifest, terrain, 'stamina', null);
      expect(stamina.sheet).toBe('Plains_PlainsMovement');
      expect(stamina.borrowed).toMatch(/Q20/);
    }
    const borrowed = catalog.manifest.pois.filter((row) => row.borrowed !== null);
    expect(borrowed).toHaveLength(2);
  });

  it('prefers a row naming the terrain over one for any terrain, and a matching guard over a fallback', () => {
    expect(poiArtRow(catalog.manifest, 'mountain', 'gold', 'magic').sheet).toBe('Mountains_GoldGuardedByMagic');
    expect(poiArtRow(catalog.manifest, 'mountain', 'gold', 'fighting').sheet).toBe('Mountains_GoldGuardedByFighting');
    // A capped plains gold POI keeps its castle; its node is drawn unguarded.
    expect(poiArtRow(catalog.manifest, 'plains', 'gold', null).sheet).toBe('Plains_GoldGuardedByFighting');
  });

  it('names what is missing when a POI has no row', () => {
    expect(() => poiArtRow(catalog.manifest, 'mountain', 'magic', null)).toThrow(ArtError);
    expect(() => poiArtRow(catalog.manifest, 'mountain', 'magic', null)).toThrow(/magic on mountain/);
  });

  it('picks a POI sprite by artVariant modulo the sheet', () => {
    const poi = (artVariant: number, guard: Poi['guard']): Poi => ({
      node: asNodeId(0),
      terrain: 'mountain',
      reward: { kind: 'gold', units: 3 },
      guard,
      remoteness: 0.5,
      group: { kind: 'gold', guard: 'magic' },
      artVariant,
    });
    const count = atlasOf(catalog, 'Mountains_GoldGuardedByMagic').sprites.length;
    expect(poiArt(catalog, poi(count + 2, { type: 'magic', strength: 4 })).sprite).toEqual({
      sheet: 'Mountains_GoldGuardedByMagic',
      index: 2,
    });
    expect(wrapIndex(4_294_967_295, 7)).toBe(4_294_967_295 % 7);
  });

  it('flags generated placeholders and only those', () => {
    const placeholders = [...catalog.atlases.values()].filter((atlas) => atlas.placeholder).map((atlas) => atlas.name);
    expect(placeholders.sort()).toEqual([
      'Dice_d6',
      'Forest_Texture',
      'Mountains_Texture',
      'Plains_Texture',
      'Prospect_Markers',
      'Roads_Brush',
    ]);
  });
});

describe('a bad art drop', () => {
  const without = (path: string): ArtFiles => ({
    json: new Map([...ART_FILES.json].filter(([key]) => key !== path)),
    urls: new Map([...ART_FILES.urls].filter(([key]) => key !== path)),
  });

  it('is reported with the file that is missing', () => {
    expect(() => buildArtCatalog(without('Forest_Trees_atlas.json'))).toThrow(/Forest_Trees_atlas\.json is missing/);
    expect(() => buildArtCatalog(without('Plains_Magic_sheet.png'))).toThrow(/Plains_Magic_sheet\.png is missing/);
    expect(() => buildArtCatalog(without('Icons/gold.png'))).toThrow(/Icons\/gold\.png is missing/);
  });

  it('rejects dressing it could not lay out: a backdrop that grows to fit, or an array of part-sprites', () => {
    const manifest = ART_FILES.json.get('manifest.json') as { terrain: Record<string, { dressing: object[] }> };
    const withDressing = (dressing: object) => ({
      ...manifest,
      terrain: { ...manifest.terrain, plains: { ...manifest.terrain['plains'], dressing: [dressing] } },
    });
    const fields = { sheet: 'Plains_Fields', size: 0.45, weight: 1 };
    expect(parseManifest(withDressing({ ...fields, array: 3 })).terrain.plains.dressing[0]).toMatchObject({ array: 3, layer: 'standing' });
    expect(() => parseManifest(withDressing({ ...fields, array: 2.5 }))).toThrow(/array: must be a whole number/);
    expect(() => parseManifest(withDressing({ ...fields, min_size: 0.6 }))).toThrow(/min_size: must not exceed size/);
    expect(() => parseManifest(withDressing({ ...fields, layer: 'sky' }))).toThrow(/layer: expected standing or backdrop/);
  });

  it('is reported with every problem at once', () => {
    const files: ArtFiles = {
      json: new Map([...ART_FILES.json].filter(([key]) => key !== 'Forest_Trees_atlas.json')),
      urls: new Map([...ART_FILES.urls].filter(([key]) => key !== 'Icons/gold.png')),
    };
    expect(() => buildArtCatalog(files)).toThrow(/Forest_Trees_atlas\.json is missing\n\s+Icons\/gold\.png is missing/);
  });
});
