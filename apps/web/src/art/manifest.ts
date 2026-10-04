import {
  GUARD_TYPES,
  REWARD_KINDS,
  TERRAINS,
  type GuardType,
  type PerTerrain,
  type RewardKind,
  type Terrain,
} from '@adventure/config';
import type { PathStepColor, Point } from '@adventure/core';
import { ArtError, array, finite, nonNegative, positive, record, string } from './atlas.ts';

/**
 * `Art/manifest.json`: the one table that says which picture the game draws
 * for what. Nothing else in the client names a file in `Art/`.
 *
 * Sizes are in **node spacings** — the length of a typical road on the map —
 * and every sheet is scaled on load so that its typical sprite comes out at
 * that size. So a replacement sheet drawn at any resolution, with any amount
 * of padding in its cells, drops in without a second number changing.
 *
 * Two POI rows borrow another row's sheet: forest gold guarded by fighting
 * (Q20) and by magic (Q115); stamina borrowed one too until it had its own
 * (Q240). They carry a
 * `borrowed` note saying why, which is what makes them easy to find and a
 * one-line edit to undo.
 */
export interface ArtManifest {
  readonly terrain: PerTerrain<TerrainArt>;
  readonly pois: readonly PoiArtRow[];
  readonly icons: {
    readonly size: number;
    readonly files: Readonly<Record<RewardKind, string>>;
    readonly backing: IconBacking;
  };
  readonly guards: {
    readonly colors: Readonly<Record<GuardType, string>>;
    /** The width of the ring in the guard's colour round a guarded POI's node (§3, Q31). */
    readonly ringWidth: number;
    readonly numberSize: number;
  };
  readonly roads: { readonly sheet: string; readonly sprite: string; readonly width: number };
  readonly nodes: {
    readonly radius: number;
    readonly outline: string;
    /** [Q80] The dot in the middle of a site's node until it is claimed: `size` across as a share of the node's width. */
    readonly siteDot: { readonly size: number; readonly color: string };
  };
  readonly moveProspect: MoveProspectArt;
  readonly figurines: { readonly sheet: string; readonly size: number };
  readonly portraits: string;
  readonly dice: { readonly sheet: string };
  /** [Q170] The rock under the map's front edges and the sky behind it. */
  readonly island: IslandArt;
  /** The sound effects (Q63): each sound's files, played in turn, and its volume. */
  readonly sounds: Readonly<Record<SoundName, SoundArt>>;
  readonly shadows: { readonly opacity: number; readonly sheets: ReadonlyMap<string, readonly string[]> };
  /** Edits made to a sheet as it loads, by sheet name; a sheet with no line is drawn as supplied. */
  readonly adjustments: ReadonlyMap<string, SheetAdjustment>;
}

/**
 * What the map draws behind some reward icons as they load (Q61), so the PNGs
 * stay as drawn and the players' cards, which use the files, show them as
 * they are.
 */
export interface IconBacking {
  /** The disc's colour, for circled and filled icons alike. */
  readonly fill: string;
  /** A circled icon's contour width, as a share of its disc's width. */
  readonly contour: number;
  /** How much of a circled icon's disc the smallest circle round its picture spans. */
  readonly picture: number;
  /** Icons drawn on a disc, each with its contour colour. */
  readonly circled: Readonly<Partial<Record<RewardKind, string>>>;
  /** Circled icons whose picture spans its own share of the disc instead of `picture`; above 1 it reaches over the contour (Q230). */
  readonly pictures: Readonly<Partial<Record<RewardKind, number>>>;
  /** Icons with a disc under the picture, inside its own rim. */
  readonly filled: readonly RewardKind[];
}

/**
 * How a sheet is changed on load, so its PNG stays exactly as the artist
 * supplied it and a replacement that already looks right just loses its line.
 */
