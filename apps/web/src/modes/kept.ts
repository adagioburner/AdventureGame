import {
  COIN_FLIP_FOREST_MAGIC_GUARD_CHANCE,
  RESPAWN_RULES,
  deepStartOf,
  magicGuardChanceOf,
  mapSizeOfRuleset,
  staminaSitesOf,
  startingGoldOf,
  type MapSize,
} from '@adventure/config';
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
  /**
   * [Q190] Whether speeds and skills can be bought in this game. Absent on a
   * game kept before they could, which goes on by the rules it began with.
   */
  readonly buying?: boolean;
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
  /**
   * [Q185, 730 A] The chance its forest gold sites were magic-guarded when the
   * game began. Absent on a game kept before every forest gold site was magic,
   * which goes on with the coin-flip guards it began with.
   */
  readonly magicGuardChance?: number;
  /**
   * [Q200] The gold every player started with. Absent on a game kept before
   * players started with gold, whose players started with none (790).
   */
  readonly startingGold?: number;
  /**
   * [Q227] Whether the game's map started the figures deep in the plains.
   * Absent on a game kept before it did, whose map is made again with the
   * start it began on.
   */
  readonly deepStart?: boolean;
  /**
   * [Q240] Whether the game's map has the plains' stamina sites, each unit
   * worth 5 stamina. Absent on a game kept before they came, whose map is made
   * again as it began, its stamina units worth 1.
   */
  readonly staminaSites?: boolean;
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
  const { respawn, buying } = game.setup.map.ruleset.config;
  const kept: KeptGame = {
    seed,
    setup,
    ...(order === null ? {} : { order }),
    diceSeed: game.setup.diceSeed,
    actions: game.actions,
    buying: buying !== undefined,
    respawn: respawn !== undefined,
    ...(respawn?.MAX_UNITS === undefined ? {} : { respawnMaxUnits: respawn.MAX_UNITS }),
    mapSize: mapSizeOfRuleset(game.setup.map.ruleset),
    magicGuardChance: magicGuardChanceOf(game.setup.map.ruleset),
    startingGold: startingGoldOf(game.setup.map.ruleset),
    deepStart: deepStartOf(game.setup.map.ruleset),
    staminaSites: staminaSitesOf(game.setup.map.ruleset),
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

/** The chance `kept`'s forest gold sites are magic-guarded at: see `KeptGame.magicGuardChance`. */
export function keptMagicGuardChance(kept: KeptGame): number {
  return typeof kept.magicGuardChance === 'number' ? kept.magicGuardChance : COIN_FLIP_FOREST_MAGIC_GUARD_CHANCE;
}

/** Whether `kept`'s map starts deep in the plains: see `KeptGame.deepStart`. */
export function keptDeepStart(kept: KeptGame): boolean {
  return kept.deepStart === true;
}

/** Whether `kept`'s map has the plains' stamina sites: see `KeptGame.staminaSites`. */
export function keptStaminaSites(kept: KeptGame): boolean {
  return kept.staminaSites === true;
}

/** The kept game played again on `map`; `null` if its turns no longer replay. */
export function replayKept(kept: KeptGame, map: GameMap): HotseatGame | null {
  try {
    const rules = withStartingGold(
      kept.buying === true ? map : startedBeforeBuying(map, kept.respawn === true, kept.respawnMaxUnits),
      typeof kept.startingGold === 'number' ? kept.startingGold : 0,
    );
    const game = new HotseatGame({ map: rules, seats: toHotseatSeats(inOrder(kept.setup, kept.order ?? null)), diceSeed: kept.diceSeed });
    for (const action of kept.actions) {
      if (action.kind === 'buy') game.buy(action);
      else game.play(action);
    }
    return game;
  } catch {
    return null;
  }
}

/**
 * `map` under the rules a game kept before buying began with (Q190, 758): no
 * buying, and speeds and skills coming back if they did then (Q135), at most
 * `max` units a site, or everything it started with when `max` is absent.
 */
function startedBeforeBuying(map: GameMap, respawn: boolean, max: number | undefined): GameMap {
  const { buying: _buying, respawn: _respawn, ...config } = map.ruleset.config;
  if (!respawn) return { ...map, ruleset: { ...map.ruleset, config } };
  const { MAX_UNITS: _max, ...uncapped } = RESPAWN_RULES;
  const rules = max === undefined ? uncapped : { ...uncapped, MAX_UNITS: max };
  return { ...map, ruleset: { ...map.ruleset, config: { ...config, respawn: rules } } };
}

/** `map` with its players starting on `gold` (Q200): none for a game kept before they started with any. */
function withStartingGold(map: GameMap, gold: number): GameMap {
  if (startingGoldOf(map.ruleset) === gold) return map;
  const { STARTING_GOLD: _gold, ...players } = map.ruleset.config.players;
  const config = { ...map.ruleset.config, players: gold === 0 ? players : { ...players, STARTING_GOLD: gold } };
  return { ...map, ruleset: { ...map.ruleset, config } };
}
