import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mapFor } from '../page/seed.ts';
import { inOrder, toHotseatSeats, type LocalSetup } from '../setup/local.ts';
import { HotseatGame } from './hotseat.ts';
import { forgetKept, keep, readKept, replayKept } from './kept.ts';

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

  it('comes back with its purchases (Q190)', () => {
    const game = new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept-buy' });
    // Ada buys with the gold she started with (Q200).
    expect(game.state.players[0]?.stats.gold).toBe(map.ruleset.config.players.STARTING_GOLD);
    game.buy({ kind: 'buy', player: game.state.players[0]!.id, skills: ['magic'] });
    keep('adventure', setup, null, game);

    const kept = readKept();
    expect(kept?.actions.at(-1)).toEqual({ kind: 'buy', player: 'seat-1', skills: ['magic'] });
    const again = kept === null ? null : replayKept(kept, map);
    expect(again?.state).toEqual(game.state);
    expect(again?.state.players[0]?.stats.magic).toBe(1);
  });

  it('comes back on the larger map with four seats (Q160)', () => {
    const fourSeats: LocalSetup = {
      seats: [
        ...setup.seats,
        { id: 'seat-3', name: 'Cleo', avatarId: 'player_avatars_03', control: 'human', thinkingSeconds: 5 },
        { id: 'seat-4', name: 'Dov', avatarId: 'player_avatars_04', control: 'human', thinkingSeconds: 5 },
      ],
      nextId: 5,
    };
    const larger = mapFor('adventure', 'larger');
    const game = new HotseatGame({ map: larger, seats: toHotseatSeats(fourSeats), diceSeed: 'kept' });
    game.play({ kind: 'rest', player: game.state.players[0]!.id });
    keep('adventure', fourSeats, null, game);
    const kept = readKept();
    expect(kept?.setup.seats).toHaveLength(4);
    expect(kept === null ? null : replayKept(kept, larger)?.state).toEqual(game.state);
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

    // Seats that went as set keep no order.
    keep('adventure', setup, null, new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'kept' }));
    expect(readKept()?.order).toBeUndefined();
  });

  it('never reads a game kept before the old games were dropped (950 A)', () => {
    const before = { seed: 'adventure', setup, diceSeed: 'kept', actions: [], rewardsMoved: false };
    window.localStorage.setItem('adventure.hotseat', JSON.stringify(before));
    expect(readKept()).toBeNull();
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
