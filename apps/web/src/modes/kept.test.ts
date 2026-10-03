import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESPAWN_RULES } from '@adventure/config';
import { routeTable } from '@adventure/core';
import { mapFor } from '../page/seed.ts';
import { inOrder, toHotseatSeats, type LocalSetup } from '../setup/local.ts';
import { HotseatGame } from './hotseat.ts';
import { forgetKept, keep, keptMagicGuardChance, keptMapSize, readKept, replayKept } from './kept.ts';

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
    const config = map.ruleset.config;
    const gold = map.pois.find((poi) => poi.reward.kind === 'gold' && poi.guard === null);
    if (gold === undefined) throw new Error('no unguarded gold on the map');
    // Ada walks to the gold, resting when she runs short of stamina, while Bram rests; then she buys with it.
    for (let turn = 0; turn < 200 && game.state.players[0]!.stats.gold === 0; turn += 1) {
      const player = game.state.players[game.state.turn.activeSeat - 1]!;
      const path = routeTable(map.graph, config).path(player.position, gold.node) ?? [];
      const walks = player.seat === 1 && player.stats.stamina >= 3;
      game.play(walks ? { kind: 'move', player: player.id, path } : { kind: 'rest', player: player.id });
    }
    if (game.state.turn.activeSeat === 2) game.play({ kind: 'rest', player: game.state.players[1]!.id });
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
    expect(kept?.magicGuardChance).toBe(1);
    expect(kept === null ? null : keptMagicGuardChance(kept)).toBe(1);
    expect(new Set(forestGuards(map))).toEqual(new Set(['magic']));

    // A game kept from 2026-09-30 began with each forest gold guard a coin flip.
    const { magicGuardChance: _chance, ...older } = kept ?? { magicGuardChance: undefined };
    const before = older as NonNullable<typeof kept>;
    expect(keptMagicGuardChance(before)).toBe(0.5);
    const coinFlips = mapFor('adventure', 'standard', keptMagicGuardChance(before));
    expect(new Set(forestGuards(coinFlips))).toEqual(new Set(['fighting', 'magic']));
    expect(coinFlips.graph).toEqual(map.graph);
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

  it('keeps a start away from the forest, and resumes a game kept before on the start it began on (Q225, 853)', () => {
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    game.play({ kind: 'rest', player: game.state.players[0]!.id });
    keep('adventure', setup, null, game);
    const kept = readKept();
    expect(kept?.startAway).toBe(true);
    const again = kept === null ? null : replayKept(kept, map);
    expect(again?.setup.map).toBe(map);
    expect(again?.state).toEqual(game.state);

    // Kept before the start moved: it goes on from any plains space, as it began.
    const { startAway: _away, ...older } = kept ?? { startAway: undefined };
    const before = replayKept(older as NonNullable<typeof kept>, map);
    const { start: _start, ...config } = map.ruleset.config;
    const began = new HotseatGame({ map: { ...map, ruleset: { ...map.ruleset, config } }, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    expect(before?.setup.map.ruleset.config.start).toBeUndefined();
    expect(before?.state.players.map((player) => player.position)).toEqual(began.state.players.map((player) => player.position));
    expect(before?.turns.length).toBe(1);
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