export interface SheetAdjustment {
  /** Each colour channel `c` in 0..1 becomes `c ** (1 / brightness)`: darks lift most, white stays white. `1` leaves it. */
  readonly brightness: number;
  /** How far each colour sits from its own grey, scaled: `1` leaves it, `2` doubles it. */
  readonly saturation: number;
  /** A contour round every sprite's picture, drawn behind it and over its shadow. */
  readonly outline: SheetOutline | null;
}

export interface SheetOutline {
  readonly color: string;
  /** How thick, as a share of the sheet's typical sprite span, so it scales with the picture. */
  readonly width: number;
}

/**
 * [Andrei, 2026-10-01] "I don't like the map floating in the void. Can we add
 * this extension to the bottom to create a Laputa-style floating island?"
 * (Q170): his rock under the map's two front edges, and his sky behind it.
 */
export interface IslandArt {
  readonly underside: {
    /** A picture under `Art/`. */
    readonly file: string;
    /**
     * Where, in the picture's pixels, the map's left, bottom and right corners
     * go. The picture is stretched between these three points, so its own top
     * edges lie along the map's two front edges.
     */
    readonly corners: IslandCorners;
    /**
     * [679] How far above the line through `corners`, in the picture's pixels,
     * the rock fades out: it is drawn over the ground, and its stone tops
     * fade into it rather than ending in a straight cut.
     */
    readonly fade: number;
    /**
     * [832, 833] How far, in the picture's pixels, the stone tops over the
     * ground are blurred at the top of the fade, shading back to sharp on the
     * ground's edge (`blurStoneTops` in `render/island.ts`). 0, or left out of
     * the manifest, leaves them sharp.
     */
    readonly blur: number;
    /**
     * [830, 831] How the rock's moss and ivy turn towards the map's forest
     * green (`turnGreens` in `render/island.ts`). Left out of the manifest,
     * they stay as drawn.
     */
    readonly greens: IslandGreens;
  };
  readonly sky: {
    /** A picture under `Art/`. */
    readonly file: string;
    /** [680] Its average colour, shown in its place while the picture loads. */
    readonly color: string;
    /** How much it is darkened, from 0 (as drawn) to 1 (black), on a light and a dark screen. */
    readonly shade: { readonly light: number; readonly dark: number };
  };
}

export interface IslandGreens {
  /** Degrees each green's hue turns. */
  readonly hue: number;
  /** What each green's saturation is multiplied by. */
  readonly saturation: number;
  /** How much each green is darkened, from 0 (as bright) to 1 (black). */
  readonly darken: number;
}

export interface IslandCorners {
  readonly left: Point;
  readonly bottom: Point;
  readonly right: Point;
}

/**
 * [Andrei, 2026-09-27] "sound effects, for moving, picking up a reward,
 * winning a battle and losing a battle" (Q63): a footstep each time a walking
 * figure reaches a node, a reward taken from an unguarded POI, and a guard
 * beaten or not once the die has stopped. [2026-09-28] "the resting sound and
 * the "new message" as well, for a complete minimal set": a rest as it is
 * shown, and, online, a message someone else posts.
 *
 * [Q190, 777] Andrei, 2026-10-02: "It also would be nice if a purchase got
 * completed with some sound, e.g. a cash register sound", and he supplied it.
 */
export const SOUND_NAMES = ['step', 'pickup', 'battle_won', 'battle_lost', 'rest', 'message', 'respawn', 'purchase'] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

export interface SoundArt {
  /** Paths under `Art/`. Several are takes of one sound, used in turn (Q63, 133). */
  readonly files: readonly string[];
  /** How loud, as a share of the file's own level: `1` plays it as it is. */
  readonly volume: number;
}

export interface TerrainArt {
  readonly texture: string;
  /** How many node spacings one repeat of the texture covers. */
  readonly textureSize: number;
  readonly nodeColor: string;
  readonly dressing: readonly DressingArt[];
  /** Standing dressing sprites per node of this terrain; backdrop dressing fills the terrain instead. */
  readonly dressingDensity: number;
}

