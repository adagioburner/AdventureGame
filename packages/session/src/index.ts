/**
 * `@adventure/session` — multiplayer sequencing, authority and setup.
 *
 * Decoupled from hosting on purpose (§12.1): no transport, no storage engine,
 * no runtime globals. Everything it needs arrives through `SessionPorts`.
 */
export * from './ports.ts';
export { GameSession, listingOf, type SetupSessionPorts } from './session.ts';
export {
  applySetupAction,
  createSetup,
  setupLimitsFor,
  SetupError,
  startGame,
  type NewSetup,
  type SetupAction,
  type SetupLimits,
  type SetupOutcome,
} from './setup.ts';
