import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_startWorker } from 'wrangler';

import { DEFAULT_RULESET } from '@adventure/config';
import { generateMap } from '@adventure/mapgen';
import {
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type LoginResponse,
  type ServerMessage,
  type SetupState,
} from '@adventure/protocol';
import { defaultRemotenessScorer } from '@adventure/sim';

/**
 * The whole server in Cloudflare's own local runtime (workerd, through
 * wrangler): accounts over HTTP, the game list and a game over real sockets,
 * and the Durable Objects' own storage. Everything a person does on the site
 * up to the start of a game, played by two users.
 */

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '../../web/dist-site');

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let base: URL;

beforeAll(async () => {
  // The Worker serves the built site; a stub stands in when it has not been built.
  if (!existsSync(resolve(site, 'index.html'))) {
    mkdirSync(site, { recursive: true });
    writeFileSync(resolve(site, 'index.html'), '<!doctype html><title>stub</title>');
  }
  worker = await unstable_startWorker({
    config: resolve(here, '../wrangler.jsonc'),
    dev: { server: { port: 0 }, inspector: false, persist: false },
  });
  base = await worker.url;
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
});

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
}

async function register(username: string): Promise<LoginResponse> {
  const response = await post('/api/register', { username, password: 'password1' });
  expect(response.status).toBe(200);
  return (await response.json()) as LoginResponse;
}

/** A socket that keeps what it hears, so a test can wait for a message. */
class Client {
  readonly heard: ServerMessage[] = [];
  private readonly waiters: (() => void)[] = [];
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      this.heard.push(decodeServerMessage(String(event.data)));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static async open(path: string, token: string): Promise<Client> {
    const url = new URL(path, base);
    url.protocol = 'ws:';
    url.searchParams.set('token', token);
    const socket = new WebSocket(url);
    await new Promise<void>((done, fail) => {
      socket.addEventListener('open', () => done());
      socket.addEventListener('error', () => fail(new Error(`could not open ${path}`)));
    });
    return new Client(socket);
  }

  send(message: ClientMessage): void {
    this.socket.send(encodeMessage(message));
  }

  /** The first message after `from` that `match` accepts. */
  async next<T extends ServerMessage>(match: (message: ServerMessage) => message is T, from = 0): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = this.heard.slice(from).find(match);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`waited in vain; heard ${this.heard.map((m) => m.type).join(', ')}`);
      await new Promise<void>((wake) => {
        this.waiters.push(wake);
        setTimeout(wake, 200);
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}

const isSetup =
  (check: (setup: SetupState) => boolean) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: 'setup.state' }> =>
    message.type === 'setup.state' && check(message.setup);