export interface DressingArt {
  readonly sheet: string;
  readonly size: number;
  readonly weight: number;
  /**
   * `standing` dressing is depth-sorted with the POIs and figures and kept off
   * the nodes and roads; `backdrop` dressing is painted onto the ground under
   * the roads, nodes and everything else, and fills its whole terrain.
   */
  readonly layer: DressingLayer;
  /** Backdrop only: the smallest a sprite may shrink to, to fit its terrain. */
  readonly minSize: number;
  /** Standing only: the sprites that stand in small clusters instead of alone, or `null` for none. */
  readonly clusters: DressingClusters | null;
  /** Sprites of the sheet never drawn, by id: the sheet stays as supplied. */
  readonly leaveOut: readonly string[];
}

/**
 * [Andrei, 2026-09-26] "It may make sense to put the bushes in small
 * clusters", and Q59: a cluster is `min` to `max` of these sprites, touching,
 * mixed at random, scattered rather than in a row.
 */
export interface DressingClusters {
  /** By id. A sprite picked from this list comes with a cluster round it. */
  readonly sprites: readonly string[];
  readonly min: number;
  readonly max: number;
}

export type DressingLayer = 'standing' | 'backdrop';

export interface PoiArtRow {
  readonly terrain: Terrain | 'any';
  readonly reward: RewardKind;
  readonly guard: GuardType | null;
  readonly sheet: string;
  readonly size: number;
  /** Why this row draws from another row's sheet, or `null` when it does not. */
  readonly borrowed: string | null;
  /** The picture stands on the POI's node, its base across it, rather than beside it: the guardians. */
  readonly onNode: boolean;
}

export interface MoveProspectArt {
  readonly sheet: string;
  readonly dot: Readonly<Record<PathStepColor, string>>;
  readonly cross: Readonly<Record<PathStepColor, string>>;
  readonly waypoint: string;
  readonly active: string;
  readonly dotSize: number;
  readonly dotSpacing: number;
  readonly crossSize: number;
  readonly waypointSize: number;
  readonly activeSize: number;
}

const PATH_STEP_COLORS: readonly PathStepColor[] = ['free', 'stamina', 'unreachable'];

