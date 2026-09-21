import type { GameId, GameState, UserId } from '@adventure/core';
import type { Broadcaster, Clock, GameStore } from '@adventure/session';
import type { ServerMessage } from '@adventure/protocol';

/**
 * In-memory adapters, for local development, hotseat-on-one-process, and tests.
 *
 * These exist to prove the ports are actually sufficient: if the session layer
 * runs against these, it has no hidden dependency on a particular host — which
 * is the property §12.1 needs preserved until hosting is decided.
 */
export function createMemoryGameStore(): GameStore {
  const games = new Map<GameId, GameState>();
  return {
    load: async (gameId) => games.get(gameId) ?? null,
    save: async (state) => {
      games.set(state.id, state);
    },
  };
}

export function createMemoryBroadcaster(): Broadcaster & {
  readonly sent: readonly { target: string; message: ServerMessage }[];
} {
  const sent: { target: string; message: ServerMessage }[] = [];
  return {
    sent,
    broadcast: async (gameId: GameId, message: ServerMessage) => {
      sent.push({ target: `game:${gameId}`, message });
    },
    sendTo: async (userId: UserId, message: ServerMessage) => {
      sent.push({ target: `user:${userId}`, message });
    },
  };
}

export const systemClock: Clock = { now: () => Date.now() };
