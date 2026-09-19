import { DEFAULT_RULESET } from '@adventure/config';
import type { SessionPorts } from '@adventure/session';
import { createMemoryBroadcaster, createMemoryGameStore, systemClock } from './adapters/memory.ts';

/**
 * Composition root. The only place in the system where a concrete host is
 * named — everything else depends on `SessionPorts`.
 *
 * Deliberately incomplete: `maps`, `ai`, `dice`, `board` and `gmAbsence` have
 * no adapters yet. Two of those are blocked on open design items (§12.3 message
 * board retention, §12.4 GM absence) and two are blocked on the hosting
 * decision (§12.1) for where their CPU should live. Writing plausible defaults
 * for them here would bury four unanswered questions inside a wiring file.
 */
export function createSessionPorts(): Partial<SessionPorts> {
  return {
    games: createMemoryGameStore(),
    broadcaster: createMemoryBroadcaster(),
    clock: systemClock,
  };
}

export const SERVER_RULESET = DEFAULT_RULESET;
export { createMemoryBroadcaster, createMemoryGameStore, systemClock } from './adapters/memory.ts';
export { DURABLE_OBJECT_ADAPTER_STATUS } from './adapters/durable-object.ts';
