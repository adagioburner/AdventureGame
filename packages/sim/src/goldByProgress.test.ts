import { describe, expect, it } from 'vitest';

import { createRng, type GameState } from '@adventure/core';
import { fixtureGame, fixtureMap, n, player } from '../../core/src/rules/scenario.fixture.ts';
import { goldByProgressPicker, sitesClaimedShare } from './goldByProgress.ts';

/**
 *   0 ─ 1 ─ 2 ─ 3 ─ 4
 *
 * Four sites of different rewards and amounts: 3 gold at node 1, 1 forest
 * speed at 2, 2 stamina at 3 and 1 plains speed at 4.
 */
const line = fixtureMap({
  terrains: ['plains', 'plains', 'plains', 'plains', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ],
  pois: [
    { node: 1, kind: 'gold', units: 3, guard: null },
    { node: 2, kind: 'forest_move', units: 1, guard: null },
    { node: 3, kind: 'stamina', units: 2, guard: null },
    { node: 4, kind: 'plains_move', units: 1, guard: null },
  ],
});

/** `state` with the sites at `nodes` claimed by seat two. */
function claimed(state: GameState, ...nodes: number[]): GameState {
  return {
    ...state,
    poiRuntime: state.poiRuntime.map((runtime, index) =>
      nodes.includes(state.map.pois[index]!.node) ? { claimedBy: player('two'), claimedOnTurn: 1 } : runtime,
    ),
  };
}

const candidates = [
  { node: n(1), cost: 1 },
  { node: n(2), cost: 2 },
  { node: n(4), cost: 4 },
];

describe('sitesClaimedShare (Q291)', () => {
  it('is 0 at the opening and 1 once every site is claimed', () => {
    const state = fixtureGame(line, 0);
    expect(sitesClaimedShare(state)).toBe(0);
    expect(sitesClaimedShare(claimed(state, 1, 2, 3, 4))).toBe(1);
  });

  it('counts every site alike, whatever its reward and amount', () => {
    const state = fixtureGame(line, 0);
    expect(sitesClaimedShare(claimed(state, 1))).toBe(0.25);
    expect(sitesClaimedShare(claimed(state, 3))).toBe(0.25);
    expect(sitesClaimedShare(claimed(state, 2, 4))).toBe(0.5);
  });
});

describe('goldByProgressPicker (Q290)', () => {
  it('picks among all the closest before anything is claimed', () => {
    const state = fixtureGame(line, 0);
    const picker = goldByProgressPicker();
    const rng = createRng('picks');
    const picked = new Set<number>();
    for (let draw = 0; draw < 50; draw++) picked.add(picker(state, state.players[0]!, candidates, rng).node);
    expect([...picked].sort((a, b) => a - b)).toEqual([n(1), n(2), n(4)]);
  });

  it('heads for gold with chance equal to the share of sites claimed', () => {
    // Three of four sites claimed: gold with chance 3/4, any of the three otherwise.
    const late = claimed(fixtureGame(line, 0), 2, 3, 4);
    const picker = goldByProgressPicker();
    const rng = createRng('picks');
    let gold = 0;
    for (let draw = 0; draw < 4000; draw++) if (picker(late, late.players[0]!, candidates, rng).node === n(1)) gold += 1;
    // 3/4 + 1/4 × 1/3 = 5/6 of the draws.
    expect(gold / 4000).toBeCloseTo(5 / 6, 1);
  });

  it('picks any of the closest when none of them is gold', () => {
    const state = claimed(fixtureGame(line, 0), 1, 3);
    const picker = goldByProgressPicker();
    const rng = createRng('picks');
    const picked = new Set<number>();
    const noGold = candidates.slice(1);
    for (let draw = 0; draw < 50; draw++) picked.add(picker(state, state.players[0]!, noGold, rng).node);
    expect([...picked].sort((a, b) => a - b)).toEqual([n(2), n(4)]);
  });
});
