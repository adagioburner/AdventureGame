import type { GameId, GameState, UserId } from '@adventure/core';
import type { Broadcaster, Clock, GameStore } from '@adventure/session';
import type { ServerMessage } from '@adventure/protocol';
import type { AccountRecord, AccountStore, LoginRecord } from '../auth/accounts.ts';

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

export function createMemoryAccountStore(): AccountStore {
  const accounts = new Map<string, AccountRecord>();
  const logins = new Map<string, LoginRecord>();
  return {
    accountByKey: async (key) => accounts.get(key) ?? null,
    accountById: async (userId) => [...accounts.values()].find((account) => account.userId === userId) ?? null,
    insertAccount: async (account) => {
      if (accounts.has(account.key)) return false;
      accounts.set(account.key, account);
      return true;
    },
    insertLogin: async (login) => {
      logins.set(login.tokenHash, login);
    },
    loginByTokenHash: async (tokenHash) => logins.get(tokenHash) ?? null,
    deleteLogin: async (tokenHash) => {
      logins.delete(tokenHash);
    },
  };
}
