import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULESET,
  REWARD_KINDS,
  TERRAINS,
  type GuardType,
  type RewardKind,
  type Terrain,
} from '@adventure/config';
import { asNodeId, type Poi } from '@adventure/core';
import { ArtError, atlasExtent } from './atlas.ts';
import { atlasOf, buildArtCatalog, poiArt, sheetFile, wrapIndex, type ArtFiles } from './catalog.ts';
import { ART_FILES } from './files.ts';
import { SOUND_NAMES, parseManifest, poiArtRow, sheetsNamed } from './manifest.ts';

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
    for (const name of SOUND_NAMES) expect(catalog.soundUrls(name).length, name).toBeGreaterThan(0);
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

  it('keeps the pictures of the rewards that moved terrain, each saying why (Q250, 922 A)', () => {
    const moved: [Terrain, RewardKind, GuardType | null, string][] = [
      ['plains', 'mountain_move', null, 'Forest_MountainMovement'],
      ['plains', 'gold', 'magic', 'Mountains_GoldGuardedByMagic'],
      ['forest', 'magic', null, 'Plains_Magic'],
    ];
    for (const [terrain, kind, guard, sheet] of moved) {
      const row = poiArtRow(catalog.manifest, terrain, kind, guard);
      expect(row.sheet).toBe(sheet);
      expect(row.borrowed).toMatch(/Q250/);
    }
    expect(catalog.manifest.pois.filter((row) => row.borrowed !== null)).toHaveLength(moved.length);
  });

  it('draws every stamina site, the spare dead ends in any terrain included, with the stamina sheet (Q240, 903 A)', () => {
    for (const terrain of TERRAINS) {
      const stamina = poiArtRow(catalog.manifest, terrain, 'stamina', null);
      expect(stamina.sheet).toBe('Plains_Stamina');
      expect(stamina.borrowed).toBeNull();
    }
    expect(atlasOf(catalog, 'Plains_Stamina').sprites).toHaveLength(12);
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

  it('circles the combat, forest speed and mountain speed icons and fills the wheel, on beige (Q61)', () => {
    const { backing } = catalog.manifest.icons;
    expect(Object.keys(backing.circled).sort()).toEqual(['fighting', 'forest_move', 'mountain_move']);
    expect(backing.filled).toEqual(['plains_move']);
    expect(backing.fill).toBe('#e6dcd2');
  });

  it('lets the swords reach over their contour (Q230)', () => {
    const { backing } = catalog.manifest.icons;
    expect(backing.pictures).toEqual({ fighting: 1.06 });
    expect(backing.picture).toBe(0.82);
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

  it('rejects dressing it could not lay out: a backdrop that grows to fit, or a cluster of one', () => {
    const manifest = ART_FILES.json.get('manifest.json') as { terrain: Record<string, { dressing: object[] }> };
    const withDressing = (dressing: object) => ({
      ...manifest,
      terrain: { ...manifest.terrain, plains: { ...manifest.terrain['plains'], dressing: [dressing] } },
    });
    const pieces = { sheet: 'Plains_Dressing', size: 0.2, weight: 1 };
    const clusters = (min: number, max: number) => ({ ...pieces, clusters: { sprites: ['Plains_Dressing_11'], min, max } });
    expect(parseManifest(withDressing(clusters(2, 4))).terrain.plains.dressing[0]).toMatchObject({
      clusters: { sprites: ['Plains_Dressing_11'], min: 2, max: 4 },
      layer: 'standing',
    });
    expect(parseManifest(withDressing(pieces)).terrain.plains.dressing[0]?.clusters).toBeNull();
    expect(() => parseManifest(withDressing(clusters(1, 4)))).toThrow(/clusters\.min: a cluster has at least 2 sprites/);
    expect(() => parseManifest(withDressing(clusters(3, 2)))).toThrow(/clusters\.max: must not be below min/);
    expect(() => parseManifest(withDressing(clusters(2, 3.5)))).toThrow(/min and max must be whole numbers/);
    expect(() => parseManifest(withDressing({ ...pieces, clusters: { sprites: [], min: 2, max: 4 } }))).toThrow(
      /clusters\.sprites: expected at least one sprite/,
    );
    expect(() => parseManifest(withDressing({ ...pieces, min_size: 0.6 }))).toThrow(/min_size: must not exceed size/);
    expect(() => parseManifest(withDressing({ ...pieces, layer: 'sky' }))).toThrow(/layer: expected standing or backdrop/);
  });

  it('clusters the bushes, and says when a clustered sprite is not on the sheet or is left out', () => {
    // Andrei, 2026-09-26: "It may make sense to put the bushes in small
    // clusters"; Q59: the five in the middle row of his sheet, 2 to 4 at a time.
    const catalog = buildArtCatalog(ART_FILES);
    const [pieces] = catalog.manifest.terrain.plains.dressing;
    expect(pieces?.clusters).toEqual({
      sprites: ['Plains_Dressing_11', 'Plains_Dressing_12', 'Plains_Dressing_13', 'Plains_Dressing_14', 'Plains_Dressing_15'],
      min: 2,
      max: 4,
    });
    const manifest = ART_FILES.json.get('manifest.json') as { terrain: Record<string, { dressing: object[] }> };
    const dressed = (dressing: object): ArtFiles => ({
      json: new Map([
        ...ART_FILES.json,
        ['manifest.json', { ...manifest, terrain: { ...manifest.terrain, plains: { ...manifest.terrain['plains'], dressing: [dressing] } } }],
      ]),
      urls: ART_FILES.urls,
    });
    const bushes = (sprites: string[], leave_out: string[] = []) =>
      dressed({ sheet: 'Plains_Dressing', size: 0.2, weight: 1, leave_out, clusters: { sprites, min: 2, max: 4 } });
    expect(() => buildArtCatalog(bushes(['Plains_Dressing_99']))).toThrow(
      /terrain\.plains clusters Plains_Dressing_99, which Plains_Dressing_atlas\.json does not have/,
    );
    expect(() => buildArtCatalog(bushes(['Plains_Dressing_11'], ['Plains_Dressing_11']))).toThrow(
      /terrain\.plains both clusters and leaves out Plains_Dressing_11/,
    );
  });

  it('leaves dressing sprites out by id, and says when an id is not on the sheet', () => {
    const catalog = buildArtCatalog(ART_FILES);
    const manifest = ART_FILES.json.get('manifest.json') as { terrain: Record<string, { dressing: object[] }> };
    const leaving = (leave_out: string[]): ArtFiles => ({
      json: new Map([
        ...ART_FILES.json,
        [
          'manifest.json',
          {
            ...manifest,
            terrain: {
              ...manifest.terrain,
              plains: { ...manifest.terrain['plains'], dressing: [{ sheet: 'Plains_Dressing', size: 0.2, weight: 1, leave_out }] },
            },
          },
        ],
      ]),
      urls: ART_FILES.urls,
    });
    expect(buildArtCatalog(leaving(['Plains_Dressing_02'])).manifest.terrain.plains.dressing[0]?.leaveOut).toEqual([
      'Plains_Dressing_02',
    ]);
    expect(() => buildArtCatalog(leaving(['Plains_Dressing_2']))).toThrow(
      /terrain\.plains leaves out Plains_Dressing_2, which Plains_Dressing_atlas\.json does not have/,
    );
    const all = atlasOf(catalog, 'Plains_Dressing').sprites.map((sprite) => sprite.id);
    expect(() => buildArtCatalog(leaving(all))).toThrow(/leaves out every sprite of Plains_Dressing/);
  });

  it('rejects an adjustment for a sheet nothing draws, and a malformed one', () => {
    const manifest = ART_FILES.json.get('manifest.json') as { adjustments: { sheets: object } };
    const withAdjustments = (sheets: object) => ({ ...manifest, adjustments: { ...manifest.adjustments, sheets } });
    const files = (sheets: object): ArtFiles => ({
      json: new Map([...ART_FILES.json, ['manifest.json', withAdjustments(sheets)]]),
      urls: ART_FILES.urls,
    });
    expect(() => buildArtCatalog(files({ Plains_Magik: { brightness: 1.5 } }))).toThrow(
      /adjustments\.sheets\.Plains_Magik names a sheet the manifest does not draw/,
    );
    expect(() => parseManifest(withAdjustments({ Plains_Magic: { brightness: 0 } }))).toThrow(/brightness/);
    expect(() => parseManifest(withAdjustments({ Forest_Fighting: { outline: { color: 'black', width: 0.01 } } }))).toThrow(
      /outline\.color: expected a colour/,
    );
    const parsed = parseManifest(withAdjustments({ Forest_Fighting: { outline: { color: '#1C1812', width: 0.01 } } }));
    expect(parsed.adjustments.get('Forest_Fighting')).toEqual({
      brightness: 1,
      saturation: 1,
      outline: { color: '#1c1812', width: 0.01 },
    });
  });

  it('rejects an icon backing naming something that is not a reward, or an icon both circled and filled', () => {
    const manifest = ART_FILES.json.get('manifest.json') as { icons: { backing: object } };
    const withBacking = (backing: object) => ({ ...manifest, icons: { ...manifest.icons, backing: { ...manifest.icons.backing, ...backing } } });
    expect(() => parseManifest(withBacking({ circled: { swords: '#b71b1c' } }))).toThrow(/icons\.backing\.circled: swords is not a reward kind/);
    expect(() => parseManifest(withBacking({ filled: ['fighting'] }))).toThrow(/fighting is both circled and filled/);
    expect(() => parseManifest(withBacking({ fill: 'beige' }))).toThrow(/icons\.backing\.fill: expected a colour/);
    expect(() => parseManifest(withBacking({ contour: 0.5 }))).toThrow(/contour: must be under half/);
    expect(() => parseManifest(withBacking({ pictures: { plains_move: 1.2 } }))).toThrow(/icons\.backing\.pictures: plains_move is not circled/);
    expect(() => parseManifest(withBacking({ pictures: { fighting: 0 } }))).toThrow(/icons\.backing\.pictures\.fighting/);
  });

  it('is reported with every problem at once', () => {
    const files: ArtFiles = {
      json: new Map([...ART_FILES.json].filter(([key]) => key !== 'Forest_Trees_atlas.json')),
      urls: new Map([...ART_FILES.urls].filter(([key]) => key !== 'Icons/gold.png')),
    };
    expect(() => buildArtCatalog(files)).toThrow(/Forest_Trees_atlas\.json is missing\n\s+Icons\/gold\.png is missing/);
  });

  it('names a sound file that is missing, and a sound with no files (Q63)', () => {
    const files: ArtFiles = {
      json: ART_FILES.json,
      urls: new Map([...ART_FILES.urls].filter(([key]) => key !== 'Sounds/step_2.wav')),
    };
    expect(() => buildArtCatalog(files)).toThrow(/Sounds\/step_2\.wav is missing/);
    const manifest = ART_FILES.json.get('manifest.json') as Record<string, Record<string, unknown>>;
    const silent = { ...manifest, sounds: { ...manifest['sounds'], pickup: { files: [], volume: 1 } } };
    expect(() => parseManifest(silent)).toThrow(/sounds\.pickup\.files: expected at least one file/);
  });

  it("finds Andrei's rock and sky (Q170), and names either when it is missing", () => {
    const catalog = buildArtCatalog(ART_FILES);
    expect(catalog.islandUrls.underside).toBeTruthy();
    expect(catalog.islandUrls.sky).toBeTruthy();
    expect(catalog.manifest.island.sky.shade).toEqual({ light: 0, dark: 0.3 });
    expect(catalog.manifest.island.underside.fade).toBe(24);
    expect(catalog.manifest.island.sky.color).toBe('#809ab4');
    expect(catalog.manifest.island.underside.greens).toEqual({ hue: 42, saturation: 0.75, darken: 0.25 });
    expect(catalog.manifest.island.underside.blur).toBe(6);
    expect(() => buildArtCatalog(without('Island/underside.png'))).toThrow(/Island\/underside\.png is missing/);
    expect(() => buildArtCatalog(without('Island/sky.png'))).toThrow(/Island\/sky\.png is missing/);
  });

  it('rejects underside corners that would turn the rock over, a fade of nothing, a sky colour that is not one, a shade outside 0 to 1, greens turned past half a circle or darkened past black, and a blur below nothing', () => {
    const manifest = ART_FILES.json.get('manifest.json') as Record<string, Record<string, Record<string, unknown>>>;
    const island = manifest['island'] as Record<string, Record<string, unknown>>;
    const withCorners = (corners: object) => ({
      ...manifest,
      island: { ...island, underside: { ...island['underside'], corners } },
    });
    expect(() => parseManifest(withCorners({ left: [18, 85], bottom: [772, 40], right: [1516, 89] }))).toThrow(
      /bottom must lie between left and right, and below both/,
    );
    expect(() => parseManifest(withCorners({ left: [18, 85], bottom: [772], right: [1516, 89] }))).toThrow(/expected \[x, y\]/);
    const withFade = { ...manifest, island: { ...island, underside: { ...island['underside'], fade: 0 } } };
    expect(() => parseManifest(withFade)).toThrow(/island\.underside\.fade/);
    const withShade = { ...manifest, island: { ...island, sky: { ...island['sky'], shade: { light: 0, dark: 1.5 } } } };
    expect(() => parseManifest(withShade)).toThrow(/island\.sky\.shade\.dark: must be between 0 and 1/);
    const withColor = { ...manifest, island: { ...island, sky: { ...island['sky'], color: 'blue' } } };
    expect(() => parseManifest(withColor)).toThrow(/island\.sky\.color: expected a colour/);
    const withGreens = (greens: unknown) => ({ ...manifest, island: { ...island, underside: { ...island['underside'], greens } } });
    expect(() => parseManifest(withGreens({ hue: 400, saturation: 1, darken: 0 }))).toThrow(/island\.underside\.greens\.hue: must be between -180 and 180/);
    expect(() => parseManifest(withGreens({ hue: 42, saturation: 1, darken: 1.5 }))).toThrow(/island\.underside\.greens\.darken: must be between 0 and 1/);
    // Left out, the rock's greens stay as drawn.
    expect(parseManifest(withGreens(undefined)).island.underside.greens).toEqual({ hue: 0, saturation: 1, darken: 0 });
    const withBlur = (blur: unknown) => ({ ...manifest, island: { ...island, underside: { ...island['underside'], blur } } });
    expect(() => parseManifest(withBlur(-2))).toThrow(/island\.underside\.blur/);
    // Left out, the stone tops stay sharp.
    expect(parseManifest(withBlur(undefined)).island.underside.blur).toBe(0);
  });
});
