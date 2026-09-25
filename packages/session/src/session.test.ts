import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET } from '@adventure/config';
import { asGameId, asNodeId, asUserId, type GameId, type GameState, type UserId } from '@adventure/core';
import { DAY_MS, type ClientMessage, type GameRecord, type ServerMessage, type SetupState } from '@adventure/protocol';
import { fixtureMap, scriptedDice } from '../../core/src/rules/scenario.fixture.ts';
import type { GameListing, GameStore } from './ports.ts';
import { GameSession } from './session.ts';
import { setupLimitsFor } from './setup.ts';

const G = asGameId('g1');
const andrei = asUserId('andrei');
const bea = asUserId('bea');

function harness(rolls: readonly number[] = []) {
  let games: GameState | null = null;
  let setup: SetupState | null = null;
  let records: GameRecord[] = [];
  let removed = false;
  let now = 5;
  const store: GameStore = {
    load: async () => games,
    save: async (state) => {
      games = state;
    },
    loadSetup: async () => setup,
    saveSetup: async (next) => {
      setup = next;
    },
    appendRecord: async (_gameId, record) => {
      const stored = { ...record, seq: records.length + 1 };
      records.push(stored);
      return stored;
    },
    loadRecords: async () => records,
    remove: async () => {
      games = null;
      setup = null;
      records = [];
      removed = true;
    },
    isRemoved: async () => removed,
  };
  const dice = scriptedDice(rolls);
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
      clock: { now: () => now },
      dice: { forGame: async () => dice },
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
  return {
    session,
    rows,
    take,
    setup: () => setup,
    game: () => games,
    records: () => records,
    /** Replaces the stored game, as a test's starting position. */
    put: (state: GameState) => {
      games = state;
    },
    at: (time: number) => {
      now = time;
    },
  };
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
    await send(session, bea, { type: 'turn.rest', gameId: G, turn: 1 });
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
      ['all', 'game.history'],
    ]);
    expect(setup()?.phase).toBe('started');
    expect(game()?.players.map((player) => player.control)).toEqual(['human', 'ai']);
    expect(rows.get(G)?.phase).toBe('in_progress');

    // Opening a started game sends the game and what has been played.
    await session.connected(bea);
    expect(take().map(({ message }) => message.type)).toEqual(['setup.state', 'game.state', 'game.history']);
  });
});

/**
 *   0(p) ── 1(p) ── 2(p) ── 3(f): 3 gold
 *                     │
 *                     4(p): 5 gold, guard 5 (fighting)
 */
const playMap = fixtureMap({
  terrains: ['plains', 'plains', 'plains', 'forest', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [2, 4],
  ],
  pois: [
    { node: 3, kind: 'gold', units: 3, guard: null },
    { node: 4, kind: 'gold', units: 5, guard: { type: 'fighting', strength: 5 } },
  ],
});
const n = asNodeId;

/** Andrei and Bea in a started game on `playMap`, both at node 0, Andrei on turn. */
async function started(rolls: readonly number[] = [], seats: 'people' | 'computer' = 'people') {
  const h = harness(rolls);
  await h.session.create({ name: 'g', gameMaster: { userId: andrei, displayName: 'Andrei' }, mapSeed: 'fixture' });
  if (seats === 'people') {
    await send(h.session, bea, { type: 'setup.requestJoin', gameId: G, name: 'Bea', avatarId: 'f4' });
    await send(h.session, andrei, { type: 'setup.respondToJoin', gameId: G, userId: bea, accept: true });
  }
  await send(h.session, andrei, { type: 'setup.start', gameId: G });
  await send(h.session, andrei, { type: 'gm.mapGenerated', gameId: G, map: playMap });
  // Every figure on node 0, wherever the map's own start is.
  const game = h.game() as GameState;
  h.put({ ...game, players: game.players.map((player) => ({ ...player, position: n(0) })) });
  h.take();
  return h;
}