export function parseManifest(json: unknown): ArtManifest {
  const root = record(json, 'manifest.json');
  const terrainRoot = record(root['terrain'], 'manifest.json: terrain');
  const terrain = Object.fromEntries(
    TERRAINS.map((name) => [name, parseTerrain(terrainRoot[name], `manifest.json: terrain.${name}`)]),
  ) as Record<Terrain, TerrainArt>;

  const pois = array(root['pois'], 'manifest.json: pois').map((row, index) =>
    parsePoiRow(row, `manifest.json: pois[${index}]`),
  );

  const icons = record(root['icons'], 'manifest.json: icons');
  const iconFiles = record(icons['files'], 'manifest.json: icons.files');
  const guards = record(root['guards'], 'manifest.json: guards');
  const roads = record(root['roads'], 'manifest.json: roads');
  const nodes = record(root['nodes'], 'manifest.json: nodes');
  const siteDot = record(nodes['site_dot'], 'manifest.json: nodes.site_dot');
  const prospect = record(root['move_prospect'], 'manifest.json: move_prospect');
  const figurines = record(root['figurines'], 'manifest.json: figurines');
  const dice = record(root['dice'], 'manifest.json: dice');
  const island = record(root['island'], 'manifest.json: island');
  const sounds = record(root['sounds'], 'manifest.json: sounds');
  const shadows = record(root['shadows'], 'manifest.json: shadows');
  const shadowSheets = record(shadows['sheets'], 'manifest.json: shadows.sheets');
  const adjustments = root['adjustments'] === undefined ? {} : record(root['adjustments'], 'manifest.json: adjustments');
  const adjustedSheets =
    adjustments['sheets'] === undefined ? {} : record(adjustments['sheets'], 'manifest.json: adjustments.sheets');

  return {
    terrain,
    pois,
    icons: {
      size: positive(icons['size'], 'manifest.json: icons.size'),
      files: Object.fromEntries(
        REWARD_KINDS.map((kind) => [kind, string(iconFiles[kind], `manifest.json: icons.files.${kind}`)]),
      ) as Record<RewardKind, string>,
      backing: parseBacking(icons['backing'], 'manifest.json: icons.backing'),
    },
    guards: {
      colors: Object.fromEntries(
        GUARD_TYPES.map((type) => [
          type,
          color(record(guards[type], `manifest.json: guards.${type}`)['color'], `manifest.json: guards.${type}.color`),
        ]),
      ) as Record<GuardType, string>,
      ringWidth: positive(guards['ring_width'], 'manifest.json: guards.ring_width'),
      numberSize: positive(guards['number_size'], 'manifest.json: guards.number_size'),
    },
    roads: {
      sheet: string(roads['sheet'], 'manifest.json: roads.sheet'),
      sprite: string(roads['sprite'], 'manifest.json: roads.sprite'),
      width: positive(roads['width'], 'manifest.json: roads.width'),
    },
    nodes: {
      radius: positive(nodes['radius'], 'manifest.json: nodes.radius'),
      outline: color(nodes['outline'], 'manifest.json: nodes.outline'),
      siteDot: {
        size: positive(siteDot['size'], 'manifest.json: nodes.site_dot.size'),
        color: color(siteDot['color'], 'manifest.json: nodes.site_dot.color'),
      },
    },
    moveProspect: {
      sheet: string(prospect['sheet'], 'manifest.json: move_prospect.sheet'),
      dot: byStepColor(prospect['dot'], 'manifest.json: move_prospect.dot'),
      cross: byStepColor(prospect['cross'], 'manifest.json: move_prospect.cross'),
      waypoint: string(prospect['waypoint'], 'manifest.json: move_prospect.waypoint'),
      active: string(prospect['active'], 'manifest.json: move_prospect.active'),
      dotSize: positive(prospect['dot_size'], 'manifest.json: move_prospect.dot_size'),
      dotSpacing: positive(prospect['dot_spacing'], 'manifest.json: move_prospect.dot_spacing'),
      crossSize: positive(prospect['cross_size'], 'manifest.json: move_prospect.cross_size'),
      waypointSize: positive(prospect['waypoint_size'], 'manifest.json: move_prospect.waypoint_size'),
      activeSize: positive(prospect['active_size'], 'manifest.json: move_prospect.active_size'),
    },
    figurines: {
      sheet: string(figurines['sheet'], 'manifest.json: figurines.sheet'),
      size: positive(figurines['size'], 'manifest.json: figurines.size'),
    },
    portraits: string(root['portraits'], 'manifest.json: portraits'),
    dice: { sheet: string(dice['sheet'], 'manifest.json: dice.sheet') },
    island: parseIsland(island, 'manifest.json: island'),
    sounds: Object.fromEntries(
      SOUND_NAMES.map((name) => [name, parseSound(sounds[name], `manifest.json: sounds.${name}`)]),
    ) as Record<SoundName, SoundArt>,
    shadows: {
      opacity: fraction(shadows['opacity'], 'manifest.json: shadows.opacity'),
      sheets: new Map(
        Object.entries(shadowSheets).map(([sheet, colors]) => [
          sheet,
          array(colors, `manifest.json: shadows.sheets.${sheet}`).map((value) =>
            color(value, `manifest.json: shadows.sheets.${sheet}`),
          ),
        ]),
      ),
    },
    adjustments: new Map(
      Object.entries(adjustedSheets).map(([sheet, entry]) => [
        sheet,
        parseAdjustment(entry, `manifest.json: adjustments.sheets.${sheet}`),
      ]),
    ),
  };
}

