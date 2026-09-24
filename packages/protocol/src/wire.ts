import type { ClientMessage, ServerMessage } from './messages.ts';

/**
 * The messages above as text, for a socket.
 *
 * Plain JSON loses one thing the contract carries: `GameMap.poiByNode` is a
 * `Map`, and `JSON.stringify` writes a `Map` as `{}`. So a `Map` travels as
 * `{"$map": [[key, value], …]}` and comes back as a `Map`. Nothing else in the
 * contract needs special handling.
 *
 * Decoding a client message is the server's first look at untrusted input, so
 * it checks only what every message has — an object with a `type` this
 * contract names — and leaves each field to the handler that uses it.
 */

const MAP_TAG = '$map';

function replacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? { [MAP_TAG]: [...value.entries()] } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const entries = (value as Record<string, unknown>)[MAP_TAG];
    if (keys.length === 1 && Array.isArray(entries)) return new Map(entries as [unknown, unknown][]);
  }
  return value;
}

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message, replacer);
}

/**
 * Every client message type, as a record so that adding a type to
 * `ClientMessage` without listing it here fails the typecheck.
 */
const CLIENT_MESSAGE_TYPE_RECORD: Record<ClientMessage['type'], true> = {
  'lobby.create': true,
  'setup.requestJoin': true,
  'setup.withdraw': true,
  'setup.leave': true,
  'setup.updateSeat': true,
  'setup.setPlayerCount': true,
  'setup.respondToJoin': true,
  'setup.setSeed': true,
  'setup.setThinkingTime': true,
  'setup.cancel': true,
  'setup.start': true,
  'turn.plan': true,
  'turn.end': true,
  'turn.rest': true,
  'gm.forceTurn': true,
  'gm.setControl': true,
  'player.resign': true,
  'board.post': true,
  'gm.mapGenerated': true,
  'gm.aiMove': true,
};
const CLIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set(Object.keys(CLIENT_MESSAGE_TYPE_RECORD));

export class WireError extends Error {
  override readonly name = 'WireError';
}

/** Parses one socket frame from a client, or throws `WireError`. */
export function decodeClientMessage(text: string): ClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(text, reviver);
  } catch {
    throw new WireError('not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WireError('not an object');
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !CLIENT_MESSAGE_TYPES.has(type)) throw new WireError(`unknown message type`);
  return value as ClientMessage;
}

/** Parses one socket frame from the server. The server is trusted. */
export function decodeServerMessage(text: string): ServerMessage {
  return JSON.parse(text, reviver) as ServerMessage;
}
