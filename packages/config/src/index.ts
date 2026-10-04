/**
 * `@adventure/config` — every constant GDD.md §11 requires to live in config,
 * plus the §4.2 content tables, plus a clearly fenced-off set of
 * implementation-only knobs.
 *
 * Layering rule: this package has **no dependencies**. Everything else depends
 * on it. Nothing in the repo may inline a number that appears here.
 */
export * from './vocabulary.ts';
export * from './types.ts';
export {
  DEFAULT_GAME_CONFIG,
  DEFAULT_ENGINEERING_CONFIG,
  EARLIER_TERRAIN_SEEDS,
  EARLIER_VALLEY_COUNT,
  LARGER_MAP_GAME_CONFIG,
  LARGER_MAP_ENGINEERING_CONFIG,
  RESPAWN_RULES,
} from './defaults.ts';
export {
  DEFAULT_GAME_CONTENT,
  DEFAULT_REWARD_TABLE,
  COIN_FLIP_FOREST_MAGIC_GUARD_CHANCE,
  FOREST_MAGIC_GUARD_CHANCE,
  FORTRESS_MIN_LINE_SPACES,
  FORTRESS_MIN_ROAD_STEPS,
  FORTRESSES_APART,
  LARGER_MAP_GAME_CONTENT,
  LARGER_MAP_REWARD_TABLE,
  LARGER_MAP_REWARD_TABLE_BEFORE_MOVE,
  REWARD_TABLE_BEFORE_MOVE,
} from './content.ts';
export { validateRuleset, resolvePending, RulesetError, UnresolvedDesignError } from './validate.ts';

import {
  DEFAULT_ENGINEERING_CONFIG,
  DEFAULT_GAME_CONFIG,
  EARLIER_VALLEY_COUNT,
  LARGER_MAP_ENGINEERING_CONFIG,
  LARGER_MAP_GAME_CONFIG,
} from './defaults.ts';
import {
  DEFAULT_GAME_CONTENT,
  LARGER_MAP_GAME_CONTENT,
  LARGER_MAP_REWARD_TABLE_BEFORE_MOVE,
  REWARD_TABLE_BEFORE_MOVE,
} from './content.ts';
import type { RewardTable, Ruleset } from './types.ts';
import { TERRAINS, type PerTerrain, type Terrain } from './vocabulary.ts';

/** The v1 ruleset: GDD.md §11 defaults + §4.2 content + engineering knobs. */
export const DEFAULT_RULESET: Ruleset = {
  config: DEFAULT_GAME_CONFIG,
  content: DEFAULT_GAME_CONTENT,
  engineering: DEFAULT_ENGINEERING_CONFIG,
};

/** [Q160] The 4 and 5 player ruleset: today's, on a map 40% larger. */
export const LARGER_MAP_RULESET: Ruleset = {
  config: LARGER_MAP_GAME_CONFIG,
  content: LARGER_MAP_GAME_CONTENT,
  engineering: LARGER_MAP_ENGINEERING_CONFIG,
};

/** [Q160] Games with this many players or more are played on the larger map. */
export const LARGER_MAP_FROM_PLAYERS = 4;

/** Which of the two maps a game is played on. */
export type MapSize = 'standard' | 'larger';

/** [Q160] The map a game of `players` is played on: larger from 4 players. */
export function mapSizeForPlayers(players: number): MapSize {
  return players >= LARGER_MAP_FROM_PLAYERS ? 'larger' : 'standard';
}

export function rulesetForMapSize(size: MapSize): Ruleset {
  return size === 'larger' ? LARGER_MAP_RULESET : DEFAULT_RULESET;
}

/** The ruleset, and so the map, of a game of `players`. */
export function rulesetForPlayers(players: number): Ruleset {
  return rulesetForMapSize(mapSizeForPlayers(players));
}

/**
 * Which map a ruleset draws, read from its space count, so it also works on a
 * ruleset that came back from the server as JSON and is no longer one of the
 * two objects above.
 */
export function mapSizeOfRuleset(ruleset: Ruleset): MapSize {
  return ruleset.config.map.MAP_NODE_COUNT === LARGER_MAP_GAME_CONFIG.map.MAP_NODE_COUNT ? 'larger' : 'standard';
}