/**
 * Which row of the table draws a POI.
 *
 * A row matches on reward kind, on terrain (`any` matches every terrain, and a
 * row naming the terrain wins over it), and on guard type. A POI whose guard
 * the generator capped at strength 0 has no guard at all (§5.2), so it falls
 * back to its kind's row on that terrain whatever that row's guard is; the
 * renderer then draws its node plain and gives it no number, as the unguarded
 * POI it is.
 */
export function poiArtRow(
  manifest: ArtManifest,
  terrain: Terrain,
  reward: RewardKind,
  guard: GuardType | null,
): PoiArtRow {
  const candidates = manifest.pois.filter(
    (row) => row.reward === reward && (row.terrain === terrain || row.terrain === 'any'),
  );
  const score = (row: PoiArtRow): number => (row.guard === guard ? 2 : 0) + (row.terrain === terrain ? 1 : 0);
  let best: PoiArtRow | undefined;
  for (const row of candidates) if (best === undefined || score(row) > score(best)) best = row;
  if (best === undefined) {
    throw new ArtError(
      `manifest.json has no POI row for ${reward}${guard === null ? '' : ` guarded by ${guard}`} on ${terrain}`,
    );
  }
  return best;
}

/** Every sheet the manifest names, so a loader or a test can check each exists. */
export function sheetsNamed(manifest: ArtManifest): string[] {
  const names = new Set<string>();
  for (const terrain of TERRAINS) {
    const art = manifest.terrain[terrain];
    names.add(art.texture);
    for (const dressing of art.dressing) names.add(dressing.sheet);
  }
  for (const row of manifest.pois) names.add(row.sheet);
  names.add(manifest.roads.sheet);
  names.add(manifest.moveProspect.sheet);
  names.add(manifest.figurines.sheet);
  names.add(manifest.dice.sheet);
  return [...names].sort();
}

function parseIsland(island: Readonly<Record<string, unknown>>, where: string): IslandArt {
  const underside = record(island['underside'], `${where}.underside`);
  const corners = record(underside['corners'], `${where}.underside.corners`);
  const point = (json: unknown, at: string): Point => {
    const pair = array(json, at);
    if (pair.length !== 2) throw new ArtError(`${at}: expected [x, y]`);
    return { x: nonNegative(pair[0], `${at}[0]`), y: nonNegative(pair[1], `${at}[1]`) };
  };
  const left = point(corners['left'], `${where}.underside.corners.left`);
  const bottom = point(corners['bottom'], `${where}.underside.corners.bottom`);
  const right = point(corners['right'], `${where}.underside.corners.right`);
  // The map's bottom corner is below the other two and between them; any
  // other order would turn the picture over or inside out.
  if (!(left.x < bottom.x && bottom.x < right.x && bottom.y > left.y && bottom.y > right.y)) {
    throw new ArtError(`${where}.underside.corners: bottom must lie between left and right, and below both`);
  }
  const sky = record(island['sky'], `${where}.sky`);
  const shade = record(sky['shade'], `${where}.sky.shade`);
  return {
    underside: {
      file: string(underside['file'], `${where}.underside.file`),
      corners: { left, bottom, right },
      fade: positive(underside['fade'], `${where}.underside.fade`),
      blur: underside['blur'] === undefined ? 0 : nonNegative(underside['blur'], `${where}.underside.blur`),
      greens: underside['greens'] === undefined ? AS_DRAWN : parseGreens(underside['greens'], `${where}.underside.greens`),
    },
    sky: {
      file: string(sky['file'], `${where}.sky.file`),
      color: color(sky['color'], `${where}.sky.color`),
      shade: { light: fraction(shade['light'], `${where}.sky.shade.light`), dark: fraction(shade['dark'], `${where}.sky.shade.dark`) },
    },
  };
}

const AS_DRAWN: IslandGreens = { hue: 0, saturation: 1, darken: 0 };

function parseGreens(json: unknown, where: string): IslandGreens {
  const greens = record(json, where);
  const hue = finite(greens['hue'], `${where}.hue`);
  if (hue < -180 || hue > 180) throw new ArtError(`${where}.hue: must be between -180 and 180 degrees`);
  return {
    hue,
    saturation: positive(greens['saturation'], `${where}.saturation`),
    darken: fraction(greens['darken'], `${where}.darken`),
  };
}

