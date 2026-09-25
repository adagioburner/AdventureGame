import { describe, expect, it } from 'vitest';

import { applyAction, asGameId, asNodeId, asPlayerId, asUserId, type GameAction, type GameState } from '@adventure/core';
import { openingStateOf, type ClientMessage, type GameRecord, type SetupState } from '@adventure/protocol';
import { fixtureMap, scriptedDice } from '../../../../packages/core/src/rules/scenario.fixture.ts';
import { OnlineGame } from './online.ts';
import { onlinePlay, type PlayUpdate } from './play.ts';

/** 0(p) ── 1(p) ── 2(p) */
const map = fixtureMap({
  terrains: ['plains', 'plains', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
  ],
  pois: [],
});
const one = asPlayerId('seat-1');
const two = asPlayerId('seat-2');
const andrei = asUserId('andrei');
const bea = asUserId('bea');

const setup: SetupState = {
  gameId: asGameId('g'),
  name: 'g',
  gameMaster: andrei,
  gameMasterName: 'Andrei',
  createdAt: 0,
  phase: 'started',
  playerCount: 2,
  seats: [
    { id: 'person:andrei', seat: 1, playerId: one, userId: andrei, name: 'Andrei', avatarId: 'f1', control: 'human', thinkingSeconds: 10 },
    { id: 'computer:1', seat: 2, playerId: two, userId: null, name: 'Computer 1', avatarId: 'f2', control: 'ai', thinkingSeconds: 4 },
  ],
  nextSeatId: 2,
  pending: [],
  mapSeed: map.seed,
  endsAt: 1,
  closedAt: null,
};

function record(state: GameState, seq: number, action: GameAction): { record: GameRecord; after: GameState } {
  // None of these actions fights a guard, so none rolls.
  const after = applyAction(state, action, scriptedDice([])).state;
  return { record: { seq, action, rolls: [], at: seq, by: null }, after };
}

/** A page's play for `me`, with what it sent and what it heard. */
function pageFor(me: typeof andrei, connected = true) {
  const opening = openingStateOf(setup, map);
  const sent: ClientMessage[] = [];
  const heard: PlayUpdate[] = [];
  const play = onlinePlay({
    setup,
    me,
    ...OnlineGame.open(setup, opening, []),
    send: (message) => {
      if (connected) sent.push(message);
      return connected;
    },
  });
  play.subscribe((update) => heard.push(update));
  return { play, sent, heard, opening };
}

describe('onlinePlay', () => {
  it('plans for its own seat and, on the game master’s page, thinks for the computer’s', () => {
    const master = pageFor(andrei).play;
    expect([...master.localPlayers]).toEqual([one]);
    expect(master.computer).not.toBeNull();
    expect(master.thinksFor(master.state.players[1]!)).toBe(true);
    expect(master.thinksFor(master.state.players[0]!)).toBe(false);
    expect(master.thinkingSecondsOf(master.state.players[1]!)).toBe(4);
    expect(master.thinkingSecondsOf(master.state.players[0]!)).toBeNull();
    expect(master.diceSeed).toBeNull();

    const watcher = pageFor(bea).play;
    expect(watcher.localPlayers.size).toBe(0);
    expect(watcher.computer).toBeNull();
    expect(watcher.thinksFor(watcher.state.players[1]!)).toBe(false);
  });

  it('sends End turn and Rest with the turn they end, and a computer’s move as the answer to its turn', () => {
    const { play, sent, opening } = pageFor(andrei);
    play.commit({ kind: 'move', player: one, path: [asNodeId(1)], waypoint: null });
    expect(sent.at(-1)).toEqual({ type: 'turn.end', gameId: setup.gameId, turn: 1, path: [asNodeId(1)], waypoint: null });
    play.commit({ kind: 'rest', player: one });
    expect(sent.at(-1)).toEqual({ type: 'turn.rest', gameId: setup.gameId, turn: 1 });

    // Nothing changes until the server's record comes back.
    expect(play.state).toBe(opening);
    play.receive(record(opening, 1, { kind: 'rest', player: one }).record, 'played');
    play.commit({ kind: 'rest', player: two });
    expect(sent.at(-1)).toEqual({ type: 'gm.aiMove', gameId: setup.gameId, requestId: 'turn-2', player: two, action: { kind: 'rest', player: two } });
  });

  it('says so when the connection is down, and sends nothing', () => {
    const { play, sent } = pageFor(andrei, false);
    expect(() => play.commit({ kind: 'rest', player: one })).toThrow(/connection/);
    expect(sent).toEqual([]);
  });

  it('tells the screen of every record in order, how to show it, and of refusals', () => {
    const { play, heard, opening } = pageFor(bea);
    const first = record(opening, 1, { kind: 'plan', player: one, path: [asNodeId(1)], waypoint: null });
    const second = record(first.after, 2, { kind: 'rest', player: one });
    play.receive(first.record, 'played');
    play.receive(second.record, 'caught_up');
    play.refused('that turn has already been played');
    expect(heard.map((update) => (update.kind === 'change' ? [update.shown, update.change.turn?.action.kind ?? null] : [update.reason]))).toEqual([
      ['played', null],
      ['caught_up', 'rest'],
      ['that turn has already been played'],
    ]);
    expect(play.lastSeq).toBe(2);
    expect(play.state.turn.number).toBe(2);
  });
});