/**
 * [Q185] The chance a forest gold site is magic-guarded under `ruleset`: the
 * `magicGuardChance` of its forest gold row, 0 when it has none.
 */
export function magicGuardChanceOf(ruleset: Ruleset): number {
  const row = ruleset.content.REWARD_TABLE.forest.find((candidate) => candidate.kind === 'gold');
  return row?.magicGuardChance ?? 0;
}

/**
 * [Q185, 730 A] `ruleset` with its forest gold sites magic-guarded at `chance`,
 * for a hot seat game kept from before the chance changed, so its map comes
 * back with the guards it began with. `ruleset` itself when that is its chance.
 */
export function withMagicGuardChance(ruleset: Ruleset, chance: number): Ruleset {
  if (magicGuardChanceOf(ruleset) === chance) return ruleset;
  const forest = ruleset.content.REWARD_TABLE.forest.map((row) =>
    row.kind === 'gold' ? { ...row, magicGuardChance: chance } : row,
  );
  return {
    ...ruleset,
    content: { ...ruleset.content, REWARD_TABLE: { ...ruleset.content.REWARD_TABLE, forest } },
  };
}

/**
 * [Q250] Whether maps made with `ruleset` have the rewards as they moved
 * terrain on 2026-10-04: the three speeds and the magic-guarded gold on the
 * plains, magic, combat and stamina in the forest, and so no gold in the
 * forest. False for a map made before, online or kept on one device, which
 * keeps the rewards it began with.
 */
export function rewardsMovedOf(ruleset: Ruleset): boolean {
  return !ruleset.content.REWARD_TABLE.forest.some((row) => row.kind === 'gold');
}

/**
 * [Q250] `ruleset` with the rewards by terrain as they were before they moved,
 * and each terrain's sites with them, so a hot seat game kept from before gets
 * back the map it began on. `ruleset` itself when it already has them. Apply
 * it before `withMagicGuardChance` and `withoutStaminaSites`, which change the
 * table it puts back.
 */
export function withRewardsBeforeMove(ruleset: Ruleset): Ruleset {
  if (!rewardsMovedOf(ruleset)) return ruleset;
  const table = mapSizeOfRuleset(ruleset) === 'larger' ? LARGER_MAP_REWARD_TABLE_BEFORE_MOVE : REWARD_TABLE_BEFORE_MOVE;
  const pois = ruleset.config.pois;
  return {
    ...ruleset,
    config: { ...ruleset.config, pois: { ...pois, POI_COUNT: sitesOf(table) } },
    content: { ...ruleset.content, REWARD_TABLE: table },
  };
}

/** Each terrain's sites under `table`: the sum of its rows' sites, as `POI_COUNT` must be. */
function sitesOf(table: RewardTable): PerTerrain<number> {
  const sites = (terrain: Terrain): number => table[terrain].reduce((sum, row) => sum + row.poiCount, 0);
  return { plains: sites('plains'), forest: sites('forest'), mountain: sites('mountain') };
}

/**
 * [Q227] Whether maps made with `ruleset` start the figures deep in the plains
 * where the sites nearby are not remote. False for a hot seat game kept from
 * before they did, whose start is made again as it was.
 */
export function deepStartOf(ruleset: Ruleset): boolean {
  return ruleset.config.start !== undefined;
}

/**
 * [Q227] `ruleset` as it was before the start moved deep into the plains, so a
 * hot seat game kept from before gets back the start it began on. `ruleset`
 * itself when it already is.
 */
export function withoutDeepStart(ruleset: Ruleset): Ruleset {
  if (!deepStartOf(ruleset)) return ruleset;
  const { start: _start, ...config } = ruleset.config;
  return { ...ruleset, config };
}

/**
 * [Q240] Whether maps made with `ruleset` have the plains' stamina sites, each
 * unit giving `STAMINA_PER_UNIT`. False for a hot seat game kept from before
 * they came, whose map is made again as it was.
 */
export function staminaSitesOf(ruleset: Ruleset): boolean {
  return ruleset.config.pois.STAMINA_PER_UNIT !== undefined;
}

/**
 * [Q240] `ruleset` as it was before the plains had stamina sites: no stamina
 * row, the plains' sites fewer by its sites, and a stamina unit worth 1, so a
 * hot seat game kept from before gets back the map it began on. `ruleset`
 * itself when it already is.
 */