function parseSound(json: unknown, where: string): SoundArt {
  const sound = record(json, where);
  const files = array(sound['files'], `${where}.files`).map((file, index) => string(file, `${where}.files[${index}]`));
  if (files.length === 0) throw new ArtError(`${where}.files: expected at least one file`);
  return { files, volume: positive(sound['volume'], `${where}.volume`) };
}

function parseTerrain(json: unknown, where: string): TerrainArt {
  const entry = record(json, where);
  return {
    texture: string(entry['texture'], `${where}.texture`),
    textureSize: positive(entry['texture_size'], `${where}.texture_size`),
    nodeColor: color(entry['node_color'], `${where}.node_color`),
    dressing: array(entry['dressing'], `${where}.dressing`).map((item, index) => {
      const dressing = record(item, `${where}.dressing[${index}]`);
      const layer = dressing['layer'] ?? 'standing';
      if (layer !== 'standing' && layer !== 'backdrop') {
        throw new ArtError(`${where}.dressing[${index}].layer: expected standing or backdrop`);
      }
      const size = positive(dressing['size'], `${where}.dressing[${index}].size`);
      const minSize = dressing['min_size'] === undefined ? size : positive(dressing['min_size'], `${where}.dressing[${index}].min_size`);
      if (minSize > size) throw new ArtError(`${where}.dressing[${index}].min_size: must not exceed size`);
      return {
        sheet: string(dressing['sheet'], `${where}.dressing[${index}].sheet`),
        size,
        weight: positive(dressing['weight'], `${where}.dressing[${index}].weight`),
        layer,
        minSize,
        clusters:
          dressing['clusters'] === undefined ? null : parseClusters(dressing['clusters'], `${where}.dressing[${index}].clusters`),
        leaveOut:
          dressing['leave_out'] === undefined
            ? []
            : array(dressing['leave_out'], `${where}.dressing[${index}].leave_out`).map((id, at) =>
                string(id, `${where}.dressing[${index}].leave_out[${at}]`),
              ),
      };
    }),
    dressingDensity: nonNegative(entry['dressing_density'], `${where}.dressing_density`),
  };
}

function parseBacking(json: unknown, where: string): IconBacking {
  if (json === undefined) return { fill: '#ffffff', contour: 0, picture: 1, circled: {}, pictures: {}, filled: [] };
  const entry = record(json, where);
  const kind = (value: string, at: string): RewardKind => {
    if (!(REWARD_KINDS as readonly string[]).includes(value)) throw new ArtError(`${at}: ${value} is not a reward kind`);
    return value as RewardKind;
  };
  const circledEntry = entry['circled'] === undefined ? {} : record(entry['circled'], `${where}.circled`);
  const circled = Object.fromEntries(
    Object.entries(circledEntry).map(([name, value]) => [kind(name, `${where}.circled`), color(value, `${where}.circled.${name}`)]),
  ) as Partial<Record<RewardKind, string>>;
  const filled = (entry['filled'] === undefined ? [] : array(entry['filled'], `${where}.filled`)).map((value, at) =>
    kind(string(value, `${where}.filled[${at}]`), `${where}.filled[${at}]`),
  );
  for (const name of filled) {
    if (circled[name] !== undefined) throw new ArtError(`${where}: ${name} is both circled and filled`);
  }
  const contour = fraction(entry['contour'], `${where}.contour`);
  if (contour >= 0.5) throw new ArtError(`${where}.contour: must be under half the disc's width`);
  const picture = fraction(entry['picture'], `${where}.picture`);
  if (picture === 0) throw new ArtError(`${where}.picture: must be above 0`);
  const picturesEntry = entry['pictures'] === undefined ? {} : record(entry['pictures'], `${where}.pictures`);
  const pictures = Object.fromEntries(
    Object.entries(picturesEntry).map(([name, value]) => {
      const icon = kind(name, `${where}.pictures`);
      if (circled[icon] === undefined) throw new ArtError(`${where}.pictures: ${name} is not circled`);
      return [icon, positive(value, `${where}.pictures.${name}`)];
    }),
  ) as Partial<Record<RewardKind, number>>;
  return { fill: color(entry['fill'], `${where}.fill`), contour, picture, circled, pictures, filled };
}

