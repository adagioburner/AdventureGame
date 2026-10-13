import type { Clock } from '@adventure/session';
import type { AccountRecord, AccountStore, LoginRecord } from '../auth/accounts.ts';

/** The clock the server runs on: `Date.now()`. */
export const systemClock: Clock = { now: () => Date.now() };

/** An account store kept in memory, for tests. */
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