export function withoutStaminaSites(ruleset: Ruleset): Ruleset {
  if (!staminaSitesOf(ruleset)) return ruleset;
  const table = ruleset.content.REWARD_TABLE;
  const sites = table.plains.filter((row) => row.kind === 'stamina').reduce((sum, row) => sum + row.poiCount, 0);
  const { STAMINA_PER_UNIT: _perUnit, ...pois } = ruleset.config.pois;
  return {
    ...ruleset,
    config: { ...ruleset.config, pois: { ...pois, POI_COUNT: { ...pois.POI_COUNT, plains: pois.POI_COUNT.plains - sites } } },
    content: { ...ruleset.content, REWARD_TABLE: { ...table, plains: table.plains.filter((row) => row.kind !== 'stamina') } },
  };
}

/**
 * [Q245] Whether maps made with `ruleset` grow their terrain from
 * `TERRAIN_SEEDS`, keep the `KEPT_APART` terrains' areas apart and carve no
 * valleys. False for a hot seat game kept from before, whose map is made again
 * as it began, from 1 or 2 seeds a terrain and with valleys.
 */
export function separateAreasOf(ruleset: Ruleset): boolean {
  return ruleset.config.map.TERRAIN_SEEDS !== undefined;
}

/**
 * [Q245] `ruleset` as it was before: no `TERRAIN_SEEDS`, nothing kept apart and
 * `EARLIER_VALLEY_COUNT` valleys, so a hot seat game kept from before gets back
 * the map it began on (913). `ruleset` itself when it already is.
 */
export function withoutSeparateAreas(ruleset: Ruleset): Ruleset {
  if (!separateAreasOf(ruleset)) return ruleset;
  const { TERRAIN_SEEDS: _seeds, KEPT_APART: _apart, ...map } = ruleset.config.map;
  return { ...ruleset, config: { ...ruleset.config, map: { ...map, VALLEY_COUNT: EARLIER_VALLEY_COUNT } } };
}

/**
 * [Q255] Whether maps made with `ruleset` keep the fortresses apart: whether
 * any row of its table has `apart`. False for a map made before, online or
 * kept on one device, which keeps its fortresses where they were drawn (933 A).
 */
export function fortressesApartOf(ruleset: Ruleset): boolean {
  return TERRAINS.some((terrain) => ruleset.content.REWARD_TABLE[terrain].some((row) => row.apart !== undefined));
}

/**
 * [Q255] `ruleset` as it was before the fortresses were kept apart, so a hot
 * seat game kept from before gets back the map it began on. `ruleset` itself
 * when it already is.
 */
export function withoutFortressesApart(ruleset: Ruleset): Ruleset {
  if (!fortressesApartOf(ruleset)) return ruleset;
  const anywhere = (rows: RewardTable[Terrain]): RewardTable[Terrain] =>
    rows.map(({ apart: _apart, ...row }) => row);
  const table = ruleset.content.REWARD_TABLE;
  return {
    ...ruleset,
    content: {
      ...ruleset.content,
      REWARD_TABLE: { plains: anywhere(table.plains), forest: anywhere(table.forest), mountain: anywhere(table.mountain) },
    },
  };
}

/**
 * [SOURCE §2, chat] Starting stamina for a 1-based seat:
 * `STARTING_STAMINA_BASE + (seat − 1) × STARTING_STAMINA_INCREMENT`.
 *
 * Kept as a formula over config rather than a per-seat table so that raising
 * `PLAYER_COUNT.max` generalises with no further design input.
 */
export function startingStaminaForSeat(seat: number, ruleset: Ruleset): number {
  const { STARTING_STAMINA_BASE, STARTING_STAMINA_INCREMENT } = ruleset.config.players;
  return STARTING_STAMINA_BASE + (seat - 1) * STARTING_STAMINA_INCREMENT;
}

/**
 * [Q200] The gold every player starts with: `STARTING_GOLD`, the same for
 * every seat, or none in a game started before players started with gold
 * (790), whose map has no `STARTING_GOLD`.
 */
export function startingGoldOf(ruleset: Ruleset): number {
  return ruleset.config.players.STARTING_GOLD ?? 0;
}
