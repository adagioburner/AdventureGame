import { describe, expect, it } from 'vitest';

import type { GameState } from '../state.ts';
import { applyAction } from './turn.ts';
import { checkVictory, unclaimedGoldUnits } from './victory.ts';
import { fixtureGame, fixtureMap, n, noDice, player, withStats } from './scenario.fixture.ts';

/**
 *   0(p) ── 1(p) ── 2(p)
 *
 *   1: 3 gold, unguarded.   2: 1 gold, unguarded.
 */
const map = fixtureMap({
  terrains: ['plains', 'plains', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
  ],
  pois: [
    { node: 1, kind: 'gold', units: 3, guard: null },
    { node: 2, kind: 'gold', units: 1, guard: null },
  ],
});

const one = player('one');
const two = player('two');

/** A game with the two POIs claimed as given, and the stated gold in hand. */
function scoreboard(gold: readonly number[], claimed: readonly boolean[]): GameState {
  let state = fixtureGame(map, 0);
  state.players.forEach((current, index) => {
    state = withStats(state, current.id, { gold: gold[index] ?? 0 });
  });
  return {
    ...state,
    poiRuntime: state.poiRuntime.map((runtime, index) =>
      claimed[index] === true ? { claimedBy: one, claimedOnTurn: 1 } : runtime,
    ),
  };
}

describe('unclaimedGoldUnits', () => {
  it('counts only the gold still on the map', () => {
    expect(unclaimedGoldUnits(scoreboard([0, 0], [false, false]))).toBe(4);
    expect(unclaimedGoldUnits(scoreboard([3, 0], [true, false]))).toBe(1);
    expect(unclaimedGoldUnits(scoreboard([3, 1], [true, true]))).toBe(0);
  });
});

describe('checkVictory', () => {
  it('declares a lone leader whose lead exceeds what is left', () => {
    // 3 against 0 with 1 unit still out there: 3 − 0 > 1.
    expect(checkVictory(scoreboard([3, 0], [true, false]))).toEqual([one]);
  });

  it('declares nobody while the lead could still be overturned', () => {
    // 3 against 1 with 4 out there, and the equal case: a lead of exactly the
    // unclaimed total does not win, since §1 asks for "exceeds".
    expect(checkVictory(scoreboard([3, 1], [false, false]))).toEqual([]);
    expect(checkVictory(scoreboard([4, 0], [false, false]))).toEqual([]);
  });

  it('shares the win between tied leaders once no gold remains', () => {
    expect(checkVictory(scoreboard([2, 2], [true, true]))).toEqual([one, two]);
  });

  it('declares nobody on a tie while gold is still out there', () => {
    // [SOURCE §1, chat] "players can be tied for the win only when there is no
    // more gold left on the map".
    expect(checkVictory(scoreboard([2, 2], [true, false]))).toEqual([]);
  });
});

describe('victory through applyAction', () => {
  it('ends the game the moment a claim makes the lead decisive', () => {
    const start = withStats(fixtureGame(map, 0), one, { stamina: 5 });
    const { state, events } = applyAction(start, { kind: 'move', player: one, path: [n(1)] }, noDice);

    // 3 in hand against 1 still on the map, so the last POI cannot catch up.
    expect(state.status).toBe('finished');
    expect(state.winners).toEqual([one]);
    expect(events.map((event) => event.type)).toEqual(['moved', 'interacted', 'game_won']);
    // A finished game hands over to nobody: the turn does not advance.
    expect(state.turn.activeSeat).toBe(1);
  });

  it('shares the win when the last gold leaves the map on a tie', () => {
    // Both POIs hold 1 gold, so each player takes one and neither can lead.
    const tied = fixtureMap({
      terrains: ['plains', 'plains', 'plains'],
      edges: [
        [0, 1],
        [1, 2],
      ],
      pois: [
        { node: 1, kind: 'gold', units: 1, guard: null },
        { node: 2, kind: 'gold', units: 1, guard: null },
      ],
    });
    let state = fixtureGame(tied, 0);
    state = withStats(withStats(state, one, { stamina: 5 }), two, { stamina: 5 });

    state = applyAction(state, { kind: 'move', player: one, path: [n(1)] }, noDice).state;
    expect(state.status).toBe('in_progress');
    state = applyAction(state, { kind: 'move', player: two, path: [n(1), n(2)] }, noDice).state;

    expect(state.status).toBe('finished');
    expect(state.winners).toEqual([one, two]);
  });

  it('does not re-check the win when a claim is not gold', () => {
    // Claiming a skill cannot move a lead or the unclaimed total, so §1's
    // "evaluated each time a POI with gold is claimed" is taken literally.
    const skills = fixtureMap({
      terrains: ['plains', 'plains'],
      edges: [[0, 1]],
      pois: [{ node: 1, kind: 'fighting', units: 2, guard: null }],
    });
    const start = withStats(fixtureGame(skills, 0), one, { stamina: 5 });
    const { state } = applyAction(start, { kind: 'move', player: one, path: [n(1)] }, noDice);
    // No gold was ever on this map, so every lead is 0 and nobody has won —
    // but the check is not even reached, and the game simply continues.
    expect(state.status).toBe('in_progress');
    expect(state.players[0]?.stats.fighting).toBe(2);
  });

  it('refuses to play on once the game is finished', () => {
    const start = withStats(fixtureGame(map, 0), one, { stamina: 5 });
    const finished = applyAction(start, { kind: 'move', player: one, path: [n(1)] }, noDice).state;
    expect(() => applyAction(finished, { kind: 'rest', player: one }, noDice)).toThrow();
  });
});