describe('GameSession in play', () => {
  it('plays a turn a person ends, records it, and sends it to everyone', async () => {
    const h = await started();
    await send(h.session, andrei, { type: 'turn.end', gameId: G, turn: 1, path: [n(1), n(2)], waypoint: null });
    const sent = h.take();
    expect(sent.map(({ to, message }) => [to, message.type])).toEqual([['all', 'game.played']]);
    expect(h.records()).toEqual([
      { seq: 1, action: { kind: 'move', player: 'seat-1', path: [1, 2], waypoint: null }, rolls: [], at: 5, by: andrei },
    ]);
    expect(h.game()?.turn).toMatchObject({ number: 2, activeSeat: 2 });
    expect(h.rows.get(G)?.turnOf).toBe(bea);
  });

  it('refuses a turn that is not the sender’s, and one already played, changing nothing', async () => {
    const h = await started();
    await send(h.session, bea, { type: 'turn.rest', gameId: G, turn: 1 });
    await send(h.session, andrei, { type: 'turn.rest', gameId: G, turn: 1 });
    await send(h.session, andrei, { type: 'turn.rest', gameId: G, turn: 1 });
    expect(h.take().map(({ to, message }) => [to, message.type === 'error' ? message.code : message.type])).toEqual([
      ['bea', 'not_your_turn'],
      ['all', 'game.played'],
      ['andrei', 'turn_over'],
    ]);
    expect(h.records()).toHaveLength(1);
  });

  it('saves a route drawn out of turn, and the game master’s Move on plays it', async () => {
    const h = await started();
    await send(h.session, bea, { type: 'turn.plan', gameId: G, path: [n(1)], waypoint: null });
    await send(h.session, andrei, { type: 'turn.rest', gameId: G, turn: 1 });
    await send(h.session, bea, { type: 'gm.forceTurn', gameId: G, player: 'seat-2' as never, turn: 2 });
    await send(h.session, andrei, { type: 'gm.forceTurn', gameId: G, player: 'seat-2' as never, turn: 2 });
    expect(h.game()?.players[1]?.position).toBe(n(1));
    expect(h.records().map((record) => [record.action.kind, record.by])).toEqual([
      ['plan', bea],
      ['rest', andrei],
      ['force_turn', andrei],
    ]);
    expect(h.take().filter(({ message }) => message.type === 'error').map(({ to, message }) => [to, message.type === 'error' && message.code])).toEqual([
      ['bea', 'not_game_master'],
    ]);
  });

  it('records the rolls the server’s dice gave a guard fight', async () => {
    const h = await started([6]);
    await send(h.session, andrei, { type: 'turn.end', gameId: G, turn: 1, path: [n(1), n(2), n(4)], waypoint: null });
    expect(h.records()[0]?.rolls).toEqual([{ value: 6, sides: 6 }]);
  });

  it('asks the game master for a computer’s move, plays the answer, and ignores a stale one', async () => {
    const h = harness();
    await h.session.create({ name: 'g', gameMaster: { userId: andrei, displayName: 'Andrei' }, mapSeed: 'fixture' });
    await send(h.session, andrei, { type: 'setup.start', gameId: G });
    await send(h.session, andrei, { type: 'gm.mapGenerated', gameId: G, map: playMap });
    h.take();
    await send(h.session, andrei, { type: 'turn.rest', gameId: G, turn: 1 });
    const asked = h.take().find(({ message }) => message.type === 'gm.requestAiMove');
    expect(asked).toMatchObject({ to: andrei, message: { requestId: 'turn-2', player: 'seat-2' } });

    // A reload asks again.
    await h.session.connected(andrei);
    expect(h.take().map(({ message }) => message.type)).toContain('gm.requestAiMove');

    const move = { type: 'gm.aiMove', gameId: G, requestId: 'turn-2', player: 'seat-2', action: { kind: 'rest', player: 'seat-2' } } as ClientMessage;
    await send(h.session, andrei, move);
    await send(h.session, andrei, move);
    expect(h.records().map((record) => record.action.kind)).toEqual(['rest', 'rest']);
    expect(h.game()?.turn.number).toBe(3);
  });

  it('lets anyone holding a seat resign, after which the computer plays it for 10 seconds a move (Q56 57)', async () => {
    const h = await started();
    await send(h.session, bea, { type: 'player.resign', gameId: G });
    expect(h.game()?.players[1]).toMatchObject({ control: 'ai', resigned: true });
    expect(h.setup()?.seats[1]).toMatchObject({ userId: bea, thinkingSeconds: 10 });
    expect(h.records().at(-1)).toMatchObject({ action: { kind: 'resign', player: 'seat-2' }, by: bea });
    // The computer's turn comes: the game master's page is asked for it.
    h.take();
    await send(h.session, andrei, { type: 'turn.rest', gameId: G, turn: 1 });
    expect(h.take().find(({ message }) => message.type === 'gm.requestAiMove')).toMatchObject({ to: andrei, message: { player: 'seat-2' } });
    // Resigned, Bea can no longer play the seat, nor resign again.
    await send(h.session, bea, { type: 'player.resign', gameId: G });
    expect(h.take().map(({ message }) => message.type === 'error' && message.message)).toEqual(['the computer plays your seat']);
  });

  it('asks the game master for the computer’s move at once when the player on turn resigns', async () => {
    const h = await started();
    h.take();
    await send(h.session, andrei, { type: 'player.resign', gameId: G });
    expect(h.take().find(({ message }) => message.type === 'gm.requestAiMove')).toMatchObject({ message: { requestId: 'turn-1', player: 'seat-1' } });
  });

  it('keeps posts on the board from anyone holding a seat, after the end too (Q56 59)', async () => {
    const h = await started();
    await send(h.session, bea, { type: 'board.post', gameId: G, body: '  good luck  ' });
    await send(h.session, asUserId('cal'), { type: 'board.post', gameId: G, body: 'hi' });
    await send(h.session, andrei, { type: 'board.post', gameId: G, body: '   ' });
    await send(h.session, andrei, { type: 'board.post', gameId: G, body: 'x'.repeat(501) });
    await send(h.session, andrei, { type: 'gm.endGame', gameId: G });
    await send(h.session, andrei, { type: 'board.post', gameId: G, body: 'x'.repeat(500) });
    expect(h.game()?.messageBoard.map((post) => [post.id, post.author, post.body.length, post.postedAt])).toEqual([
      ['post-1', 'seat-2', 9, 5],
      ['post-2', 'seat-1', 500, 5],
    ]);
    expect(h.take().filter(({ message }) => message.type === 'error').map(({ to, message }) => [to, message.type === 'error' && message.message])).toEqual([
      ['cal', 'only the players in this game can post'],
      ['andrei', 'a post needs some words'],
      ['andrei', 'a post is at most 500 characters'],
    ]);
  });

  it('lets the game master end the game, which closes it and marks the row finished', async () => {
    const h = await started();
    await send(h.session, bea, { type: 'gm.endGame', gameId: G });
    await send(h.session, andrei, { type: 'gm.endGame', gameId: G });
    expect(h.game()).toMatchObject({ status: 'finished', ending: 'game_master', winners: [] });
    expect(h.setup()?.closedAt).toBe(5);
    expect(h.rows.get(G)).toMatchObject({ phase: 'finished', result: { ending: 'game_master', winners: [] } });
  });
});

