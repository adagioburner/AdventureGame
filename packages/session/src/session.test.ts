import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET } from '@adventure/config';
import { asGameId, asUserId, type GameId, type GameState, type UserId } from '@adventure/core';
import type { ClientMessage, ServerMessage, SetupState } from '@adventure/protocol';
import { fixtureMap } from '../../core/src/rules/scenario.fixture.ts';
import type { GameListing, GameStore } from './ports.ts';
import { GameSession } from './session.ts';
import { setupLimitsFor } from './setup.ts';

const G = asGameId('g1');
const andrei = asUserId('andrei');
const bea = asUserId('bea');

function harness() {
  let games: GameState | null = null;
  let setup: SetupState | null = null;
  const store: GameStore = {
    load: async () => games,
    save: async (state) => {
      games = state;
    },
    loadSetup: async () => setup,
    saveSetup: async (next) => {
      setup = next;
    },
  };
  const sent: { to: string; message: ServerMessage }[] = [];
  const rows = new Map<GameId, GameListing>();
  const session = new GameSession(
    G,
    {
      games: store,
      broadcaster: {
        broadcast: async (_gameId, message) => void sent.push({ to: 'all', message }),
        sendTo: async (userId, message) => void sent.push({ to: userId, message }),
      },
      clock: { now: () => 5 },
      directory: {
        update: async (gameId, listing) => {
          if (listing === null) rows.delete(gameId);
          else rows.set(gameId, listing);
        },
      },
    },
    setupLimitsFor(DEFAULT_RULESET, ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']),
  );
  const take = () => sent.splice(0);
  return { session, rows, take, setup: () => setup, game: () => games };
}

const send = (session: GameSession, from: UserId, message: ClientMessage) => session.handle(from, message);

describe('GameSession in setup', () => {
  it('creates the game, lists it, and sends it to whoever opens it', async () => {
    const { session, rows, take } = harness();
    await session.create({ name: 'Andrei’s game', gameMaster: { userId: andrei, displayName: 'Andrei' }, mapSeed: 'fixture' });
    expect(rows.get(G)).toMatchObject({ name: 'Andrei’s game', phase: 'setup', seatsTaken: 1, seatsTotal: 2, members: [andrei] });

    await session.connected(bea);
    expect(take().map(({ to, message }) => [to, message.type])).toEqual([['bea', 'setup.state']]);
  });

  it('broadcasts each change, tells a declined person, and keeps the list up to date', async () => {
    const { session, rows, take } = harness();
    await session.create({ name: 'g', gameMaster: { userId: andrei, displayName: 'Andrei' }, mapSeed: 'fixture' });
    await send(session, bea, { type: 'setup.requestJoin', gameId: G, name: 'Bea', avatarId: 'f4' });
    await send(session, andrei, { type: 'setup.respondToJoin', gameId: G, userId: bea, accept: false });
    expect(take().map(({ to, message }) => [to, message.type])).toEqual([
      ['all', 'setup.state'],
      ['all', 'setup.state'],
      ['bea', 'setup.declined'],
    ]);

    await send(session, bea, { type: 'setup.requestJoin', gameId: G, name: 'Bea', avatarId: 'f4' });
    await send(session, andrei, { type: 'setup.respondToJoin', gameId: G, userId: bea, accept: true });
    expect(rows.get(G)).toMatchObject({ seatsTaken: 2, members: [andrei, bea] });

    await send(session, andrei, { type: 'setup.cancel', gameId: G });
    expect(rows.has(G)).toBe(false);
  });

  it('answers a refused message to its sender alone and changes nothing', async () => {
    const { session, take, setup } = harness();
    await session.create({ name: 'g', gameMaster: { userId: andrei, displayName: 'Andrei' }, mapSeed: 'fixture' });
    const before = setup();
    await send(session, bea, { type: 'setup.setPlayerCount', gameId: G, count: 3 });
    await send(session, bea, { type: 'setup.start', gameId: asGameId('other') });
    await send(session, bea, { type: 'turn.rest', gameId: G });
    expect(take().map(({ to, message }) => [to, message.type === 'error' ? message.code : message.type])).toEqual([
      ['bea', 'not_game_master'],
      ['bea', 'game_not_found'],
      ['bea', 'invalid_action'],
    ]);
    expect(setup()).toBe(before);
  });

  it('starts in two steps: Start asks the game master’s browser for the map, and the map starts the game', async () => {
    const { session, rows, take, setup, game } = harness();
    await session.create({ name: 'g', gameMaster: { userId: andrei, displayName: 'Andrei' }, mapSeed: 'fixture' });
    await send(session, andrei, { type: 'setup.start', gameId: G });
    expect(take().map(({ to, message }) => [to, message.type])).toEqual([
      ['all', 'setup.state'],
      ['andrei', 'gm.requestMapGeneration'],
    ]);

    // A reload while starting asks again.
    await session.connected(andrei);
    expect(take().map(({ message }) => message.type)).toEqual(['setup.state', 'gm.requestMapGeneration']);

    const map = fixtureMap({ terrains: ['plains', 'plains'], edges: [[0, 1]] });
    await send(session, bea, { type: 'gm.mapGenerated', gameId: G, map });
    expect(take()[0]?.message).toMatchObject({ type: 'error', code: 'not_game_master' });

    await send(session, andrei, { type: 'gm.mapGenerated', gameId: G, map });
    expect(take().map(({ to, message }) => [to, message.type])).toEqual([
      ['all', 'setup.state'],
      ['all', 'game.state'],
    ]);
    expect(setup()?.phase).toBe('started');
    expect(game()?.players.map((player) => player.control)).toEqual(['human', 'ai']);
    expect(rows.get(G)?.phase).toBe('in_progress');

    // Opening a started game sends the game too.
    await session.connected(bea);
    expect(take().map(({ message }) => message.type)).toEqual(['setup.state', 'game.state']);
  });
});
