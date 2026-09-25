import { describe, expect, it } from 'vitest';

import { applyAction, asGameId, asNodeId, asPlayerId, asUserId, type GameAction, type GameState } from '@adventure/core';
import { openingStateOf, type GameRecord, type SetupState } from '@adventure/protocol';
import { fixtureMap, scriptedDice } from '../../../../packages/core/src/rules/scenario.fixture.ts';
import { MissedRecords, OnlineGame } from './online.ts';

/** 0(p) ── 1(p) ── 2(p) ── 3(p): 2 gold, guard 3 (fighting) */
const map = fixtureMap({
  terrains: ['plains', 'plains', 'plains', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
  ],
  pois: [{ node: 3, kind: 'gold', units: 2, guard: { type: 'fighting', strength: 3 } }],
});
const one = asPlayerId('seat-1');
const two = asPlayerId('seat-2');
const n = asNodeId;

const setup: SetupState = {
  gameId: asGameId('g'),
  name: 'g',
  gameMaster: asUserId('andrei'),
  gameMasterName: 'Andrei',
  createdAt: 0,
  phase: 'started',
  playerCount: 2,
  seats: [
    { id: 'person:andrei', seat: 1, playerId: one, userId: asUserId('andrei'), name: 'Andrei', avatarId: 'f1', control: 'human', thinkingSeconds: 10 },
    { id: 'computer:1', seat: 2, playerId: two, userId: null, name: 'Computer 1', avatarId: 'f2', control: 'ai', thinkingSeconds: 10 },
  ],
  nextSeatId: 2,
  pending: [],
  mapSeed: map.seed,
  endsAt: 1,
  closedAt: null,
};

/** Plays `actions` as the server would, with `rolls` for its dice, keeping the records. */
function serverPlays(actions: readonly GameAction[], rolls: readonly number[]): { state: GameState; records: GameRecord[] } {
  const dice = scriptedDice(rolls);
  let state = openingStateOf(setup, map);
  const records: GameRecord[] = [];
  for (const action of actions) {
    const drawn: GameRecord['rolls'][number][] = [];
    state = applyAction(state, action, { roll: () => (drawn.push(dice.roll()), drawn[drawn.length - 1]!) }).state;
    records.push({ seq: records.length + 1, action, rolls: drawn, at: records.length, by: null });
  }
  return { state, records };
}

const actions: GameAction[] = [
  { kind: 'plan', player: one, path: [n(1), n(2)], waypoint: null },
  { kind: 'force_turn', player: one },
  { kind: 'rest', player: two },
  { kind: 'move', player: one, path: [n(3)], waypoint: null },
];

describe('OnlineGame', () => {
  it('replays every record from the start to where the server is, with a turn for each turn played', () => {
    const { state, records } = serverPlays(actions, [6]);
    const { game, applied } = OnlineGame.open(setup, state, records);
    expect(game.lastSeq).toBe(4);
    expect(applied.map((step) => step.turn?.action.kind ?? null)).toEqual([null, 'move', 'rest', 'move']);
    // A forced turn is shown as the move it played.
    expect(applied[1]?.turn?.action).toEqual({ kind: 'move', player: one, path: [n(1), n(2)] });
    // The guard fight's roll is the server's.
    const fight = applied[3]?.turn?.events.find((event) => event.type === 'interacted');
    expect(fight).toMatchObject({ resolution: { roll: { value: 6 }, claimed: true } });
    expect(applied[3]?.after.players[0]?.stats.gold).toBe(state.players[0]?.stats.gold);
  });

  it('follows the next record, and refuses one that skips or repeats', () => {
    const { state, records } = serverPlays(actions, [6]);
    const { game } = OnlineGame.open(setup, serverPlays(actions.slice(0, 2), []).state, records.slice(0, 2));
    expect(() => game.apply(records[3]!)).toThrow(MissedRecords);
    expect(() => game.apply(records[1]!)).toThrow(MissedRecords);
    game.apply(records[2]!);
    const last = game.apply(records[3]!);
    expect(last.turn?.number).toBe(3);
    expect(game.state.players).toEqual(state.players);
  });
});
