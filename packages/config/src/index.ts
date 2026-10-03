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
  LARGER_MAP_GAME_CONFIG,
  LARGER_MAP_ENGINEERING_CONFIG,
  RESPAWN_RULES,
} from './defaults.ts';
export {
  DEFAULT_GAME_CONTENT,
  DEFAULT_REWARD_TABLE,
  COIN_FLIP_FOREST_MAGIC_GUARD_CHANCE,
  FOREST_MAGIC_GUARD_CHANCE,
  LARGER_MAP_GAME_CONTENT,
  LARGER_MAP_REWARD_TABLE,
} from './content.ts';
export { validateRuleset, resolvePending, RulesetError, UnresolvedDesignError } from './validate.ts';

import {
  DEFAULT_ENGINEERING_CONFIG,
  DEFAULT_GAME_CONFIG,
  LARGER_MAP_ENGINEERING_CONFIG,
  LARGER_MAP_GAME_CONFIG,
} from './defaults.ts';
import { DEFAULT_GAME_CONTENT, LARGER_MAP_GAME_CONTENT } from './content.ts';
import type { Ruleset } from './types.ts';

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
