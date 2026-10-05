import { describe, expect, it } from 'vitest';
import { DEFAULT_RULESET } from '@adventure/config';

import { RuleViolationError } from '../errors.ts';
import type { GameAction } from '../action.ts';
import type { GameState } from '../state.ts';
import { applyAction, applyCountedTurn, endTurnActionFor, moveOnActionFor, nextSeat } from './turn.ts';
import {
  fixtureGame,
  fixtureMap,
  n,
  noDice,
  player,
  scriptedDice,
  withPosition,
  withStats,
} from './scenario.fixture.ts';

/**
 * §8's map, with a second gold POI so that claiming the first does not decide
 * the game and the turn can be observed ending normally.
 *
 *   0(p) ── 1(p) ── 2(p) ── 3(p) ── 4(p) ── 5(f) ── 6(m)
 *                                            │        │
 *                                     3 gold, guard 5  5 gold, unguarded
 */
const map = fixtureMap({
  terrains: ['plains', 'plains', 'plains', 'plains', 'plains', 'forest', 'mountain'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
  ],
  pois: [
    { node: 5, kind: 'gold', units: 3, guard: { type: 'fighting', strength: 5 } },
    { node: 6, kind: 'gold', units: 5, guard: null },
  ],
});

const one = player('one');
const two = player('two');

/** §8's player, in seat 1. */
function workedExampleGame(): GameState {
  return withStats(fixtureGame(map, 0), one, {
    stamina: 14,
    plains_move: 3,
    forest_move: 1,
    mountain_move: 0,
    fighting: 2,
  });
}

const walkToPoi: GameAction = { kind: 'move', player: one, path: [n(1), n(2), n(3), n(4), n(5)] };

