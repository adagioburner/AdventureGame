import { DEFAULT_RULESET } from '@adventure/config';
import type { SessionPorts } from '@adventure/session';
import { createMemoryBroadcaster, createMemoryGameStore, systemClock } from './adapters/memory.ts';

/**
 * The in-memory composition, for tests and local runs. The deployed server
 * composes the same ports from the Durable Object adapters instead, one object
 * per game (`adapters/durable-object.ts`).
 *
 * `maps`, `ai` and `dice` have no adapters yet: map generation and the AI run
 * on the game master's machine (§12.1), so those two are round trips over the
 * game's sockets and arrive with the setup flow and phase 8, and the server's
 * dice arrive with online turns in phase 7.
 */
export function createSessionPorts(): Partial<SessionPorts> {
  return {
    games: createMemoryGameStore(),
    broadcaster: createMemoryBroadcaster(),
    clock: systemClock,
  };
}

export const SERVER_RULESET = DEFAULT_RULESET;
export { createMemoryAccountStore, createMemoryBroadcaster, createMemoryGameStore, systemClock } from './adapters/memory.ts';
export { createDurableGameStore, createSocketBroadcaster, userSocketTag } from './adapters/durable-object.ts';
export { AccountError, PasswordAccounts, type AccountRules, type AccountStore } from './auth/accounts.ts';