describe('the server, in the local Workers runtime', () => {
  it('registers, logs in and out, and refuses what the account rules refuse', async () => {
    const andrei = await register('Andrei');
    expect(andrei.user.displayName).toBe('Andrei');

    const me = await fetch(new URL('/api/me', base), { headers: { Authorization: `Bearer ${andrei.token}` } });
    expect(await me.json()).toEqual(andrei.user);

    const taken = await post('/api/register', { username: 'andrei', password: 'password2' });
    expect(taken.status).toBe(400);
    expect(await taken.json()).toMatchObject({ reason: 'username_taken' });
    expect((await post('/api/register', { username: 'ok_name', password: 'short' })).status).toBe(400);
    expect((await post('/api/register', { username: 'no', password: 'password1' })).status).toBe(400);

    const login = await post('/api/login', { username: 'ANDREI', password: 'password1' });
    expect(login.status).toBe(200);
    const again = (await login.json()) as LoginResponse;
    expect((await post('/api/login', { username: 'Andrei', password: 'wrong-one' })).status).toBe(401);

    expect((await post('/api/logout', {}, again.token)).status).toBe(204);
    const after = await fetch(new URL('/api/me', base), { headers: { Authorization: `Bearer ${again.token}` } });
    expect(after.status).toBe(401);
  });

  it('refuses a socket without a login, or with a made-up one', async () => {
    await expect(Client.open('/api/lobby', '')).rejects.toThrow(/could not open/);
    await expect(Client.open('/api/lobby', 'made-up')).rejects.toThrow(/could not open/);
    const plain = await fetch(new URL('/api/lobby', base));
    expect(plain.status).toBe(426);
  });

  it('creates a game, lets another user join it, and starts it with a computer in the empty seat', async () => {
    const gm = await register('Gamemaster');
    const bea = await register('Bea');

    const gmList = await Client.open('/api/lobby', gm.token);
    const beaList = await Client.open('/api/lobby', bea.token);
    await gmList.next((m): m is ServerMessage => m.type === 'lobby.games');

    gmList.send({ type: 'lobby.create', name: 'Friday game' });
    const created = await gmList.next((m): m is Extract<ServerMessage, { type: 'lobby.created' }> => m.type === 'lobby.created');
    const gameId = created.gameId;

    // Bea's list shows it as open, with a free seat.
    const listed = await beaList.next(
      (m): m is Extract<ServerMessage, { type: 'lobby.games' }> =>
        m.type === 'lobby.games' && m.games.some((game) => game.gameId === gameId),
    );
    expect(listed.games.find((game) => game.gameId === gameId)).toMatchObject({
      name: 'Friday game',
      gameMasterName: 'Gamemaster',
      seatsTaken: 1,
      seatsTotal: 2,
      mine: false,
    });

    const gmGame = await Client.open(`/api/games/${gameId}`, gm.token);
    const beaGame = await Client.open(`/api/games/${gameId}`, bea.token);
    await beaGame.next(isSetup(() => true));

    gmGame.send({ type: 'setup.setPlayerCount', gameId, count: 3 });
    beaGame.send({ type: 'setup.requestJoin', gameId, name: 'Bea', avatarId: 'player_avatars_04' });
    await gmGame.next(isSetup((setup) => setup.pending.length === 1 && setup.playerCount === 3));
    gmGame.send({ type: 'setup.respondToJoin', gameId, userId: bea.user.userId, accept: true });
    const joined = await beaGame.next(isSetup((setup) => setup.seats[1]?.userId === bea.user.userId));
    expect(joined.setup.seats.map((seat) => [seat.name, seat.control])).toEqual([
      ['Gamemaster', 'human'],
      ['Bea', 'human'],
      ['', 'human'],
    ]);
    await beaList.next(
      (m): m is ServerMessage => m.type === 'lobby.games' && m.games.some((game) => game.gameId === gameId && game.mine),
    );

    // Start: the server asks the game master's browser for the map.
    const mark = gmGame.heard.length;
    gmGame.send({ type: 'setup.start', gameId });
    const request = await gmGame.next(
      (m): m is Extract<ServerMessage, { type: 'gm.requestMapGeneration' }> => m.type === 'gm.requestMapGeneration',
      mark,
    );
    const map = generateMap({ seed: request.seed, ruleset: DEFAULT_RULESET, remotenessScorer: defaultRemotenessScorer });
    gmGame.send({ type: 'gm.mapGenerated', gameId, map });

    const started = await beaGame.next((m): m is Extract<ServerMessage, { type: 'game.state' }> => m.type === 'game.state');
    expect(started.state.players.map((player) => [player.name, player.control, player.stats.stamina])).toEqual([
      ['Gamemaster', 'human', 30],
      ['Bea', 'human', 40],
      ['Computer 1', 'ai', 50],
    ]);
    expect(started.state.map.poiByNode).toBeInstanceOf(Map);
    expect(started.state.map.pois.length).toBe(map.pois.length);

    // Opening it again, as after a reload, sends the started game.
    const reopened = await Client.open(`/api/games/${gameId}`, bea.token);
    await reopened.next((m): m is ServerMessage => m.type === 'game.state');

    for (const client of [gmList, beaList, gmGame, beaGame, reopened]) client.close();
  }, 60_000);

  it('creates a game from the setup a page already had, and lists its new name (Q51)', async () => {
    const gm = await register('Online_gm');
    const lobby = await Client.open('/api/lobby', gm.token);
    await lobby.next((m): m is ServerMessage => m.type === 'lobby.games');
    lobby.send({
      type: 'lobby.create',
      name: 'Online_gm’s game',
      setup: {
        mapSeed: 'amber-birch-1',
        seats: [
          { control: 'human', avatarId: 'player_avatars_03' },
          { control: 'ai', name: 'Robo', avatarId: 'player_avatars_01', thinkingSeconds: 20 },
          { control: 'human' },
        ],
      },
    });
    const { gameId } = await lobby.next((m): m is Extract<ServerMessage, { type: 'lobby.created' }> => m.type === 'lobby.created');
    const gmGame = await Client.open(`/api/games/${gameId}`, gm.token);
    const first = await gmGame.next(isSetup(() => true));
    expect(first.setup.mapSeed).toBe('amber-birch-1');
    expect(first.setup.seats.map((seat) => [seat.id, seat.name, seat.avatarId, seat.control, seat.thinkingSeconds])).toEqual([
      [`person:${gm.user.userId}`, 'Online_gm', 'player_avatars_03', 'human', 10],
      ['computer:1', 'Robo', 'player_avatars_01', 'ai', 20],
      ['open:2', '', '', 'human', 10],
    ]);

    gmGame.send({ type: 'setup.rename', gameId, name: 'Friday game' });
    gmGame.send({ type: 'setup.setThinkingTime', gameId, seatId: 'computer:1', seconds: 30 });
    const changed = await gmGame.next(isSetup((setup) => setup.seats[1]?.thinkingSeconds === 30));
    expect(changed.setup.name).toBe('Friday game');
    const listed = await lobby.next(
      (m): m is Extract<ServerMessage, { type: 'lobby.games' }> =>
        m.type === 'lobby.games' && m.games.some((game) => game.gameId === gameId && game.name === 'Friday game'),
    );
    // Seats for people: the game master's and the open Human seat.
    expect(listed.games.find((game) => game.gameId === gameId)).toMatchObject({ seatsTaken: 1, seatsTotal: 2 });

    for (const client of [lobby, gmGame]) client.close();
  }, 60_000);

  it('settles two people reaching for one figure at once: one gets it, the other is told who has it (Q49)', async () => {
    const gm = await register('Race_gm');
    const ann = await register('Race_ann');
    const bo = await register('Race_bo');
    const lobby = await Client.open('/api/lobby', gm.token);
    lobby.send({ type: 'lobby.create', name: 'Race' });
    const { gameId } = await lobby.next((m): m is Extract<ServerMessage, { type: 'lobby.created' }> => m.type === 'lobby.created');
    const gmGame = await Client.open(`/api/games/${gameId}`, gm.token);
    const annGame = await Client.open(`/api/games/${gameId}`, ann.token);
    const boGame = await Client.open(`/api/games/${gameId}`, bo.token);
    gmGame.send({ type: 'setup.setPlayerCount', gameId, count: 3 });
    annGame.send({ type: 'setup.requestJoin', gameId, name: 'Ann', avatarId: 'player_avatars_03' });
    boGame.send({ type: 'setup.requestJoin', gameId, name: 'Bo', avatarId: 'player_avatars_04' });
    await gmGame.next(isSetup((setup) => setup.pending.length === 2 && setup.playerCount === 3));
    gmGame.send({ type: 'setup.respondToJoin', gameId, userId: ann.user.userId, accept: true });
    gmGame.send({ type: 'setup.respondToJoin', gameId, userId: bo.user.userId, accept: true });
    await annGame.next(isSetup((setup) => setup.seats.filter((seat) => seat.userId !== null).length === 3));
    await boGame.next(isSetup((setup) => setup.seats.filter((seat) => seat.userId !== null).length === 3));

    const marks = { ann: annGame.heard.length, bo: boGame.heard.length };
    const figure = 'player_avatars_05';
    annGame.send({ type: 'setup.updateSeat', gameId, seatId: `person:${ann.user.userId}`, name: 'Ann', avatarId: figure });
    boGame.send({ type: 'setup.updateSeat', gameId, seatId: `person:${bo.user.userId}`, name: 'Bo', avatarId: figure });

    const settled = await gmGame.next(isSetup((setup) => setup.seats.some((seat) => seat.avatarId === figure)));
    const winner = settled.setup.seats.find((seat) => seat.avatarId === figure);
    const [loser, mark] = winner?.userId === ann.user.userId ? [boGame, marks.bo] : [annGame, marks.ann];
    const told = await loser.next((m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error', mark);
    expect(told.message).toBe(`${winner?.name} holds that figure now; pick another`);
    const figures = settled.setup.seats.map((seat) => seat.avatarId);
    expect(new Set(figures).size).toBe(figures.length);

    for (const client of [lobby, gmGame, annGame, boGame]) client.close();
  }, 60_000);

  it('plays online: turns, a route saved out of turn, a computer’s move from the game master, and every turn on reopening', async () => {
    const gm = await register('Play_gm');
    const bea = await register('Play_bea');
    const gmList = await Client.open('/api/lobby', gm.token);
    gmList.send({ type: 'lobby.create', name: 'Play' });
    const { gameId } = await gmList.next((m): m is Extract<ServerMessage, { type: 'lobby.created' }> => m.type === 'lobby.created');
    const gmGame = await Client.open(`/api/games/${gameId}`, gm.token);
    const beaGame = await Client.open(`/api/games/${gameId}`, bea.token);
    gmGame.send({ type: 'setup.setPlayerCount', gameId, count: 3 });
    beaGame.send({ type: 'setup.requestJoin', gameId, name: 'Bea', avatarId: 'player_avatars_04' });
    await gmGame.next(isSetup((setup) => setup.pending.length === 1 && setup.playerCount === 3));
    gmGame.send({ type: 'setup.respondToJoin', gameId, userId: bea.user.userId, accept: true });
    await gmGame.next(isSetup((setup) => setup.seats[1]?.userId === bea.user.userId));
    gmGame.send({ type: 'setup.start', gameId });
    const request = await gmGame.next((m): m is Extract<ServerMessage, { type: 'gm.requestMapGeneration' }> => m.type === 'gm.requestMapGeneration');
    const map = generateMap({ seed: request.seed, ruleset: DEFAULT_RULESET, remotenessScorer: defaultRemotenessScorer });
    gmGame.send({ type: 'gm.mapGenerated', gameId, map });
    const { state } = await beaGame.next((m): m is Extract<ServerMessage, { type: 'game.state' }> => m.type === 'game.state');

    type Played = Extract<ServerMessage, { type: 'game.played' }>;
    const played = (seq: number) => (m: ServerMessage): m is Played => m.type === 'game.played' && m.record.seq === seq;

    // [Q54, 31] Both have the game open: nobody is away.
    const presence = await beaGame.next((m): m is Extract<ServerMessage, { type: 'game.presence' }> => m.type === 'game.presence');
    expect(presence.away).toEqual([]);

    gmGame.send({ type: 'turn.rest', gameId, turn: 1 });
    expect((await beaGame.next(played(1))).record).toMatchObject({ action: { kind: 'rest' }, by: gm.user.userId, rolls: [] });

    // Bea saves a route, then ends her turn with it; a second End turn for the same turn is refused.
    const start = state.players[1]?.position ?? 0;
    const step = map.graph.adjacency[start]?.[0];
    expect(step).toBeDefined();
    beaGame.send({ type: 'turn.plan', gameId, path: [step as never], waypoint: null });
    await gmGame.next(played(2));
    beaGame.send({ type: 'turn.end', gameId, turn: 2, path: [step as never], waypoint: null });
    beaGame.send({ type: 'turn.end', gameId, turn: 2, path: [step as never], waypoint: null });
    await gmGame.next(played(3));
    const refused = await beaGame.next((m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error');
    expect(refused.code).toBe('turn_over');

    // The computer's turn: the server asks the game master's page for the move.
    const ask = await gmGame.next((m): m is Extract<ServerMessage, { type: 'gm.requestAiMove' }> => m.type === 'gm.requestAiMove');
    expect(ask).toMatchObject({ requestId: 'turn-3', player: 'seat-3' });
    gmGame.send({ type: 'gm.aiMove', gameId, requestId: ask.requestId, player: ask.player, action: { kind: 'rest', player: ask.player } });
    await beaGame.next(played(4));

    // [Q54, 34] The game master's list says it is their turn.
    await gmList.next(
      (m): m is ServerMessage => m.type === 'lobby.games' && m.games.some((game) => game.gameId === gameId && game.yourTurn),
    );

    // [Q54, 32] Reopening sends every turn played.
    const again = await Client.open(`/api/games/${gameId}`, bea.token);
    const history = await again.next((m): m is Extract<ServerMessage, { type: 'game.history' }> => m.type === 'game.history');
    expect(history.records.map((record) => [record.seq, record.action.kind])).toEqual([
      [1, 'rest'],
      [2, 'plan'],
      [3, 'move'],
      [4, 'rest'],
    ]);

    // [Q54, 31] Closing every page of hers makes Bea away at once.
    const mark = gmGame.heard.length;
    beaGame.close();
    again.close();
    const away = await gmGame.next(
      (m): m is Extract<ServerMessage, { type: 'game.presence' }> => m.type === 'game.presence' && m.away.length > 0,
      mark,
    );
    expect(away.away).toEqual([bea.user.userId]);

    // [Q55, 40] The game master ends it; it stays in the list as finished.
    gmGame.send({ type: 'gm.endGame', gameId });
    const ended = await gmGame.next(played(5));
    expect(ended.record.action).toEqual({ kind: 'end_game', reason: 'game_master' });
    const listed = await gmList.next(
      (m): m is Extract<ServerMessage, { type: 'lobby.games' }> =>
        m.type === 'lobby.games' && m.games.some((game) => game.gameId === gameId && game.phase === 'finished'),
    );
    expect(listed.games.find((game) => game.gameId === gameId)?.result).toEqual({ ending: 'game_master', winners: [] });

    for (const client of [gmList, gmGame]) client.close();
  }, 60_000);

  it('answers a game that does not exist', async () => {
    const who = await register('Nobody_here');
    const client = await Client.open('/api/games/doesnotexist', who.token);
    const error = await client.next((m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error');
    expect(error.code).toBe('game_not_found');
    client.close();
  });
});
