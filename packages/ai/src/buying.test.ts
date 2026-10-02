import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '@adventure/config';
import { activePlayer, applyAction, createDiceSource, createRng, playerById, type GameState } from '@adventure/core';
import { fixtureGame, fixtureMap, player, withStats } from '../../core/src/rules/scenario.fixture.ts';
import { computerSearchOptions, type ComputerSettings } from './computer.ts';
import { planTurn, searchTree, type SearchResult } from './mcts.ts';
import { buyBranches } from './policies/tree.ts';
import type { MctsBranch, MctsNode, NodeEvaluator } from './types.ts';

/**
 * [Q190] The computer buys a speed or skill for gold, 1 to 1, but not one a
 * site offers within this turn's reach plus 5 stamina (759 B).
 *
 *   0(p) ── 1(p) ── 2(f) ── 3(m) ── 4(p)
 *           combat  forest  magic   gold 3
 *                   speed
 *
 * From 0 with no speeds, combat costs 1 stamina to reach, forest speed 1 + 2,
 * magic 1 + 2 + 3.
 */
const ridge = fixtureMap({
  terrains: ['plains', 'plains', 'forest', 'mountain', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ],
  pois: [
    { node: 1, kind: 'fighting', units: 1, guard: null },
    { node: 2, kind: 'forest_move', units: 1, guard: null },
    { node: 3, kind: 'magic', units: 1, guard: null },
    { node: 4, kind: 'gold', units: 3, guard: null },
  ],
});

const one = player('one');

function settings(thinkingMs = 100): ComputerSettings {
  let tick = 0;
  const rng = createRng('computer');
  return { config: DEFAULT_GAME_CONFIG, thinkingMs, rng, dice: createDiceSource(rng.fork('dice'), DEFAULT_GAME_CONFIG), now: () => tick++ };
}

function bought(state: GameState): readonly string[] {
  return buyBranches(state, playerById(state, one), DEFAULT_GAME_CONFIG).flatMap((branch) => (branch.kind === 'buy' ? [branch.skill] : []));
}

describe('which purchases the computer weighs (Q190, 759)', () => {
  it('skips a kind a site offers within 5 stamina beyond its free steps', () => {
    const state = withStats(fixtureGame(ridge, 0), one, { gold: 2 });
    expect(bought(state)).toEqual(['plains_move', 'mountain_move', 'magic']);
  });

  it('counts free steps first: a plains speed brings magic within 5', () => {
    const state = withStats(fixtureGame(ridge, 0), one, { gold: 2, plains_move: 1 });
    expect(bought(state)).toEqual(['plains_move', 'mountain_move']);
  });

  it('never counts on more stamina than the player has', () => {
    const state = withStats(fixtureGame(ridge, 0), one, { gold: 2, stamina: 2 });
    expect(bought(state)).toEqual(['plains_move', 'forest_move', 'mountain_move', 'magic']);
  });

  it('counts only sites still unclaimed', () => {
    const state = withStats(fixtureGame(ridge, 0), one, { gold: 2 });
    const claimed: GameState = { ...state, poiRuntime: state.poiRuntime.map((runtime, index) => (index === 0 ? { claimedBy: player('two'), claimedOnTurn: 1 } : runtime)) };
    expect(bought(claimed)).toEqual(['plains_move', 'mountain_move', 'fighting', 'magic']);
  });

  it('weighs nothing without the gold for one', () => {
    expect(bought(fixtureGame(ridge, 0))).toEqual([]);
  });

  it('offers them from every position it searches, beside the targets and rest', () => {
    const state = withStats(fixtureGame(ridge, 0), one, { gold: 2 });
    const branches = computerSearchOptions(state, one, settings()).actions.enumerate(state, one);
    expect(branches.filter((branch) => branch.kind === 'buy')).toHaveLength(3);
    expect(branches.some((branch) => branch.kind === 'target')).toBe(true);
  });
});

describe('the search with purchases', () => {
  it('keeps the turn after a purchase: the next choice is the same player’s, the same turn', () => {
    const state = withStats(fixtureGame(ridge, 0), one, { gold: 2 });
    const seen: GameState[] = [];
    const recording: NodeEvaluator = {
      name: 'recording',
      readsRollout: false,
      evaluate(at) {
        seen.push(at.state);
        return 0.5;
      },
    };
    searchTree(state, { ...computerSearchOptions(state, one, settings(400)), evaluator: recording });
    const afterTwo = seen.filter((at) => playerById(at, one).stats.gold === 0 && at.turn.number === state.turn.number);
    expect(afterTwo.length).toBeGreaterThan(0);
    expect(afterTwo.every((at) => activePlayer(at).id === one && playerById(at, one).position === state.players[0]?.position)).toBe(true);
  });
});

describe('the turn the computer plays (761)', () => {
  const state = withStats(fixtureGame(ridge, 0), one, { gold: 2 });
  const options = computerSearchOptions(state, one, settings());
  const node = (action: MctsBranch | null, visits: number, children: MctsNode[] = []): MctsNode => {
    const made: MctsNode = { action, parent: null, children, visits, totalValue: visits / 2 };
    return made;
  };
  const result = (best: MctsNode): SearchResult => ({ root: node(null, best.visits, [best]), best, iterations: best.visits });

  it('buys along the chosen branches, then moves', () => {
    const rest = node({ kind: 'rest' }, 4);
    const thenFighting = node({ kind: 'buy', skill: 'fighting' }, 5, [rest]);
    const magic = node({ kind: 'buy', skill: 'magic' }, 9, [thenFighting, node({ kind: 'rest' }, 3)]);
    expect(planTurn(state, result(magic), options)).toMatchObject({
      buys: [
        { kind: 'buy', player: one, skill: 'magic' },
        { kind: 'buy', player: one, skill: 'fighting' },
      ],
      action: { kind: 'rest', player: one },
    });
  });

  it('moves without buying when the search chose a move', () => {
    expect(planTurn(state, result(node({ kind: 'rest' }, 3)), options)).toEqual({ buys: [], action: { kind: 'rest', player: one }, branch: { kind: 'rest' } });
  });

  it('searches once more after a purchase nothing was tried below', () => {
    const plan = planTurn(state, result(node({ kind: 'buy', skill: 'magic' }, 1)), options);
    expect(plan.buys[0]).toEqual({ kind: 'buy', player: one, skill: 'magic' });
    if (plan.action === null) throw new Error('no move');
    let after = state;
    for (const buy of plan.buys) after = applyAction(after, buy, options.dice).state;
    expect(() => applyAction(after, plan.action as NonNullable<typeof plan.action>, options.dice)).not.toThrow();
  });

  it('makes no move when its purchase ends the game (756)', () => {
    // Two leads by 3 with 3 gold left; one buys and two leads by 4.
    const close = withStats(withStats(fixtureGame(ridge, 0), player('two'), { gold: 4 }), one, { gold: 1 });
    const plan = planTurn(close, result(node({ kind: 'buy', skill: 'magic' }, 1)), computerSearchOptions(close, one, settings()));
    expect(plan).toEqual({ buys: [{ kind: 'buy', player: one, skill: 'magic' }], action: null, branch: null });
  });
});
