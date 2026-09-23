import {
  GUARD_TYPES,
  REWARD_KINDS,
  TERRAINS,
  type GuardType,
  type PerTerrain,
  type RewardKind,
  type Terrain,
} from '@adventure/config';
import type { PathStepColor } from '@adventure/core';
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
 * Two POI rows borrow another row's sheet (Q20): forest gold and stamina. They
 * carry a `borrowed` note saying why, which is what makes them easy to find and
 * a one-line edit to undo.
 */
export interface ArtManifest {
  readonly terrain: PerTerrain<TerrainArt>;
  readonly pois: readonly PoiArtRow[];
  readonly icons: { readonly size: number; readonly files: Readonly<Record<RewardKind, string>> };
  readonly guards: {
    readonly colors: Readonly<Record<GuardType, string>>;
    /** The width of the ring in the guard's colour round a guarded POI's node (§3, Q31). */
    readonly ringWidth: number;
    readonly numberSize: number;
  };
  readonly roads: { readonly sheet: string; readonly sprite: string; readonly width: number };
  readonly nodes: { readonly radius: number; readonly outline: string };
  readonly moveProspect: MoveProspectArt;
  readonly figurines: { readonly sheet: string; readonly size: number };
  readonly portraits: string;
  readonly dice: { readonly sheet: string };
  readonly shadows: { readonly opacity: number; readonly sheets: ReadonlyMap<string, readonly string[]> };
  /** Edits made to a sheet as it loads, by sheet name; a sheet with no line is drawn as supplied. */
  readonly adjustments: ReadonlyMap<string, SheetAdjustment>;
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
  /**
   * Standing only: laid out in arrays up to this many sprites a side, side by
   * side along the ground, instead of one at a time. `1` for no arrays.
   */
  readonly array: number;
  /**
   * Standing only: lies flat on the ground, as a field does, so all of its
   * picture is ground and must lie over its own terrain, not just its foot.
   */
  readonly flat: boolean;
  /** Sprites of the sheet never drawn, by id: the sheet stays as supplied. */
  readonly leaveOut: readonly string[];
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
  const prospect = record(root['move_prospect'], 'manifest.json: move_prospect');
  const figurines = record(root['figurines'], 'manifest.json: figurines');
  const dice = record(root['dice'], 'manifest.json: dice');
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
      const side = dressing['array'] === undefined ? 1 : positive(dressing['array'], `${where}.dressing[${index}].array`);
      if (!Number.isInteger(side)) throw new ArtError(`${where}.dressing[${index}].array: must be a whole number`);
      return {
        sheet: string(dressing['sheet'], `${where}.dressing[${index}].sheet`),
        size,
        weight: positive(dressing['weight'], `${where}.dressing[${index}].weight`),
        layer,
        minSize,
        array: side,
        flat: flag(dressing['flat'], `${where}.dressing[${index}].flat`),
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
