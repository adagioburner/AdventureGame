import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESPAWN_RULES, TERRAINS, startingGoldOf } from '@adventure/config';
import { createRng, startingNodeFor } from '@adventure/core';
import { mapFor } from '../page/seed.ts';
import { inOrder, toHotseatSeats, type LocalSetup } from '../setup/local.ts';
import { HotseatGame } from './hotseat.ts';
import {
  forgetKept,
  keep,
  keptDeepStart,
  keptFortressesApart,
  keptMagicGuardChance,
  keptMapSize,
  keptMoreStaminaUnits,
  keptRewardsMoved,
  keptSeparateAreas,
  keptStaminaSites,
  readKept,
  replayKept,
} from './kept.ts';

const map = mapFor('adventure', 'standard');
const setup: LocalSetup = {
  seats: [
    { id: 'seat-1', name: 'Ada', avatarId: 'player_avatars_01', control: 'human', thinkingSeconds: 5 },
    { id: 'seat-2', name: 'Bram', avatarId: 'player_avatars_02', control: 'human', thinkingSeconds: 5 },
  ],
  nextId: 3,
};

describe('a game on one device kept in the browser (Q56, 66)', () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('comes back after a reload exactly where it was, dice included', () => {
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    for (let turn = 0; turn < 12; turn += 1) {
      const player = game.state.players[game.state.turn.activeSeat - 1];
      if (player === undefined) throw new Error('no player on turn');
      game.play(turn % 3 === 0 ? { kind: 'rest', player: player.id } : { kind: 'move', player: player.id, path: [] });
    }
    keep('adventure', setup, null, game);

    const kept = readKept();
    expect(kept).toMatchObject({ seed: 'adventure', diceSeed: 'kept', setup });
    const again = kept === null ? null : replayKept(kept, map);
    expect(again?.state).toEqual(game.state);
    expect(again?.turns.length).toBe(12);
  });

  it('keeps that speeds and skills can be bought, and replays a game kept before buying by its old rules (Q190, 758)', () => {
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    keep('adventure', setup, null, game);
    const kept = readKept();
    expect(kept).toMatchObject({ buying: true, respawn: false });
    expect(kept === null ? null : replayKept(kept, map)?.setup.map).toBe(map);

    // Kept on 2026-10-01: skills came back, at most 1 unit a site, and nothing could be bought.
    const { buying: _buying, ...older } = kept ?? { buying: undefined };
    const respawned = replayKept({ ...(older as NonNullable<typeof kept>), respawn: true, respawnMaxUnits: 1 }, map)?.setup.map.ruleset.config;
    expect(respawned?.buying).toBeUndefined();
    expect(respawned?.respawn).toEqual(RESPAWN_RULES);
    expect(replayKept({ ...(older as NonNullable<typeof kept>), respawn: true, respawnMaxUnits: 2 }, map)?.setup.map.ruleset.config.respawn?.MAX_UNITS).toBe(2);
    const uncapped = replayKept({ ...(older as NonNullable<typeof kept>), respawn: true }, map)?.setup.map.ruleset.config.respawn;
    expect(uncapped?.MAX_UNITS).toBeUndefined();
    expect(uncapped?.SHORT_BELOW_SITES).toBe(RESPAWN_RULES.SHORT_BELOW_SITES);

    // Kept before skills came back (Q135): neither.
    const { respawn: _respawn, ...oldest } = older as NonNullable<typeof kept>;
    const before = replayKept(oldest as NonNullable<typeof kept>, map)?.setup.map;
    expect(before?.ruleset.config.respawn).toBeUndefined();
    expect(before?.ruleset.config.buying).toBeUndefined();
    expect(before?.graph).toBe(map.graph);
  });

  it('comes back with its purchases (Q190)', () => {
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept-buy' });
    // Ada buys with the gold she started with (Q200).
    expect(game.state.players[0]?.stats.gold).toBe(startingGoldOf(map.ruleset));
    game.buy({ kind: 'buy', player: game.state.players[0]!.id, skills: ['magic'] });
    keep('adventure', setup, null, game);

    const kept = readKept();
    expect(kept?.actions.at(-1)).toEqual({ kind: 'buy', player: 'seat-1', skills: ['magic'] });
    const again = kept === null ? null : replayKept(kept, map);
    expect(again?.state).toEqual(game.state);
    expect(again?.state.players[0]?.stats.magic).toBe(1);
  });

  it('keeps the size of map a game is played on, and puts a game kept before maps grew on the standard map (Q160)', () => {
    const fourSeats: LocalSetup = {
      seats: [
        ...setup.seats,
        { id: 'seat-3', name: 'Cleo', avatarId: 'player_avatars_03', control: 'human', thinkingSeconds: 5 },
        { id: 'seat-4', name: 'Dov', avatarId: 'player_avatars_04', control: 'human', thinkingSeconds: 5 },
      ],
      nextId: 5,
    };
    const larger = mapFor('adventure', 'larger');
    keep('adventure', fourSeats, null, new HotseatGame({ map: larger, seats: toHotseatSeats(fourSeats), diceSeed: 'kept' }));
    const kept = readKept();
    expect(kept?.mapSize).toBe('larger');
    expect(kept === null ? null : keptMapSize(kept)).toBe('larger');

    // Before Q160 a four-player game was on the standard map, and nothing was kept about it.
    const { mapSize: _mapSize, ...older } = kept ?? { mapSize: undefined };
    expect(keptMapSize(older as NonNullable<typeof kept>)).toBe('standard');
    keep('adventure', fourSeats, null, new HotseatGame({ map, seats: toHotseatSeats(fourSeats), diceSeed: 'kept' }));
    expect(readKept()?.mapSize).toBe('standard');
  });

  it('keeps the chance forest gold is magic-guarded at, and resumes a game kept before it was always magic on its coin flips (Q185, 730)', () => {
    const forestGuards = (on: typeof map): string[] =>
      on.pois.flatMap((poi) => (poi.terrain === 'forest' && poi.guard !== null ? [poi.guard.type] : []));
    keep('adventure', setup, null, new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' }));
    const kept = readKept();
    // [Q250] Today's forest holds no gold, so no chance to keep.
    expect(kept?.magicGuardChance).toBe(0);
    expect(forestGuards(map)).toEqual([]);

    // A game kept on 2026-10-01, before the rewards moved: every forest gold guard magic.
    const { rewardsMoved: _moved, separateAreas: _areas, ...unmoved } = kept ?? { rewardsMoved: undefined };
    const always = { ...(unmoved as NonNullable<typeof kept>), magicGuardChance: 1 };
    expect(keptMagicGuardChance(always)).toBe(1);
    const allMagic = mapFor('adventure', 'standard', keptMagicGuardChance(always), true, true, keptSeparateAreas(always), keptRewardsMoved(always));
    expect(new Set(forestGuards(allMagic))).toEqual(new Set(['magic']));

    // A game kept from 2026-09-30 began with each forest gold guard a coin flip.
    const { magicGuardChance: _chance, ...older } = always;
    const before = older as NonNullable<typeof kept>;
    expect(keptMagicGuardChance(before)).toBe(0.5);
    const coinFlips = mapFor('adventure', 'standard', keptMagicGuardChance(before), true, true, keptSeparateAreas(before), keptRewardsMoved(before));
    expect(new Set(forestGuards(coinFlips))).toEqual(new Set(['fighting', 'magic']));
    expect(coinFlips.graph).toEqual(allMagic.graph);
    expect(replayKept(before, coinFlips)?.setup.map).toBe(coinFlips);
  });

  it('keeps the gold players started with, and resumes a game kept before they started with any on none (Q200, 790)', () => {
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    game.play({ kind: 'rest', player: game.state.players[0]!.id });
    keep('adventure', setup, null, game);
    const kept = readKept();
    expect(kept?.startingGold).toBe(5);
    const again = kept === null ? null : replayKept(kept, map);
    expect(again?.setup.map).toBe(map);
    expect(again?.state.players.map((player) => player.stats.gold)).toEqual([5, 5]);

    // Kept before players started with gold.
    const { startingGold: _gold, ...older } = kept ?? { startingGold: undefined };
    const before = replayKept(older as NonNullable<typeof kept>, map);
    expect(before?.setup.map.ruleset.config.players.STARTING_GOLD).toBeUndefined();
    expect(before?.state.players.map((player) => player.stats.gold)).toEqual([0, 0]);
    expect(before?.turns.length).toBe(1);
  });

  it('keeps a map that starts deep in the plains, and makes a game kept before on the start it began on (Q227)', () => {
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    game.play({ kind: 'rest', player: game.state.players[0]!.id });
    keep('adventure', setup, null, game);
    const kept = readKept();
    expect(kept?.deepStart).toBe(true);
    expect(kept === null ? null : keptDeepStart(kept)).toBe(true);
    const again = kept === null ? null : replayKept(kept, map);
    expect(again?.setup.map).toBe(map);
    expect(again?.state).toEqual(game.state);

    // Kept before: the same roads, sites and rewards, but the start drawn at
    // random from the plains spaces that are not sites, as it was then.
    const { deepStart: _deep, ...older } = kept ?? { deepStart: undefined };
    const before = older as NonNullable<typeof kept>;
    expect(keptDeepStart(before)).toBe(false);
    const began = mapFor('adventure', 'standard', undefined, keptDeepStart(before));
    expect(began.ruleset.config.start).toBeUndefined();
    expect(began.graph).toEqual(map.graph);
    expect(began.pois).toEqual(map.pois);
    const plains = began.graph.nodes.filter((node) => node.terrain === 'plains' && !began.poiByNode.has(node.id)).map((node) => node.id);
    expect(startingNodeFor(began)).toBe(createRng('adventure').fork('starting-node').pick(plains));
    expect(startingNodeFor(began)).not.toBe(startingNodeFor(map));
    const resumed = replayKept(before, began);
    expect(resumed?.setup.map).toBe(began);
    expect(resumed?.state.players.map((player) => player.position)).toEqual([startingNodeFor(began), startingNodeFor(began)]);
    expect(resumed?.turns.length).toBe(1);
  });

  it('keeps a map with stamina sites, and makes a game kept before on the map it began on (Q240)', () => {
    // [Q250] The table's stamina sites are in the forest; before the rewards moved, on the plains.
    const tabled = (on: typeof map, terrain = 'forest'): number =>
      on.pois.filter((poi) => poi.terrain === terrain && poi.reward.kind === 'stamina').length;
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    game.play({ kind: 'rest', player: game.state.players[0]!.id });
    keep('adventure', setup, null, game);
    const kept = readKept();
    expect(kept?.staminaSites).toBe(true);
    expect(kept === null ? null : keptStaminaSites(kept)).toBe(true);
    expect(map.ruleset.config.pois.STAMINA_PER_UNIT).toBe(5);
    expect(tabled(map)).toBeGreaterThanOrEqual(5);
    expect(replayKept(kept!, map)?.state).toEqual(game.state);

    // Kept before: no stamina row, 25 plains sites, and a stamina unit worth 1.
    const { staminaSites: _sites, separateAreas: _areas, rewardsMoved: _moved, ...older } = kept ?? { staminaSites: undefined };
    const before = older as NonNullable<typeof kept>;
    expect(keptStaminaSites(before)).toBe(false);
    const began = mapFor('adventure', 'standard', undefined, true, keptStaminaSites(before), keptSeparateAreas(before), keptRewardsMoved(before));
    expect(began.ruleset.config.pois.STAMINA_PER_UNIT).toBeUndefined();
    expect(began.ruleset.config.pois.POI_COUNT.plains).toBe(25);
    expect(TERRAINS.some((terrain) => began.ruleset.content.REWARD_TABLE[terrain].some((row) => row.kind === 'stamina'))).toBe(false);
    expect(tabled(began, 'plains')).toBeLessThan(5);
    const resumed = replayKept(before, began);
    expect(resumed?.setup.map).toBe(began);
    expect(resumed?.turns.length).toBe(1);
  });

  it('keeps a map with the rewards where they moved, and makes a game kept before on the map it began on (Q250)', () => {
    const kinds = (on: typeof map, terrain: string): Set<string> =>
      new Set(on.pois.filter((poi) => poi.terrain === terrain && poi.reward.kind !== 'stamina').map((poi) => poi.reward.kind));
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    game.play({ kind: 'rest', player: game.state.players[0]!.id });
    keep('adventure', setup, null, game);
    const kept = readKept();
    expect(kept?.rewardsMoved).toBe(true);
    expect(kept === null ? null : keptRewardsMoved(kept)).toBe(true);
    expect(kinds(map, 'forest')).toEqual(new Set(['magic', 'fighting']));
    expect(map.ruleset.config.pois.POI_COUNT).toEqual({ plains: 32, forest: 20, mountain: 15 });
    expect(replayKept(kept!, map)?.state).toEqual(game.state);

    // Kept before, its terrain already in separate areas: mountains speed, combat
    // and magic-guarded gold in the forest, 30 plains sites.
    const { rewardsMoved: _moved, ...older } = kept ?? { rewardsMoved: undefined };
    const before = { ...(older as NonNullable<typeof kept>), magicGuardChance: 1 };
    expect(keptRewardsMoved(before)).toBe(false);
    expect(keptSeparateAreas(before)).toBe(true);
    const began = mapFor('adventure', 'standard', keptMagicGuardChance(before), true, true, keptSeparateAreas(before), keptRewardsMoved(before));
    expect(kinds(began, 'forest')).toEqual(new Set(['mountain_move', 'fighting', 'gold']));
    expect(began.ruleset.config.pois.POI_COUNT).toEqual({ plains: 30, forest: 20, mountain: 15 });
    expect(began.ruleset.config.pois.STAMINA_PER_UNIT).toBe(5);
    const resumed = replayKept(before, began);
    expect(resumed?.setup.map).toBe(began);
    expect(resumed?.turns.length).toBe(1);
  });

  it('keeps a map grown in separate areas without valleys, and makes a game kept before on the map it began on (Q245)', () => {
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    game.play({ kind: 'rest', player: game.state.players[0]!.id });
    keep('adventure', setup, null, game);
    const kept = readKept();
    expect(kept?.separateAreas).toBe(true);
    expect(kept === null ? null : keptSeparateAreas(kept)).toBe(true);
    expect(map.ruleset.config.map.TERRAIN_SEEDS?.forest).toEqual({ min: 2, max: 2 });
    expect(map.ruleset.config.map.VALLEY_COUNT).toEqual({ min: 0, max: 0 });
    expect(replayKept(kept!, map)?.state).toEqual(game.state);

    // Kept before: the same seed grows its terrain from 1 or 2 seeds a terrain, as it began.
    // [Q250] Its rewards were on the terrains they had before they moved, too.
    const { separateAreas: _seeds, rewardsMoved: _moved, ...older } = kept ?? { separateAreas: undefined };
    const before = { ...(older as NonNullable<typeof kept>), magicGuardChance: 1 };
    expect(keptSeparateAreas(before)).toBe(false);
    const began = mapFor('adventure', 'standard', keptMagicGuardChance(before), true, true, keptSeparateAreas(before), keptRewardsMoved(before));
    expect(began.ruleset.config.map.TERRAIN_SEEDS).toBeUndefined();
    expect(began.ruleset.config.map.KEPT_APART).toBeUndefined();
    expect(began.ruleset.config.map.VALLEY_COUNT).toEqual({ min: 2, max: 4 });
    expect(began.graph.nodes.map((node) => node.terrain)).not.toEqual(map.graph.nodes.map((node) => node.terrain));
    const resumed = replayKept(before, began);
    expect(resumed?.setup.map).toBe(began);
    expect(resumed?.turns.length).toBe(1);
  });

  it('keeps a map with its fortresses kept apart, and makes a game kept before on the map it began on (Q255, 933)', () => {
    const fortresses = (on: typeof map): number[] =>
      on.pois.filter((poi) => poi.terrain === 'plains' && poi.reward.kind === 'gold' && poi.group.guard === 'fighting').map((poi) => poi.node);
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    game.play({ kind: 'rest', player: game.state.players[0]!.id });
    keep('adventure', setup, null, game);
    const kept = readKept();
    expect(kept?.fortressesApart).toBe(true);
    expect(kept === null ? null : keptFortressesApart(kept)).toBe(true);
    expect(replayKept(kept!, map)?.state).toEqual(game.state);

    // Kept before: the same roads and sites, with the fortresses where they were drawn.
    const { fortressesApart: _apart, ...older } = kept ?? { fortressesApart: undefined };
    const before = older as NonNullable<typeof kept>;
    expect(keptFortressesApart(before)).toBe(false);
    expect(keptRewardsMoved(before)).toBe(true);
    const began = mapFor(
      'adventure', 'standard', keptMagicGuardChance(before), keptDeepStart(before), keptStaminaSites(before),
      keptSeparateAreas(before), keptRewardsMoved(before), keptFortressesApart(before),
    );
    expect(began.graph).toEqual(map.graph);
    expect(began.pois.map((poi) => poi.node)).toEqual(map.pois.map((poi) => poi.node));
    expect(fortresses(began)).not.toEqual(fortresses(map));
    const resumed = replayKept(before, began);
    expect(resumed?.setup.map).toBe(began);
    expect(resumed?.turns.length).toBe(1);
  });

  it('keeps a map with 12 hearts on its stamina sites, and makes a game kept before on the map it began on (Q260, 941 A)', () => {
    const hearts = (on: typeof map): number =>
      on.pois.filter((poi) => poi.terrain === 'forest' && poi.reward.kind === 'stamina').reduce((sum, poi) => sum + poi.reward.units, 0);
    expect(hearts(map)).toBe(12);
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    game.play({ kind: 'rest', player: game.state.players[0]!.id });
    keep('adventure', setup, null, game);
    const kept = readKept();
    expect(kept?.moreStaminaUnits).toBe(true);
    expect(kept === null ? null : keptMoreStaminaUnits(kept)).toBe(true);
    expect(replayKept(kept!, map)?.state).toEqual(game.state);

    // Kept before: the map it began on, with 10 hearts.
    const { moreStaminaUnits: _more, ...older } = kept ?? { moreStaminaUnits: undefined };
    const before = older as NonNullable<typeof kept>;
    expect(keptMoreStaminaUnits(before)).toBe(false);
    expect(keptFortressesApart(before)).toBe(true);
    const began = mapFor(
      'adventure', 'standard', keptMagicGuardChance(before), keptDeepStart(before), keptStaminaSites(before),
      keptSeparateAreas(before), keptRewardsMoved(before), keptFortressesApart(before), keptMoreStaminaUnits(before),
    );
    expect(hearts(began)).toBe(10);
    expect(began.graph).toEqual(map.graph);
    expect(began.pois.map((poi) => poi.node)).toEqual(map.pois.map((poi) => poi.node));
    const resumed = replayKept(before, began);
    expect(resumed?.setup.map).toBe(began);
    expect(resumed?.turns.length).toBe(1);
  });

  it('keeps the order Shuffle seats drew, and the seats as set for the next New game (Q165)', () => {
    const drawn = inOrder(setup, ['seat-2', 'seat-1']);
    const game = new HotseatGame({ map, seats: toHotseatSeats(drawn), diceSeed: 'kept' });
    game.play({ kind: 'rest', player: game.state.players[0]!.id });
    keep('adventure', setup, ['seat-2', 'seat-1'], game);

    const kept = readKept();
    expect(kept?.setup).toEqual(setup);
    expect(kept?.order).toEqual(['seat-2', 'seat-1']);
    const again = kept === null ? null : replayKept(kept, map);
    expect(again?.state.players.map((player) => [player.seat, player.name, player.stats.stamina])).toEqual([
      [1, 'Bram', 35],
      [2, 'Ada', 35],
    ]);
    expect(again?.state).toEqual(game.state);

    // A game kept before the switch has no order: its seats went as set.
    keep('adventure', setup, null, new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' }));
    expect(readKept()?.order).toBeUndefined();
  });

  it('is forgotten by New game, and a store that cannot be read keeps nothing', () => {
    keep('adventure', setup, null, new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' }));
    forgetKept();
    expect(readKept()).toBeNull();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
      },
    };
    expect(readKept()).toBeNull();
  });
});