describe('GameSession lifetime (Q55)', () => {
  it('lasts 3 days from creation, which the game master can set to 1, 3, 7 or 14 before Start', async () => {
    const h = harness();
    await h.session.create({ name: 'g', gameMaster: { userId: andrei, displayName: 'Andrei' }, mapSeed: 'fixture' });
    expect(h.setup()?.endsAt).toBe(5 + 3 * DAY_MS);
    await send(h.session, andrei, { type: 'setup.setLifetime', gameId: G, days: 7 });
    expect(h.setup()?.endsAt).toBe(5 + 7 * DAY_MS);
    await send(h.session, andrei, { type: 'setup.setLifetime', gameId: G, days: 5 });
    expect(h.take().at(-1)?.message).toMatchObject({ type: 'error', code: 'invalid_action' });
    expect(await h.session.nextDeadline()).toBe(5 + 7 * DAY_MS);
  });

  it('extends a day at a time up to 14 days from creation', async () => {
    const h = harness();
    await h.session.create({ name: 'g', gameMaster: { userId: andrei, displayName: 'Andrei' }, mapSeed: 'fixture' });
    await send(h.session, andrei, { type: 'setup.setLifetime', gameId: G, days: 14 });
    await send(h.session, andrei, { type: 'gm.extendLifetime', gameId: G });
    expect(h.take().at(-1)?.message).toMatchObject({ type: 'error', code: 'invalid_action' });
    await send(h.session, andrei, { type: 'setup.setLifetime', gameId: G, days: 7 });
    await send(h.session, andrei, { type: 'gm.extendLifetime', gameId: G });
    expect(h.setup()?.endsAt).toBe(5 + 8 * DAY_MS);
    expect(h.rows.get(G)?.endsAt).toBe(5 + 8 * DAY_MS);
  });

  it('expires a game that never started, and deletes it 7 days later', async () => {
    const h = harness();
    await h.session.create({ name: 'g', gameMaster: { userId: andrei, displayName: 'Andrei' }, mapSeed: 'fixture' });
    h.at(4 * DAY_MS);
    await h.session.wake();
    expect(h.setup()).toMatchObject({ phase: 'expired', closedAt: 4 * DAY_MS });
    expect(h.rows.has(G)).toBe(false);
    expect(await h.session.nextDeadline()).toBe(11 * DAY_MS);

    h.at(11 * DAY_MS);
    await h.session.wake();
    expect(h.setup()).toBeNull();
    h.take();
    await h.session.connected(bea);
    expect(h.take()[0]?.message).toMatchObject({ type: 'error', code: 'game_removed' });
  });

  it('ends a game in progress when time runs out, the most gold winning', async () => {
    const h = await started();
    await send(h.session, andrei, { type: 'turn.end', gameId: G, turn: 1, path: [n(1), n(2), n(3)], waypoint: null });
    h.at(3 * DAY_MS + 5);
    await h.session.wake();
    expect(h.game()).toMatchObject({ status: 'finished', ending: 'time_out', winners: ['seat-1'] });
    expect(h.records().at(-1)).toMatchObject({ action: { kind: 'end_game', reason: 'time_out' }, by: null });
    expect(h.rows.get(G)).toMatchObject({ phase: 'finished', result: { ending: 'time_out', winners: ['Andrei'] } });
    expect(await h.session.nextDeadline()).toBe(3 * DAY_MS + 5 + 7 * DAY_MS);
  });
});
