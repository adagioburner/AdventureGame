import { describe, expect, it } from 'vitest';

import { asGameId, asUserId, type GameState } from '@adventure/core';
import { decodeServerMessage, type ServerMessage } from '@adventure/protocol';
import {
  createDurableGameStore,
  createSocketBroadcaster,
  userSocketTag,
  type DurableStorageLike,
  type SocketDirectory,
  type SocketLike,
} from './durable-object.ts';

function fakeStorage(): DurableStorageLike & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    // Durable Object storage structured-clones on write, and so does this.
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      data.set(key, structuredClone(value));
    },
  };
}

class FakeSocket implements SocketLike {
  readonly received: ServerMessage[] = [];
  closed = false;
  send(message: string): void {
    if (this.closed) throw new Error('closed');
    this.received.push(decodeServerMessage(message));
  }
}

function directory(tagged: readonly [FakeSocket, string[]][]): SocketDirectory {
  return {
    getWebSockets: (tag) => tagged.filter(([, tags]) => tag === undefined || tags.includes(tag)).map(([socket]) => socket),
  };
}

const G1 = asGameId('g1');
const state = (id: string): GameState =>
  ({ id: asGameId(id), map: { poiByNode: new Map([[3, 0]]) }, players: [] }) as unknown as GameState;

describe('createDurableGameStore', () => {
  it('has nothing before the first save and the saved state after it', async () => {
    const store = createDurableGameStore(G1, fakeStorage());
    expect(await store.load(G1)).toBeNull();
    await store.save(state('g1'));
    const loaded = await store.load(G1);
    expect(loaded?.id).toBe('g1');
    expect(loaded?.map.poiByNode).toBeInstanceOf(Map);
  });

  it('refuses another game, which would mean a message reached the wrong object', async () => {
    const store = createDurableGameStore(G1, fakeStorage());
    await expect(store.save(state('g2'))).rejects.toThrow(RangeError);
    expect(await store.load(asGameId('g2'))).toBeNull();
  });
});

describe('createSocketBroadcaster', () => {
  const ann = asUserId('ann');
  const bob = asUserId('bob');
  const message: ServerMessage = { type: 'error', message: 'hello', code: 'invalid_action' };

  it('broadcasts to every socket and sends to each of one user’s sockets', async () => {
    const annTab1 = new FakeSocket();
    const annTab2 = new FakeSocket();
    const bobTab = new FakeSocket();
    const broadcaster = createSocketBroadcaster(
      G1,
      directory([
        [annTab1, [userSocketTag(ann)]],
        [annTab2, [userSocketTag(ann)]],
        [bobTab, [userSocketTag(bob)]],
      ]),
    );

    await broadcaster.broadcast(G1, message);
    await broadcaster.sendTo(ann, { ...message, message: 'ann only' });

    expect(bobTab.received.map((m) => m.type === 'error' && m.message)).toEqual(['hello']);
    expect(annTab1.received.map((m) => m.type === 'error' && m.message)).toEqual(['hello', 'ann only']);
    expect(annTab2.received).toEqual(annTab1.received);
  });

  it('skips a socket that is already closing and still reaches the rest', async () => {
    const closing = new FakeSocket();
    closing.closed = true;
    const open = new FakeSocket();
    const broadcaster = createSocketBroadcaster(G1, directory([[closing, []], [open, []]]));
    await broadcaster.broadcast(G1, message);
    expect(open.received).toHaveLength(1);
  });

  it('refuses to broadcast for another game', async () => {
    const broadcaster = createSocketBroadcaster(G1, directory([]));
    await expect(broadcaster.broadcast(asGameId('g2'), message)).rejects.toThrow(RangeError);
  });
});
