import type { BuyAction, GameMap, TurnAction } from '@adventure/core';
import { inOrder, toHotseatSeats, type LocalSetup } from '../setup/local.ts';
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
  /** The seats as set on the New game panel, which shows them so again after New game. */
  readonly setup: LocalSetup;
  /**
   * [Q165, 650] The seats' ids in the order the game started with, drawn by
   * Shuffle seats. Absent when the seats went as set.
   */
  readonly order?: readonly string[];
  readonly diceSeed: string;
  /** Every turn played, and [Q190] every purchase, in order. */
  readonly actions: readonly (TurnAction | BuyAction)[];
}

// [950 A] A new name since 2026-10-05: games kept under 'adventure.hotseat',
// before the old games' rules were removed, are never read.
const KEY = 'adventure.hotseat.2';

/** The game kept in this browser, or `null` when there is none or it cannot be read. */
export function readKept(): KeptGame | null {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === null) return null;
    const kept = JSON.parse(stored) as Partial<KeptGame>;
    if (typeof kept.seed !== 'string' || typeof kept.diceSeed !== 'string' || !Array.isArray(kept.actions) || !Array.isArray(kept.setup?.seats)) {
      return null;
    }
    if (kept.order !== undefined && !(Array.isArray(kept.order) && kept.order.every((id) => typeof id === 'string'))) {
      const { order: _order, ...rest } = kept;
      return rest as KeptGame;
    }
    return kept as KeptGame;
  } catch {
    return null;
  }
}

/**
 * Keeps `game`, as set up with `setup` on the map for `seed`, its seats in
 * `order` (`null`: as set); without storage, nothing is kept.
 */
export function keep(seed: string, setup: LocalSetup, order: readonly string[] | null, game: HotseatGame): void {
  const kept: KeptGame = {
    seed,
    setup,
    ...(order === null ? {} : { order }),
    diceSeed: game.setup.diceSeed,
    actions: game.actions,
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

/** The kept game played again on `map`; `null` if its turns no longer replay. */
export function replayKept(kept: KeptGame, map: GameMap): HotseatGame | null {
  try {
    const game = new HotseatGame({ map, seats: toHotseatSeats(inOrder(kept.setup, kept.order ?? null)), diceSeed: kept.diceSeed });
    for (const action of kept.actions) {
      if (action.kind === 'buy') game.buy(action);
      else game.play(action);
    }
    return game;
  } catch {
    return null;
  }
}
