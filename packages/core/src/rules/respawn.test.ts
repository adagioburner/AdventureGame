import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET } from '@adventure/config';
import type { GameEvent } from '../action.ts';
import type { GameMap } from '../gamemap.ts';
import { playerById, type GameState } from '../state.ts';
import { applyAction } from './turn.ts';
import { fixtureGame, fixtureMap, n, noDice, player, scriptedDice, withPosition, withStats } from './scenario.fixture.ts';

/**
 * [Q135] Speeds and skills come back: while fewer than 2 unclaimed POIs offer
 * one, one empty POI that held it gets its reward back, at most 2 units of it,
 * at the end of a turn, drawn from the farther half of them (rounded up) by
 * stamina cost from the nearest figure, never one a figure stands on.
 *
 *   0(p) ── 1(p) ── 2(p) ── 3(p) ── 4(p) ── 5(p) ── 6(p) ── 7(p)
 *                   │                        │       │       │
 *              1 fighting               1 fighting  3 magic  2 fighting
 *   0 ── 8(f) ── 9(f): 2 plains speed on 9, two forest steps (4 stamina) from 0
 *   0 ── 10(p) ── 11(p) ── 12(p): 1 plains speed on 12, three plains steps (3 stamina)
 *   7 ── 13(p): 5 gold, unguarded
 */
const map = fixtureMap({
  terrains: [
    'plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'plains',
    'forest', 'forest', 'plains', 'plains', 'plains', 'plains',
  ],
  edges: [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7],
    [0, 8], [8, 9],
    [0, 10], [10, 11], [11, 12],
    [7, 13],
  ],
  pois: [
    { node: 2, kind: 'fighting', units: 1, guard: null },
    { node: 5, kind: 'fighting', units: 1, guard: null },
    { node: 6, kind: 'magic', units: 3, guard: null },
    { node: 7, kind: 'fighting', units: 2, guard: null },
    { node: 9, kind: 'plains_move', units: 2, guard: null },
    { node: 12, kind: 'plains_move', units: 1, guard: null },
    { node: 13, kind: 'gold', units: 5, guard: null },
  ],
});

const one = player('one');
const two = player('two');
const rest = { kind: 'rest', player: one } as const;

/** Both figures on node 0, seat 1 to move, with the POIs on `nodes` already claimed by seat 2. */
function game(claimed: readonly number[], on: GameMap = map): GameState {
  const state = fixtureGame(on, 0);
  return {
    ...state,
    poiRuntime: state.poiRuntime.map((runtime, index) =>
      claimed.includes(on.pois[index]?.node ?? -1) ? { claimedBy: two, claimedOnTurn: 1 } : runtime,
    ),
  };
}

function returned(events: readonly GameEvent[]): { node: number; kind: string; units: number }[] {
  return events.flatMap((event) =>
    event.type === 'reward_returned' ? [{ node: event.node, kind: event.reward.kind, units: event.reward.units }] : [],
  );
}

function claimedAt(state: GameState, node: number): boolean {
  const index = state.map.poiByNode.get(n(node));
  return index !== undefined && state.poiRuntime[index]?.claimedBy !== null;
}

