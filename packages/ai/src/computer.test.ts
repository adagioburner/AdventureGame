import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '@adventure/config';
import { applyAction, createDiceSource, createRng } from '@adventure/core';
import { closestByTerrainCost, rolloutCursor } from '@adventure/sim';
import { fixtureGame, fixtureMap, n, player, withStats } from '../../core/src/rules/scenario.fixture.ts';
import { chooseComputerMove, computerSearchOptions, startComputerMove, type ComputerSettings } from './computer.ts';

/** 0 ─ 1 ─ 2 ─ 3 ─ 4, all plains, gold on the far end and a skill on the way. */
const line = fixtureMap({
  terrains: ['plains', 'plains', 'plains', 'plains', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ],
  pois: [
    { node: 2, kind: 'plains_move', units: 1, guard: null },
    { node: 4, kind: 'gold', units: 3, guard: null },
  ],
});

function settings(): ComputerSettings {
  let tick = 0;
  const rng = createRng('computer');
  return {
    config: DEFAULT_GAME_CONFIG,
    thinkingMs: 100,
    rng,
    dice: createDiceSource(rng.fork('dice'), DEFAULT_GAME_CONFIG),
    now: () => tick++,
  };
}

describe('the computer player', () => {
  it('chooses a legal move for the seat whose turn it is', () => {
    const state = fixtureGame(line, 0);
    const { action, search } = chooseComputerMove(state, player('one'), settings());
    expect(action.player).toBe(player('one'));
    expect(search.iterations).toBeGreaterThan(0);
    expect(() => applyAction(state, action, createDiceSource(createRng('check'), DEFAULT_GAME_CONFIG))).not.toThrow();
  });

  it('can think a slice at a time', () => {
    const state = fixtureGame(line, 0);
    const thinking = startComputerMove(state, player('one'), settings());
    while (!thinking.step(10));
    const { action } = thinking.move();
    expect(action.player).toBe(player('one'));
    expect(() => applyAction(state, action, createDiceSource(createRng('check'), DEFAULT_GAME_CONFIG))).not.toThrow();
  });

  it('stops the games it plays in its head SIMULATION_TURN_CAP turns on (Q44)', () => {
    const state = fixtureGame(line, 0);
    const { termination } = computerSearchOptions(state, player('one'), settings());
    const cap = DEFAULT_GAME_CONFIG.ai.SIMULATION_TURN_CAP;
    const at = (turns: number) => rolloutCursor({ ...state, turn: { ...state.turn, number: state.turn.number + turns } }, player('one'));
    expect(termination.isTerminal(at(cap - 1), 0)).toBe(false);
    expect(termination.isTerminal(at(cap), 0)).toBe(true);
  });
});

/**
 * From plains node 0: a site 2 mountain steps away (node 2), and gold 5 plains
 * steps away (node 7). By weighted terrain cost the gold is nearer, 5 against 6.
 */
const fork = fixtureMap({
  terrains: ['plains', 'mountain', 'mountain', 'plains', 'plains', 'plains', 'plains', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
    [0, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 7],
  ],
  pois: [
    { node: 2, kind: 'mountain_move', units: 1, guard: null },
    { node: 7, kind: 'gold', units: 1, guard: null },
  ],
});

describe('which sites the computer counts as closest (Q112)', () => {
  const targets = (options: ReturnType<typeof computerSearchOptions>, state: ReturnType<typeof fixtureGame>) =>
    options.actions
      .enumerate(state, player('one'))
      .flatMap((branch) => (branch.kind === 'target' ? [branch.target.node] : []));

  it('ranks by its own speeds, so mountain speed brings the mountain site first', () => {
    const state = withStats(fixtureGame(fork, 0), player('one'), { mountain_move: 2 });
    const one = { ...settings().config, balancing: { ...settings().config.balancing, CLOSE_CANDIDATE_COUNT: 1 } };
    expect(targets(computerSearchOptions(state, player('one'), { ...settings(), config: one }), state)).toEqual([n(2)]);
  });

  it('ranks by weighted terrain cost alone when told to, as before', () => {
    const state = withStats(fixtureGame(fork, 0), player('one'), { mountain_move: 2 });
    const one = { ...settings().config, balancing: { ...settings().config.balancing, CLOSE_CANDIDATE_COUNT: 1 } };
    const options = computerSearchOptions(state, player('one'), { ...settings(), config: one, closest: closestByTerrainCost });
    expect(targets(options, state)).toEqual([n(7)]);
  });
});
