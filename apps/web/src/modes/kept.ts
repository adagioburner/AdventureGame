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
  const kept: KeptGame = { seed, setup, diceSeed: game.setup.diceSeed, actions: game.turns.map((turn) => turn.action) };
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

/** The kept game played again on `map`; `null` if its turns no longer replay. */
export function replayKept(kept: KeptGame, map: GameMap): HotseatGame | null {
  try {
    const game = new HotseatGame({ map, seats: toHotseatSeats(kept.setup), diceSeed: kept.diceSeed });
    for (const action of kept.actions) game.play(action);
    return game;
  } catch {
    return null;
  }
}