describe('speeds and skills coming back (Q135)', () => {
  it('leaves the map alone while every kind has 2 or more sites, or no empty site to come back to, drawing nothing', () => {
    // Fighting has three sites and plains speed two; magic has only its one
    // site on node 6 from the start, with nothing empty that could come back.
    const { state, events } = applyAction(game([]), rest, noDice);
    expect(returned(events)).toEqual([]);
    expect(state.poiRuntime).toEqual(game([]).poiRuntime);
  });

  it('brings a short kind back to the farthest empty site, with the stack it started with', () => {
    // Fighting left: node 2's site alone. Empty: 5 (5 away) and 7 (7 away);
    // the farther half of two is one, node 7, which held 2.
    const { state, events } = applyAction(game([5, 7]), rest, scriptedDice([], 6, [0]));
    expect(returned(events)).toEqual([{ node: n(7), kind: 'fighting', units: 2 }]);
    expect(claimedAt(state, 7)).toBe(false);
    expect(claimedAt(state, 5)).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['rested', 'reward_returned', 'turn_ended']);
  });

  it('picks at random from the farther half, rounded up', () => {
    // All three fighting sites empty: 7, 5 and 2 away; the farther half of
    // three is two, so a pick of 1 is the second farthest.
    const { events } = applyAction(game([2, 5, 7]), rest, scriptedDice([], 6, [1]));
    expect(returned(events)).toEqual([{ node: n(5), kind: 'fighting', units: 1 }]);
  });

  it('never brings one back where a figure stands', () => {
    const on7 = withPosition(game([5, 7]), two, 7);
    // Node 5 is the only empty site no figure is on; it is 2 from node 7, and
    // still the pick, since it is all there is.
    const { events } = applyAction(on7, rest, scriptedDice([], 6, [0]));
    expect(returned(events)).toEqual([{ node: n(5), kind: 'fighting', units: 1 }]);
  });

  it('measures far by stamina cost, not by steps', () => {
    // Plains speed is gone. Node 9 is two forest steps away (4 stamina) and
    // node 12 three plains steps (3): node 9 is the farther.
    const { events } = applyAction(game([9, 12]), rest, scriptedDice([], 6, [0]));
    expect(returned(events)).toEqual([{ node: n(9), kind: 'plains_move', units: 2 }]);
  });

  it('counts each kind on its own, one site each in the same turn', () => {
    const { events } = applyAction(game([5, 7, 9, 12]), rest, scriptedDice([], 6, [0, 0]));
    expect(returned(events)).toEqual([
      { node: n(9), kind: 'plains_move', units: 2 },
      { node: n(7), kind: 'fighting', units: 2 },
    ]);
  });

  it('counts sites, not units: one site with 2 fighting left is short', () => {
    // Node 7 still holds 2 fighting, but it is the only site that offers it.
    // Of the empty 2 and 5, node 5 is the farther.
    const { events } = applyAction(game([2, 5]), rest, scriptedDice([], 6, [0]));
    expect(returned(events)).toEqual([{ node: n(5), kind: 'fighting', units: 1 }]);
  });

  it('brings back one site a turn until 2 sites offer the kind again', () => {
    // No fighting site left at all: node 7 comes back first, still one site short.
    const first = applyAction(game([2, 5, 7]), rest, scriptedDice([], 6, [0]));
    expect(returned(first.events)).toEqual([{ node: n(7), kind: 'fighting', units: 2 }]);
    const second = applyAction(first.state, { kind: 'rest', player: two }, scriptedDice([], 6, [0]));
    expect(returned(second.events)).toEqual([{ node: n(5), kind: 'fighting', units: 1 }]);
    const third = applyAction(second.state, rest, noDice);
    expect(returned(third.events)).toEqual([]);
  });

  it('comes back after a claim in the same turn, and to the same site again later', () => {
    // Seat 1 takes node 2, the last fighting site; nodes 5 and 7 are empty, so 7 comes back.
    const walker = withStats(game([5, 7]), one, { stamina: 10 });
    const took = applyAction(walker, { kind: 'move', player: one, path: [n(1), n(2)] }, scriptedDice([], 6, [0]));
    expect(returned(took.events)).toEqual([{ node: n(7), kind: 'fighting', units: 2 }]);
    expect(took.events.map((event) => event.type)).toEqual(['moved', 'interacted', 'reward_returned', 'turn_ended']);

    // Seat 2 takes node 7 again; with the figures on 2 and 7, node 5 is the only one left.
    const back = withStats(withPosition(took.state, two, 6), two, { stamina: 10 });
    const again = applyAction(back, { kind: 'move', player: two, path: [n(7)] }, scriptedDice([], 6, [0]));
    expect(returned(again.events)).toEqual([{ node: n(5), kind: 'fighting', units: 1 }]);
  });

  it('brings nothing back once the game is won', () => {
    const rich = withStats(withPosition(game([5, 7]), one, 7), one, { stamina: 10, gold: 0 });
    const { state, events } = applyAction(rich, { kind: 'move', player: one, path: [n(13)] }, noDice);
    expect(state.status).toBe('finished');
    expect(returned(events)).toEqual([]);
  });

  it('never brings gold back', () => {
    const noGold = withPosition(game([13, 5, 7]), one, 0);
    const { events } = applyAction(noGold, rest, scriptedDice([], 6, [0]));
    expect(returned(events).map((back) => back.kind)).not.toContain('gold');
  });

  it('brings a site back with at most 2 units, and that is what it gives', () => {
    // Magic's one site, node 6, held 3.
    const first = applyAction(game([6]), rest, scriptedDice([], 6, [0]));
    expect(returned(first.events)).toEqual([{ node: n(6), kind: 'magic', units: 2 }]);

    // Seat 2 steps onto it from node 5 and takes 2 magic, not 3.
    const walker = withStats(withPosition(first.state, two, 5), two, { stamina: 10, magic: 0 });
    const took = applyAction(walker, { kind: 'move', player: two, path: [n(6)] }, noDice);
    expect(playerById(took.state, two).stats.magic).toBe(2);
    expect(claimedAt(took.state, 6)).toBe(true);

    // Taken again, it comes back with 2 again once nobody stands on it.
    const away = withPosition(took.state, two, 0);
    const again = applyAction(away, rest, scriptedDice([], 6, [0]));
    expect(returned(again.events)).toEqual([{ node: n(6), kind: 'magic', units: 2 }]);
  });

  it('brings the whole stack back in a game started before the cap', () => {
    const respawn = DEFAULT_RULESET.config.respawn;
    if (respawn === undefined) throw new Error('the default rules bring speeds and skills back');
    const { MAX_UNITS: _max, ...uncapped } = respawn;
    const before: GameMap = { ...map, ruleset: { ...DEFAULT_RULESET, config: { ...DEFAULT_RULESET.config, respawn: uncapped } } };
    const { events } = applyAction(game([6], before), rest, scriptedDice([], 6, [0]));
    expect(returned(events)).toEqual([{ node: n(6), kind: 'magic', units: 3 }]);
  });

  it('leaves a game started before the rule as it was', () => {
    const { respawn: _respawn, ...config } = DEFAULT_RULESET.config;
    const before: GameMap = { ...map, ruleset: { ...DEFAULT_RULESET, config } };
    const { events } = applyAction(game([5, 7], before), rest, noDice);
    expect(returned(events)).toEqual([]);
  });
});
