import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '@adventure/config';
import { asNodeId, createDiceSource, createRng } from '@adventure/core';
import { turnTowards } from '@adventure/sim';
import { fixtureGame, fixtureMap, player, withStats } from '../../core/src/rules/scenario.fixture.ts';
import { computerSearchOptions, type ComputerSettings } from './computer.ts';
import { firstTurnOf } from './mcts.ts';

/**
 * [Q210] Stage 1: the computer's real move walks the best route for its
 * speeds; the games it imagines still walk the cheapest.
 *
 *   0 ── 1 ── 2 ── 3 ── 4 ── 5 (gold)    plains all the way: 5 stamina
 *   └─── 6f ── 7f ── 8f ──────┘          through the forest: 7 stamina
 */
const detour = fixtureMap({
  terrains: ['plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'forest', 'forest', 'forest'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [0, 6],
    [6, 7],
    [7, 8],
    [8, 5],
  ],
  pois: [{ node: 5, kind: 'gold', units: 3, guard: null }],
});

const one = player('one');
const n = asNodeId;
const target = { kind: 'target' as const, target: { node: n(5), cost: 5 } };

function settings(): ComputerSettings {
  let tick = 0;
  const rng = createRng('route');
  return { config: DEFAULT_GAME_CONFIG, thinkingMs: 10, rng, dice: createDiceSource(rng.fork('dice'), DEFAULT_GAME_CONFIG), now: () => tick++ };
}

describe('the route the computer walks (Q210, stage 1)', () => {
  it('walks through the forest on free steps when it has the forest speed for it', () => {
    const state = withStats(fixtureGame(detour, 0), one, { forest_move: 3 });
    expect(firstTurnOf(state, target, computerSearchOptions(state, one, settings()))).toEqual({
      kind: 'move',
      player: one,
      path: [n(6), n(7), n(8), n(5)],
      waypoint: null,
    });
  });

  it('walks the cheapest route by terrain alone with no speeds, as before', () => {
    const state = fixtureGame(detour, 0);
    expect(firstTurnOf(state, target, computerSearchOptions(state, one, settings()))).toMatchObject({
      kind: 'move',
      path: [n(1), n(2), n(3), n(4), n(5)],
    });
  });

  it('leaves the games it imagines on the cheapest route (stages 2 and 3 come later)', () => {
    const state = withStats(fixtureGame(detour, 0), one, { forest_move: 3 });
    const options = computerSearchOptions(state, one, settings());
    expect(turnTowards(state, n(5), options.restRule)).toMatchObject({ kind: 'move', path: [n(1), n(2), n(3), n(4), n(5)] });
  });
});