function parseClusters(json: unknown, where: string): DressingClusters {
  const entry = record(json, where);
  const sprites = array(entry['sprites'], `${where}.sprites`).map((id, at) => string(id, `${where}.sprites[${at}]`));
  if (sprites.length === 0) throw new ArtError(`${where}.sprites: expected at least one sprite`);
  const min = positive(entry['min'], `${where}.min`);
  const max = positive(entry['max'], `${where}.max`);
  if (!Number.isInteger(min) || !Number.isInteger(max)) throw new ArtError(`${where}: min and max must be whole numbers`);
  if (min < 2) throw new ArtError(`${where}.min: a cluster has at least 2 sprites`);
  if (max < min) throw new ArtError(`${where}.max: must not be below min`);
  return { sprites, min, max };
}

function parsePoiRow(json: unknown, where: string): PoiArtRow {
  const row = record(json, where);
  const terrain = row['terrain'];
  if (terrain !== 'any' && !TERRAINS.some((name) => name === terrain)) {
    throw new ArtError(`${where}.terrain: expected one of ${TERRAINS.join(', ')} or any`);
  }
  const reward = row['reward'];
  if (!REWARD_KINDS.some((kind) => kind === reward)) {
    throw new ArtError(`${where}.reward: expected one of ${REWARD_KINDS.join(', ')}`);
  }
  const guard = row['guard'];
  if (guard !== null && !GUARD_TYPES.some((type) => type === guard)) {
    throw new ArtError(`${where}.guard: expected null or one of ${GUARD_TYPES.join(', ')}`);
  }
  const borrowed = row['borrowed'];
  return {
    terrain: terrain as Terrain | 'any',
    reward: reward as RewardKind,
    guard: guard as GuardType | null,
    sheet: string(row['sheet'], `${where}.sheet`),
    size: positive(row['size'], `${where}.size`),
    borrowed: typeof borrowed === 'string' ? borrowed : null,
    onNode: flag(row['on_node'], `${where}.on_node`),
  };
}

/** An optional true or false, false when left out. */
function flag(json: unknown, where: string): boolean {
  if (json === undefined) return false;
  if (typeof json !== 'boolean') throw new ArtError(`${where}: expected true or false`);
  return json;
}

function parseAdjustment(json: unknown, where: string): SheetAdjustment {
  const entry = record(json, where);
  const outline = entry['outline'] === undefined ? null : record(entry['outline'], `${where}.outline`);
  return {
    brightness: entry['brightness'] === undefined ? 1 : positive(entry['brightness'], `${where}.brightness`),
    saturation: entry['saturation'] === undefined ? 1 : nonNegative(entry['saturation'], `${where}.saturation`),
    outline:
      outline === null
        ? null
        : {
            color: color(outline['color'], `${where}.outline.color`),
            width: positive(outline['width'], `${where}.outline.width`),
          },
  };
}

function byStepColor(json: unknown, where: string): Record<PathStepColor, string> {
  const entry = record(json, where);
  return Object.fromEntries(PATH_STEP_COLORS.map((key) => [key, string(entry[key], `${where}.${key}`)])) as Record<
    PathStepColor,
    string
  >;
}

function color(value: unknown, where: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new ArtError(`${where}: expected a colour like #c8a266`);
  }
  return value.toLowerCase();
}

function fraction(value: unknown, where: string): number {
  const number = finite(value, where);
  if (number < 0 || number > 1) throw new ArtError(`${where}: must be between 0 and 1`);
  return number;
}
