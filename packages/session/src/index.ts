/**
 * `@adventure/session` — multiplayer sequencing, authority and setup.
 *
 * Decoupled from hosting on purpose (§12.1): no transport, no storage engine,
 * no runtime globals. Everything it needs arrives through `SessionPorts`.
 */
export * from './ports.ts';
export { GameSession } from './session.ts';
export { SetupFlow } from './setup.ts';
