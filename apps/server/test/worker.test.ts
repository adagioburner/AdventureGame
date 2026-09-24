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
      ['Computer 1', 'ai'],
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

  it('answers a game that does not exist', async () => {
    const who = await register('Nobody_here');
    const client = await Client.open('/api/games/doesnotexist', who.token);
    const error = await client.next((m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error');
    expect(error.code).toBe('game_not_found');
    client.close();
  });
});
