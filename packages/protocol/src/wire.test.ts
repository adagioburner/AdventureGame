import { describe, expect, it } from 'vitest';

import { asGameId, asNodeId, type GameState } from '@adventure/core';
import { decodeClientMessage, decodeServerMessage, encodeMessage, WireError } from './wire.ts';
import type { ServerMessage } from './messages.ts';

describe('wire', () => {
  it('brings a Map inside a message back as a Map', () => {
    const poiByNode = new Map([
      [asNodeId(4), 0],
      [asNodeId(17), 1],
    ]);
    // Only the shape the codec touches; a real GameState round-trips the same way.
    const state = { id: asGameId('g1'), map: { poiByNode, pois: [{ node: 4 }, { node: 17 }] } } as unknown as GameState;
    const message: ServerMessage = { type: 'game.state', state };

    const decoded = decodeServerMessage(encodeMessage(message));

    expect(decoded.type).toBe('game.state');
    const back = (decoded as { state: GameState }).state.map.poiByNode;
    expect(back).toBeInstanceOf(Map);
    expect([...back.entries()]).toEqual([...poiByNode.entries()]);
  });

  it('leaves an ordinary object with other keys alone', () => {
    const decoded = decodeServerMessage(JSON.stringify({ type: 'error', message: 'x', code: 'invalid_action', $map: [] }));
    expect(decoded).toEqual({ type: 'error', message: 'x', code: 'invalid_action', $map: [] });
  });

  it('accepts a client message this contract names', () => {
    expect(decodeClientMessage(encodeMessage({ type: 'turn.rest', gameId: asGameId('g1'), turn: 3 }))).toEqual({
      type: 'turn.rest',
      gameId: 'g1',
      turn: 3,
    });
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['no type', '{"gameId":"g1"}'],
    ['an unknown type', '{"type":"turn.teleport"}'],
    ['a type that is not a string', '{"type":7}'],
  ])('refuses %s', (_label, text) => {
    expect(() => decodeClientMessage(text)).toThrow(WireError);
  });
});