describe('applyAction — §8 worked example, end to end', () => {
  const { state, events } = applyAction(workedExampleGame(), walkToPoi, scriptedDice([4]));
  const moved = state.players[0];

  it('arrives on the POI having spent 1 stamina', () => {
    expect(moved?.position).toBe(n(5));
    expect(moved?.stats.stamina).toBe(13);
  });

  it('interacts automatically and takes the reward on 4 + 2 fighting > 5', () => {
    expect(moved?.stats.gold).toBe(3);
    expect(state.poiRuntime[0]).toEqual({ claimedBy: one, claimedOnTurn: 1 });
  });

  it('ends the turn and hands over to the next seat with a fresh allowance', () => {
    expect(state.turn.number).toBe(2);
    expect(state.turn.activeSeat).toBe(2);
    // Seat 2 has no moving skills yet, so its allowance is three zeroes.
    expect(state.turn.allowance).toEqual({ plains: 0, forest: 0, mountain: 0 });
  });

  it('reports what happened, in order', () => {
    expect(events.map((event) => event.type)).toEqual(['moved', 'interacted', 'turn_ended']);
  });

  it('leaves the state it was given untouched', () => {
    const before = workedExampleGame();
    const snapshot = JSON.stringify(before);
    applyAction(before, walkToPoi, scriptedDice([4]));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('carries the map across by reference rather than copying it', () => {
    const before = workedExampleGame();
    expect(applyAction(before, walkToPoi, scriptedDice([4])).state.map).toBe(before.map);
  });
});

describe('applyAction — movement', () => {
  it('saves the unwalked remainder as next turn’s planned path', () => {
    const start = withStats(fixtureGame(map, 0), one, { stamina: 2 });
    const { state } = applyAction(start, { kind: 'move', player: one, path: [n(1), n(2), n(3)] }, noDice);
    expect(state.players[0]?.position).toBe(n(2));
    expect(state.players[0]?.stats.stamina).toBe(0);
    expect(state.players[0]?.plannedPath).toEqual({ path: [n(3)], waypoint: null });
  });

  it('keeps the waypoint the move was planned through while it is still ahead', () => {
    const start = withStats(fixtureGame(map, 0), one, { stamina: 1 });
    const through = (waypoint: number) =>
      applyAction(start, { kind: 'move', player: one, path: [n(1), n(2), n(3)], waypoint: n(waypoint) }, noDice).state
        .players[0]?.plannedPath;
    expect(through(3)).toEqual({ path: [n(2), n(3)], waypoint: n(3) });
    // Already walked past: nothing left to route through.
    expect(through(1)).toEqual({ path: [n(2), n(3)], waypoint: null });
  });

  it('clears the planned path once the walk finishes', () => {
    const start = withStats(fixtureGame(map, 0), one, { stamina: 4 });
    const { state } = applyAction(start, { kind: 'move', player: one, path: [n(1), n(2)] }, noDice);
    expect(state.players[0]?.plannedPath).toBeNull();
  });

  it('does not interact with a POI it merely walks over', () => {
    // Node 5 holds a POI; the turn ends on node 6, so only node 6 is claimed.
    const start = withStats(fixtureGame(map, 0), one, { stamina: 12 });
    const { state, events } = applyAction(
      start,
      { kind: 'move', player: one, path: [n(1), n(2), n(3), n(4), n(5), n(6)] },
      noDice,
    );
    expect(state.players[0]?.position).toBe(n(6));
    expect(state.poiRuntime[0]?.claimedBy).toBeNull();
    expect(state.poiRuntime[1]?.claimedBy).toBe(one);
    expect(events.filter((event) => event.type === 'interacted')).toHaveLength(1);
  });

  it('lets two players stand on the same node', () => {
    // §8: "Multiple players may occupy the same node simultaneously, without
    // restriction." They start there together, and walking back onto an
    // occupied node is no different.
    const start = withStats(fixtureGame(map, 0), one, { stamina: 4 });
    const afterOne = applyAction(start, { kind: 'move', player: one, path: [n(1), n(2)] }, noDice).state;
    const withStamina = withStats(afterOne, two, { stamina: 4 });
    const afterTwo = applyAction(withStamina, { kind: 'move', player: two, path: [n(1), n(2)] }, noDice).state;
    expect(afterTwo.players[0]?.position).toBe(n(2));
    expect(afterTwo.players[1]?.position).toBe(n(2));
  });

  it('rejects a move from a player whose turn it is not', () => {
    expect(() => applyAction(fixtureGame(map, 0), { kind: 'move', player: two, path: [] }, noDice)).toThrow(
      RuleViolationError,
    );
  });
});

describe('applyAction — rest', () => {
  it('grants REST_STAMINA_GAIN and moves nothing', () => {
    const start = fixtureGame(map, 0);
    const before = start.players[0]?.stats.stamina ?? 0;
    const { state, events } = applyAction(start, { kind: 'rest', player: one }, noDice);
    expect(state.players[0]?.stats.stamina).toBe(before + map.ruleset.config.movement.REST_STAMINA_GAIN);
    expect(state.players[0]?.position).toBe(n(0));
    expect(events.map((event) => event.type)).toEqual(['rested', 'turn_ended']);
  });

  it('does not interact, even resting on an unclaimed POI', () => {
    // [SOURCE §7, chat] "Resting means taking no action, including no
    // interaction with a POI, so it is different" — this is the whole
    // difference between resting and a zero-length move.
    const onThePoi = withPosition(fixtureGame(map, 0), one, 6);
    const { state } = applyAction(onThePoi, { kind: 'rest', player: one }, noDice);
    expect(state.poiRuntime[1]?.claimedBy).toBeNull();
    expect(state.players[0]?.stats.gold).toBe(0);
  });
});

describe('applyAction — a stamina site (Q240)', () => {
  /** 0(p) ── 1(p) ── 2(p): 2 stamina units on node 1, and gold ahead so the claim decides nothing. */
  const staminaMap = fixtureMap({
    terrains: ['plains', 'plains', 'plains'],
    edges: [
      [0, 1],
      [1, 2],
    ],
    pois: [
      { node: 1, kind: 'stamina', units: 2, guard: null },
      { node: 2, kind: 'gold', units: 1, guard: null },
    ],
  });

  function staminaAfterClaiming(on: GameState): number {
    const start = withStats(on, one, { stamina: 4 });
    const { state, events } = applyAction(start, { kind: 'move', player: one, path: [n(1)] }, noDice);
    const moved = events.find((event) => event.type === 'moved');
    const spent = moved?.type === 'moved' ? moved.resolution.staminaSpent : Number.NaN;
    expect(state.poiRuntime[0]?.claimedBy).toBe(one);
    return (state.players[0]?.stats.stamina ?? 0) - (4 - spent);
  }

  it('gives STAMINA_PER_UNIT, 5 stamina, for each unit', () => {
    expect(staminaMap.ruleset.config.pois.STAMINA_PER_UNIT).toBe(5);
    expect(staminaAfterClaiming(fixtureGame(staminaMap, 0))).toBe(2 * 5);
  });
});

describe('applyAction — a guarded POI is never exhausted', () => {
  it('leaves a failed POI claimable by anyone, including the same player later', () => {
    // Roll 3 + 2 fighting = 5, which does not beat 5. Nothing is spent and
    // nothing is recorded; the POI is exactly as it was.
    const arrived = withPosition(workedExampleGame(), one, 4);
    const failed = applyAction(arrived, { kind: 'move', player: one, path: [n(5)] }, scriptedDice([3])).state;
    expect(failed.poiRuntime[0]?.claimedBy).toBeNull();
    expect(failed.players[0]?.stats.gold).toBe(0);

    // Seat 2 passes, then seat 1 stands still and attacks again — §8's
    // "remain stationed on the node", expressed as a zero-length move.
    const passed = applyAction(failed, { kind: 'rest', player: two }, noDice).state;
    const again = applyAction(passed, { kind: 'move', player: one, path: [] }, scriptedDice([4])).state;
    expect(again.poiRuntime[0]?.claimedBy).toBe(one);
    expect(again.players[0]?.stats.gold).toBe(3);
  });

  it('draws from the die stream once per guard faced, and not at all otherwise', () => {
    // A stream with one value left is exhausted by one guard and untouched by a
    // rest or by an unguarded POI, so this would throw if either drew.
    const dice = scriptedDice([2]);
    const rested = applyAction(workedExampleGame(), { kind: 'rest', player: one }, dice).state;
    const passed = applyAction(rested, { kind: 'rest', player: two }, dice).state;
    const unguarded = applyAction(
      withPosition(passed, one, 5),
      { kind: 'move', player: one, path: [n(6)] },
      dice,
    ).state;
    expect(unguarded.players[0]?.stats.gold).toBe(5);
  });
});

describe('nextSeat', () => {
  it('cycles through the seats in a fixed order', () => {
    const start = fixtureGame(map, 0, ['one', 'two', 'three']);
    expect(nextSeat(start)).toBe(2);
    expect(nextSeat({ ...start, turn: { ...start.turn, activeSeat: 3 } })).toBe(1);
  });

  it('does not skip a resigned seat — an AI plays it (§7.3)', () => {
    const start = fixtureGame(map, 0);
    const resigned = applyAction(start, { kind: 'resign', player: two }, noDice).state;
    expect(resigned.players[1]?.resigned).toBe(true);
    expect(resigned.players[1]?.control).toBe('ai');
    const afterTurnOne = applyAction(resigned, { kind: 'rest', player: one }, noDice).state;
    expect(afterTurnOne.turn.activeSeat).toBe(2);
  });
});

describe('applyAction — the out-of-turn actions', () => {
  it('forces the planned move when there is one', () => {
    const start = withStats(fixtureGame(map, 0), one, { stamina: 4 });
    const planned: GameState = {
      ...start,
      players: start.players.map((current) =>
        current.id === one ? { ...current, plannedPath: { path: [n(1), n(2)], waypoint: null } } : current,
      ),
    };
    const { state, events } = applyAction(planned, { kind: 'force_turn', player: one }, noDice);
    expect(state.players[0]?.position).toBe(n(2));
    expect(events.map((event) => event.type)).toEqual(['moved', 'turn_ended']);
  });

  it('forces a rest when nothing is planned', () => {
    const start = fixtureGame(map, 0);
    const { events } = applyAction(start, { kind: 'force_turn', player: one }, noDice);
    expect(events.map((event) => event.type)).toEqual(['rested', 'turn_ended']);
  });

  it('switches a seat between human and AI control without ending the turn', () => {
    const start = fixtureGame(map, 0);
    const { state, events } = applyAction(start, { kind: 'set_control', player: two, control: 'ai' }, noDice);
    expect(state.players[1]?.control).toBe('ai');
    expect(state.turn).toEqual(start.turn);
    expect(events.map((event) => event.type)).toEqual(['control_changed']);
  });

  it('appends a board post with the identity and time the caller stamped on it', () => {
    const start = fixtureGame(map, 0);
    const { state, events } = applyAction(
      start,
      { kind: 'post_message', player: two, body: 'good luck', id: 'post-1', postedAt: 1700000000 },
      noDice,
    );
    expect(state.messageBoard).toEqual([
      { id: 'post-1', gameId: start.id, author: two, body: 'good luck', postedAt: 1700000000 },
    ]);
    expect(events.map((event) => event.type)).toEqual(['message_posted']);
    // Posting is not a turn, so it neither ends one nor waits for one.
    expect(state.turn).toEqual(start.turn);
  });

  it('deletes a post, keeping its place, author and time, after the end too (Q85, 299)', () => {
    let state = fixtureGame(map, 0);
    for (const [id, body] of [
      ['post-1', 'good luck'],
      ['post-2', 'something rude'],
    ] as const) {
      state = applyAction(state, { kind: 'post_message', player: two, body, id, postedAt: 7 }, noDice).state;
    }
    state = applyAction(state, { kind: 'end_game', reason: 'game_master' }, noDice).state;
    const { state: after, events } = applyAction(state, { kind: 'delete_message', id: 'post-2' }, noDice);
    expect(after.messageBoard).toEqual([
      { id: 'post-1', gameId: state.id, author: two, body: 'good luck', postedAt: 7 },
      { id: 'post-2', gameId: state.id, author: two, body: '', postedAt: 7, deleted: true },
    ]);
    expect(events).toEqual([{ type: 'message_deleted', id: 'post-2' }]);
    expect(() => applyAction(after, { kind: 'delete_message', id: 'post-2' }, noDice)).toThrow(RuleViolationError);
    expect(() => applyAction(after, { kind: 'delete_message', id: 'post-3' }, noDice)).toThrow(RuleViolationError);
  });
});

describe('applyAction — a saved route (§7.1)', () => {
  it('saves the route a player draws, out of turn as well, without ending a turn', () => {
    const start = fixtureGame(map, 0);
    const { state, events } = applyAction(start, { kind: 'plan', player: two, path: [n(1), n(2)], waypoint: n(1) }, noDice);
    expect(state.players[1]?.plannedPath).toEqual({ path: [n(1), n(2)], waypoint: n(1) });
    expect(state.turn).toEqual(start.turn);
    expect(events).toEqual([{ type: 'planned', player: two, plan: { path: [n(1), n(2)], waypoint: n(1) } }]);
  });

  it('clears the route with an empty path', () => {
    const planned = applyAction(fixtureGame(map, 0), { kind: 'plan', player: one, path: [n(1)], waypoint: null }, noDice).state;
    const { state } = applyAction(planned, { kind: 'plan', player: one, path: [], waypoint: null }, noDice);
    expect(state.players[0]?.plannedPath).toBeNull();
  });

  it('is what a forced turn then walks', () => {
    const planned = applyAction(fixtureGame(map, 0), { kind: 'plan', player: one, path: [n(1), n(2)], waypoint: null }, noDice).state;
    const { state } = applyAction(planned, { kind: 'force_turn', player: one }, noDice);
    expect(state.players[0]?.position).toBe(n(2));
  });

  it('refuses a route that is not a walk from where the player stands, or a waypoint off it', () => {
    const start = fixtureGame(map, 0);
    expect(() => applyAction(start, { kind: 'plan', player: one, path: [n(2)], waypoint: null }, noDice)).toThrow(RuleViolationError);
    expect(() => applyAction(start, { kind: 'plan', player: one, path: [n(1)], waypoint: n(2) }, noDice)).toThrow(RuleViolationError);
  });
});

describe('End turn that would walk nothing (Andrei, 2026-09-30, 490 and 491)', () => {
  /** Seat 1 standing on `node` with no stamina and no speeds, so no step can be paid. */
  function stuckOn(node: number): GameState {
    return withStats(withPosition(fixtureGame(map, 0), one, node), one, { stamina: 0 });
  }
  function withSavedRoute(state: GameState, path: readonly number[]): GameState {
    return {
      ...state,
      players: state.players.map((current) => (current.id === one ? { ...current, plannedPath: { path: path.map(n), waypoint: null } } : current)),
    };
  }

  it('rests with no route away from any site', () => {
    const start = fixtureGame(map, 0);
    expect(endTurnActionFor(start, one, [], null)).toEqual({ kind: 'rest', player: one });
  });

  it('stays and fights again with no route on a guard still there', () => {
    const start = withPosition(fixtureGame(map, 0), one, 5);
    expect(endTurnActionFor(start, one, [], null)).toEqual({ kind: 'move', player: one, path: [], waypoint: null });
  });

  it('rests with no route on a site already claimed, whose guard is gone', () => {
    const start = withPosition(fixtureGame(map, 0), one, 5);
    const claimed: GameState = { ...start, poiRuntime: start.poiRuntime.map((runtime, index) => (index === 0 ? { claimedBy: two, claimedOnTurn: 1 } : runtime)) };
    expect(endTurnActionFor(claimed, one, [], null)).toEqual({ kind: 'rest', player: one });
  });

  it('rests when the first step cannot be paid, keeping the route and its waypoint for next turn', () => {
    const start = stuckOn(0);
    const action = endTurnActionFor(start, one, [n(1), n(2)], n(1));
    expect(action).toEqual({ kind: 'rest', player: one, plan: { path: [n(1), n(2)], waypoint: n(1) } });

    const { state, events } = applyAction(start, action, noDice);
    expect(events.map((event) => event.type)).toEqual(['rested', 'turn_ended']);
    expect(state.players[0]?.position).toBe(n(0));
    expect(state.players[0]?.stats.stamina).toBe(DEFAULT_RULESET.config.movement.REST_STAMINA_GAIN);
    expect(state.players[0]?.plannedPath).toEqual({ path: [n(1), n(2)], waypoint: n(1) });
  });

  it('still walks nothing and fights again when the first step cannot be paid on a guard', () => {
    const start = stuckOn(5);
    expect(endTurnActionFor(start, one, [n(4)], null)).toEqual({ kind: 'move', player: one, path: [n(4)], waypoint: null });
  });

  it('walks a route whose first step can be paid, as it always has', () => {
    const start = fixtureGame(map, 0);
    expect(endTurnActionFor(start, one, [n(1)], null)).toEqual({ kind: 'move', player: one, path: [n(1)], waypoint: null });
  });

  it('hands back a route that is no walk, and a turn that is not the player’s, for applyAction to refuse', () => {
    const start = stuckOn(0);
    const noWalk = endTurnActionFor(start, one, [n(2)], null);
    expect(noWalk.kind).toBe('move');
    expect(() => applyAction(start, noWalk, noDice)).toThrow(RuleViolationError);
    expect(endTurnActionFor(start, two, [], null).kind).toBe('move');
  });

  it('a rest that saves a route refuses one that is no walk', () => {
    expect(() => applyAction(stuckOn(0), { kind: 'rest', player: one, plan: { path: [n(2)], waypoint: null } }, noDice)).toThrow(RuleViolationError);
  });

  it('Move on rests too when the saved route’s first step cannot be paid away from a guard, keeping the route', () => {
    const start = withSavedRoute(stuckOn(0), [1, 2]);
    const action = moveOnActionFor(start, one);
    expect(action).toEqual({ kind: 'force_turn', player: one, rest: true });

    const { state, events } = applyAction(start, action, noDice);
    expect(events.map((event) => event.type)).toEqual(['rested', 'turn_ended']);
    expect(state.players[0]?.plannedPath).toEqual({ path: [n(1), n(2)], waypoint: null });
  });

  it('Move on walks a route that can be started, and rests with none, as before', () => {
    expect(moveOnActionFor(withSavedRoute(fixtureGame(map, 0), [1, 2]), one)).toEqual({ kind: 'force_turn', player: one });
    expect(moveOnActionFor(fixtureGame(map, 0), one)).toEqual({ kind: 'force_turn', player: one });
  });

  it('a Move on recorded before 490 still replays as the walk of nothing it was', () => {
    const start = withSavedRoute(stuckOn(0), [1, 2]);
    const { state, events } = applyAction(start, { kind: 'force_turn', player: one }, noDice);
    expect(events.map((event) => event.type)).toEqual(['moved', 'turn_ended']);
    expect(state.players[0]?.stats.stamina).toBe(0);
  });
});

describe('applyAction — ending a game early (Q55)', () => {
  it('gives the win to the most gold when time runs out, shared on a tie', () => {
    const rich = withStats(withStats(fixtureGame(map, 0), one, { gold: 4 }), two, { gold: 2 });
    const { state, events } = applyAction(rich, { kind: 'end_game', reason: 'time_out' }, noDice);
    expect(state).toMatchObject({ status: 'finished', winners: [one], ending: 'time_out' });
    expect(events).toEqual([{ type: 'game_ended', reason: 'time_out', winners: [one] }]);

    const tied = withStats(withStats(fixtureGame(map, 0), one, { gold: 3 }), two, { gold: 3 });
    expect(applyAction(tied, { kind: 'end_game', reason: 'time_out' }, noDice).state.winners).toEqual([one, two]);
  });

  it('gives the win to the most gold when the game master ends it too, and nothing can be played after (Q85, 291)', () => {
    const rich = withStats(withStats(fixtureGame(map, 0), one, { gold: 2 }), two, { gold: 4 });
    const { state, events } = applyAction(rich, { kind: 'end_game', reason: 'game_master' }, noDice);
    expect(state).toMatchObject({ status: 'finished', winners: [two], ending: 'game_master' });
    expect(events).toEqual([{ type: 'game_ended', reason: 'game_master', winners: [two] }]);
    expect(() => applyAction(state, { kind: 'rest', player: one }, noDice)).toThrow(RuleViolationError);

    const tied = withStats(withStats(fixtureGame(map, 0), one, { gold: 3 }), two, { gold: 3 });
    expect(applyAction(tied, { kind: 'end_game', reason: 'game_master' }, noDice).state.winners).toEqual([one, two]);
  });

  it('records a §1 win as won, and a game in progress as not ended', () => {
    // 5 gold against 0, with 3 left on the map.
    const start = withPosition(withStats(fixtureGame(map, 0), one, { stamina: 30 }), one, 5);
    expect(start.ending).toBeNull();
    const { state } = applyAction(start, { kind: 'move', player: one, path: [n(6)] }, noDice);
    expect(state).toMatchObject({ status: 'finished', winners: [one], ending: 'won' });
  });
});

describe('applyCountedTurn (Q210, stage 3: a turn of a game the computer imagines)', () => {
  /** What a turn leaves on the board, which imagined games read: not the log or the saved route. */
  const board = (state: GameState) => ({
    players: state.players.map((seat) => ({ position: seat.position, stats: seat.stats })),
    poiRuntime: state.poiRuntime,
    turn: state.turn,
    status: state.status,
    winners: state.winners,
  });

  it('rests as applyAction does', () => {
    const start = withPosition(fixtureGame(map, 0), one, 6);
    expect(board(applyCountedTurn(start, { kind: 'rest' }, noDice))).toEqual(board(applyAction(start, { kind: 'rest', player: one }, noDice).state));
  });

  it('ends a walk short of anything as applyAction does', () => {
    const start = workedExampleGame();
    const counted = applyCountedTurn(start, { kind: 'walk', to: n(4), staminaSpent: 1 }, noDice);
    expect(board(counted)).toEqual(board(applyAction(start, { kind: 'move', player: one, path: [n(1), n(2), n(3), n(4)] }, noDice).state));
    expect(counted.players[0]?.stats.stamina).toBe(13);
    expect(counted.turn.activeSeat).toBe(2);
  });

  it('fights the guard where a walk ends, with the same roll, as applyAction does', () => {
    for (const roll of [3, 4]) {
      const counted = applyCountedTurn(workedExampleGame(), { kind: 'walk', to: n(5), staminaSpent: 1 }, scriptedDice([roll]));
      const played = applyAction(workedExampleGame(), walkToPoi, scriptedDice([roll])).state;
      expect(board(counted)).toEqual(board(played));
    }
  });

  it('takes the gold where a walk ends and checks for a win, as applyAction does', () => {
    const start = withPosition(withStats(fixtureGame(map, 0), one, { stamina: 3 }), one, 5);
    const counted = applyCountedTurn(start, { kind: 'walk', to: n(6), staminaSpent: 3 }, noDice);
    expect(board(counted)).toEqual(board(applyAction(start, { kind: 'move', player: one, path: [n(6)] }, noDice).state));
    expect(counted.status).toBe('finished');
    expect(counted.winners).toEqual([one]);
  });

  it('fights again on the spot for a walk of no steps, the empty move', () => {
    const failed = withPosition(workedExampleGame(), one, 5);
    const counted = applyCountedTurn(failed, { kind: 'walk', to: n(5), staminaSpent: 0 }, scriptedDice([4]));
    expect(board(counted)).toEqual(board(applyAction(failed, { kind: 'move', player: one, path: [] }, scriptedDice([4])).state));
    expect(counted.poiRuntime[0]?.claimedBy).toBe(one);
  });
});
