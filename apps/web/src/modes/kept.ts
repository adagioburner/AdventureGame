import { mapSizeOfRuleset, type MapSize } from '@adventure/config';
import type { GameMap, TurnAction } from '@adventure/core';
import { toHotseatSeats, type LocalSetup } from '../setup/local.ts';
import { HotseatGame } from './hotseat.ts';

/**
 * [Q56, 66] A game on one device is kept in that browser, so reloading or
 * reopening the page picks it up where it was, on the site and on the game
 * page. It is kept as what makes it: the map's seed, the seats, the die's seed
 * and every turn played, which replay to the same game. New game forgets it;
 * another device never sees it.
 */
export interface KeptGame {
  readonly seed: string;
  readonly setup: LocalSetup;
  readonly diceSeed: string;
  readonly actions: readonly TurnAction[];
  /**
   * [Q135] Whether speeds and skills come back in this game. Absent on a game
   * kept before they did, which replays, and goes on, by the rules it began with.
   */
  readonly respawn?: boolean;
  /**
   * [Q135] The most units a site that comes back offers in this game. Absent
   * on a game kept before the cap, whose sites come back with everything
   * they started with.
   */
  readonly respawnMaxUnits?: number;
  /**
   * [Q160] The size of map the game is played on, larger from 4 players.
   * Absent on a game kept before maps grew, which goes on on the map it began
   * on: today's size, whatever its number of players.
   */
  readonly mapSize?: MapSize;
}

const KEY = 'adventure.hotseat';

/** The game kept in this browser, or `null` when there is none or it cannot be read. */
export function readKept(): KeptGame | null {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === null) return null;
    const kept = JSON.parse(stored) as Partial<KeptGame>;
    if (typeof kept.seed !== 'string' || typeof kept.diceSeed !== 'string' || !Array.isArray(kept.actions) || !Array.isArray(kept.setup?.seats)) {
      return null;
    }
    return kept as KeptGame;
  } catch {
    return null;
  }
}

/** Keeps `game`, as set up with `setup` on the map for `seed`; without storage, nothing is kept. */
export function keep(seed: string, setup: LocalSetup, game: HotseatGame): void {
  const respawn = game.setup.map.ruleset.config.respawn;
  const kept: KeptGame = {
    seed,
    setup,
    diceSeed: game.setup.diceSeed,
    actions: game.turns.map((turn) => turn.action),
    respawn: respawn !== undefined,
    ...(respawn?.MAX_UNITS === undefined ? {} : { respawnMaxUnits: respawn.MAX_UNITS }),
    mapSize: mapSizeOfRuleset(game.setup.map.ruleset),
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // A private window or full storage: the game goes on, and a reload loses it.
  }
}

export function forgetKept(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing was kept.
  }
}

/** The size of the map `kept` is played on: see `KeptGame.mapSize`. */
export function keptMapSize(kept: KeptGame): MapSize {
  return kept.mapSize === 'larger' ? 'larger' : 'standard';
}

/** The kept game played again on `map`; `null` if its turns no longer replay. */
export function replayKept(kept: KeptGame, map: GameMap): HotseatGame | null {
  try {
    const rules = kept.respawn === true ? withRespawnCap(map, kept.respawnMaxUnits) : withoutRespawn(map);
    const game = new HotseatGame({ map: rules, seats: toHotseatSeats(kept.setup), diceSeed: kept.diceSeed });
    for (const action of kept.actions) game.play(action);
    return game;
  } catch {
    return null;
  }
}

/** `map` under the rules from before speeds and skills came back (Q135). */
function withoutRespawn(map: GameMap): GameMap {
  const { respawn: _respawn, ...config } = map.ruleset.config;
  return { ...map, ruleset: { ...map.ruleset, config } };
}

/** `map` with sites coming back at most `max` units, or with everything they started with when `max` is absent (Q135). */
function withRespawnCap(map: GameMap, max: number | undefined): GameMap {
  const respawn = map.ruleset.config.respawn;
  if (respawn === undefined || respawn.MAX_UNITS === max) return map;
  const { MAX_UNITS: _max, ...uncapped } = respawn;
  const capped = max === undefined ? uncapped : { ...uncapped, MAX_UNITS: max };
  return { ...map, ruleset: { ...map.ruleset, config: { ...map.ruleset.config, respawn: capped } } };
}
