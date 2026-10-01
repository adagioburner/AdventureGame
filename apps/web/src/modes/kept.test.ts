import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mapFor } from '../page/seed.ts';
import { inOrder, toHotseatSeats, type LocalSetup } from '../setup/local.ts';
import { HotseatGame } from './hotseat.ts';
import { forgetKept, keep, keptMapSize, readKept, replayKept } from './kept.ts';

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

  it('keeps whether skills come back, and replays a game kept before they did by its old rules (Q135)', () => {
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' });
    keep('adventure', setup, null, game);
    const kept = readKept();
    expect(kept?.respawn).toBe(true);
    expect(kept === null ? null : replayKept(kept, map)?.setup.map.ruleset.config.respawn).toEqual(map.ruleset.config.respawn);

    const { respawn: _respawn, ...older } = kept ?? { respawn: undefined };
    const before = replayKept(older as NonNullable<typeof kept>, map);
    expect(before?.setup.map.ruleset.config.respawn).toBeUndefined();
    expect(before?.setup.map.graph).toBe(map.graph);
  });

  it('keeps the most units a site comes back with, and replays a game kept before the cap with whole stacks (Q135)', () => {
    keep('adventure', setup, null, new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' }));
    const kept = readKept();
    expect(kept?.respawnMaxUnits).toBe(1);
    expect(kept === null ? null : replayKept(kept, map)?.setup.map.ruleset.config.respawn?.MAX_UNITS).toBe(1);
    // A game kept while the cap was 2 goes on with 2.
    const underTwo = kept === null ? null : replayKept({ ...kept, respawnMaxUnits: 2 }, map);
    expect(underTwo?.setup.map.ruleset.config.respawn?.MAX_UNITS).toBe(2);

    const { respawnMaxUnits: _max, ...older } = kept ?? { respawnMaxUnits: undefined };
    const before = replayKept(older as NonNullable<typeof kept>, map)?.setup.map.ruleset.config.respawn;
    expect(before).toBeDefined();
    expect(before?.MAX_UNITS).toBeUndefined();
    expect(before?.SHORT_BELOW_SITES).toBe(map.ruleset.config.respawn?.SHORT_BELOW_SITES);
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
