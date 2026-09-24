import { describe, expect, it } from 'vitest';

import { asGameId, asUserId } from '@adventure/core';
import type { GameListing } from '@adventure/session';
import { gameListFor } from './games.ts';

const andrei = asUserId('andrei');
const bea = asUserId('bea');

const listing = (id: string, over: Partial<GameListing>): GameListing => ({
  gameId: asGameId(id),
  name: id,
  gameMaster: andrei,
  gameMasterName: 'Andrei',
  phase: 'setup',
  seatsTaken: 1,
  seatsTotal: 2,
  createdAt: 0,
  members: [andrei],
  ...over,
});

describe('gameListFor (Q48, 5)', () => {
  const listings = [
    listing('open-old', { createdAt: 1 }),
    listing('open-new', { createdAt: 5 }),
    listing('full', { seatsTaken: 2, members: [andrei, asUserId('cal')], createdAt: 3 }),
    listing('started-without-bea', { phase: 'in_progress', createdAt: 4 }),
    listing('bea-waiting', { members: [andrei, bea], seatsTaken: 2, seatsTotal: 3, createdAt: 2 }),
    listing('bea-started', { phase: 'in_progress', members: [andrei, bea], seatsTaken: 2, createdAt: 6 }),
  ];

  it('lists your games first, waiting or started, then open games with a free seat, newest first', () => {
    expect(gameListFor(bea, listings).map((row) => [row.gameId, row.mine])).toEqual([
      ['bea-started', true],
      ['bea-waiting', true],
      ['open-new', false],
      ['open-old', false],
    ]);
  });

  it('shows a game master all of their own games', () => {
    expect(gameListFor(andrei, listings).every((row) => row.mine)).toBe(true);
    expect(gameListFor(andrei, listings)).toHaveLength(6);
  });

  it('carries the row as the list shows it', () => {
    expect(gameListFor(bea, listings)[2]).toEqual({
      gameId: 'open-new',
      name: 'open-new',
      gameMaster: andrei,
      gameMasterName: 'Andrei',
      phase: 'setup',
      seatsTaken: 1,
      seatsTotal: 2,
      createdAt: 5,
      mine: false,
    });
  });
});
