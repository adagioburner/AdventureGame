import { describe, expect, it } from 'vitest';
import { asGameId, asPlayerId, asUserId } from '@adventure/core';
import type { SetupState } from '@adventure/protocol';
import { fromOnlineSetup, inOrder, newLocalSetup, startingOrder, toHotseatSeats, toNewGameSetup, withCount, withSeat, type LocalLimits } from './local.ts';

const limits: LocalLimits = {
  playerCount: { min: 2, max: 5 },
  thinkingSeconds: { min: 1, max: 60 },
  defaultThinkingSeconds: 10,
  figures: ['fig_01', 'fig_02', 'fig_03', 'fig_04', 'fig_05', 'fig_06'],
};

const shown = (seats: readonly { name: string; avatarId: string; control: string }[]) =>
  seats.map((seat) => [seat.name, seat.avatarId, seat.control]);

describe('a game on this device (Q51)', () => {
  it('starts with two people on different figures, as the hot seat panel did (Q41)', () => {
    const setup = newLocalSetup(limits);
    expect(shown(setup.seats)).toEqual([
      ['Player 1', 'fig_01', 'human'],
      ['Player 2', 'fig_02', 'human'],
    ]);
    expect(setup.seats.map((seat) => seat.thinkingSeconds)).toEqual([10, 10]);
  });

  it('takes 2 to 5 seats: new ones are people on free figures, and fewer drop the last (21)', () => {
    const edited = withSeat(newLocalSetup(limits), 'local:2', { avatarId: 'fig_03' });
    const four = withCount(edited, 4, limits);
    expect(shown(four.seats)).toEqual([
      ['Player 1', 'fig_01', 'human'],
      ['Player 2', 'fig_03', 'human'],
      ['Player 3', 'fig_02', 'human'],
      ['Player 4', 'fig_04', 'human'],
    ]);
    expect(withCount(four, 2, limits).seats).toEqual(edited.seats);
    expect(withCount(four, 9, limits).seats).toHaveLength(5);
    expect(withCount(four, 1, limits).seats).toHaveLength(2);
    // Ids are never reused, so a seat keeps its own as others come and go.
    expect(withCount(withCount(four, 2, limits), 3, limits).seats.map((seat) => seat.id)).toEqual(['local:1', 'local:2', 'local:5']);
  });

  it('keeps a seat’s name and figure when it switches between person and computer', () => {
    const setup = withSeat(newLocalSetup(limits), 'local:2', { control: 'ai' });
    expect(shown(setup.seats)[1]).toEqual(['Player 2', 'fig_02', 'ai']);
  });

  it('starts a hot seat game with an empty name as "Player N"', () => {
    const setup = withSeat(newLocalSetup(limits), 'local:1', { name: '  ' });
    expect(toHotseatSeats(setup).map((seat) => seat.name)).toEqual(['Player 1', 'Player 2']);
  });
});

describe('turning "Play online" on and off (Q51, 25)', () => {
  it('sends seat 1’s figure for the game master, keeps computers, and opens the other Human seats', () => {
    const setup = withSeat(withSeat(withCount(newLocalSetup(limits), 3, limits), 'local:2', { control: 'ai', name: 'Robo', thinkingSeconds: 20 }), 'local:1', {
      control: 'ai',
    });
    expect(toNewGameSetup(setup, 'amber-birch-1')).toEqual({
      mapSeed: 'amber-birch-1',
      seats: [
        { control: 'human', avatarId: 'fig_01' },
        { control: 'ai', name: 'Robo', avatarId: 'fig_02', thinkingSeconds: 20 },
        { control: 'human' },
      ],
    });
  });

  it('brings a stored game’s seats back as they were, with a Human seat nobody took as "Player N" on a free figure', () => {
    const seat = (n: number, rest: Partial<SetupState['seats'][number]>) => ({
      id: `x:${n}`,
      seat: n,
      playerId: asPlayerId(`seat-${n}`),
      userId: null,
      name: '',
      avatarId: '',
      control: 'human' as const,
      thinkingSeconds: 10,
      ...rest,
    });
    const online: SetupState = {
      gameId: asGameId('g'),
      name: 'Andrei’s game',
      gameMaster: asUserId('andrei'),
      gameMasterName: 'Andrei',
      createdAt: 1,
      phase: 'cancelled',
      playerCount: 4,
      seats: [
        seat(1, { userId: asUserId('andrei'), name: 'Andrei', avatarId: 'fig_02' }),
        seat(2, {}),
        seat(3, { name: 'Robo', avatarId: 'fig_01', control: 'ai', thinkingSeconds: 30 }),
        seat(4, { userId: asUserId('bea'), name: 'Bea', avatarId: 'fig_04' }),
      ],
      nextSeatId: 5,
      pending: [],
      mapSeed: 'amber-birch-1',
      endsAt: 1 + 3 * 86_400_000,
      closedAt: 2,
    };
    const local = fromOnlineSetup(online, limits);
    expect(shown(local.seats)).toEqual([
      ['Andrei', 'fig_02', 'human'],
      ['Player 2', 'fig_03', 'human'],
      ['Robo', 'fig_01', 'ai'],
      ['Bea', 'fig_04', 'human'],
    ]);
    expect(local.seats[2]?.thinkingSeconds).toBe(30);
  });
});

describe('Shuffle seats on this device (Q165)', () => {
  const three = withCount(newLocalSetup(limits), 3, limits);

  it('keeps the seats as set while off, and draws them while on', () => {
    expect(startingOrder(three, () => 0)).toEqual(['local:1', 'local:2', 'local:3']);
    // Fisher–Yates from the last seat: 2 swaps with 0, then 1 with 0.
    const drawn = startingOrder({ ...three, shuffleSeats: true }, () => 0);
    expect(drawn).toEqual(['local:2', 'local:3', 'local:1']);
    expect(toHotseatSeats(inOrder(three, drawn)).map((seat) => seat.name)).toEqual(['Player 2', 'Player 3', 'Player 1']);
  });

  it('puts seats an order does not name after it, and none for an order of null', () => {
    expect(inOrder(three, null)).toBe(three);
    expect(inOrder(three, ['local:3', 'local:9']).seats.map((seat) => seat.id)).toEqual(['local:3', 'local:1', 'local:2']);
  });

  it('goes along when "Play online" is turned on, and comes back when it is turned off (655)', () => {
    expect(toNewGameSetup({ ...three, shuffleSeats: true }, 'seed').shuffleSeats).toBe(true);
    expect(toNewGameSetup(three, 'seed').shuffleSeats).toBeUndefined();
    const online: SetupState = {
      gameId: asGameId('g'),
      name: 'g',
      gameMaster: asUserId('andrei'),
      gameMasterName: 'Andrei',
      createdAt: 1,
      phase: 'cancelled',
      playerCount: 2,
      seats: [
        { id: 'person:andrei', seat: 1, playerId: asPlayerId('seat-1'), userId: asUserId('andrei'), name: 'Andrei', avatarId: 'fig_01', control: 'human', thinkingSeconds: 10 },
        { id: 'open:1', seat: 2, playerId: asPlayerId('seat-2'), userId: null, name: '', avatarId: '', control: 'human', thinkingSeconds: 10 },
      ],
      nextSeatId: 2,
      pending: [],
      mapSeed: 'seed',
      shuffleSeats: true,
      endsAt: 2,
      closedAt: 2,
    };
    expect(fromOnlineSetup(online, limits).shuffleSeats).toBe(true);
    expect(fromOnlineSetup({ ...online, shuffleSeats: false }, limits).shuffleSeats).toBeUndefined();
  });
});
