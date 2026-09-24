import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '@adventure/config';
import { applyAction, createDiceSource, createRng } from '@adventure/core';
import { rolloutCursor } from '@adventure/sim';
import { fixtureGame, fixtureMap, player } from '../../core/src/rules/scenario.fixture.ts';
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
