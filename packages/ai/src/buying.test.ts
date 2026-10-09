import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type RewardKind } from '@adventure/config';
import { activePlayer, applyAction, createDiceSource, createRng, playerById, type GameState } from '@adventure/core';
import { fixtureGame, fixtureMap, player, withStats } from '../../core/src/rules/scenario.fixture.ts';
import { computerSearchOptions, type ComputerSettings } from './computer.ts';
import { planTurn, searchTree, type SearchResult } from './mcts.ts';
import type { MctsBranch, MctsNode, NodeEvaluator } from './types.ts';

/**
 * [Q190, Q280] The computer buys a speed or skill for gold, 1 to 1, only when
 * a move this turn uses up what it bought.
 *
 *   0(p) ── 1(p) ── 2(f) ── 3(m) ── 4(p)
 *           combat  forest  magic   gold 3, combat guard 4
 *                   speed
 *
 * From 0 with no speeds, combat costs 1 stamina to reach, forest speed 1 + 2,
 * magic 1 + 2 + 3, the gold 1 + 2 + 3 + 1.
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
    { node: 4, kind: 'gold', units: 3, guard: { type: 'fighting', strength: 4 } },
  ],
});

const one = player('one');

function settings(thinkingMs = 100): ComputerSettings {
  let tick = 0;
  const rng = createRng('computer');
  return { config: DEFAULT_GAME_CONFIG, thinkingMs, rng, dice: createDiceSource(rng.fork('dice'), DEFAULT_GAME_CONFIG), now: () => tick++ };
}

function enumerate(state: GameState, bought: readonly RewardKind[] = []): readonly MctsBranch[] {
  return computerSearchOptions(state, one, settings()).actions.enumerate(state, one, bought);
}

function purchases(state: GameState, bought: readonly RewardKind[] = []): readonly string[] {
  return enumerate(state, bought).flatMap((branch) => (branch.kind === 'buy' ? [branch.skill] : []));
}

function buy(state: GameState, ...skills: RewardKind[]): GameState {
  return applyAction(state, { kind: 'buy', player: one, skills }, createDiceSource(createRng('unused'), DEFAULT_GAME_CONFIG)).state;
}

describe('which purchases the computer weighs (Q280)', () => {
  it('weighs every speed this turn’s walk can use up, and combat for a guard it could lose to', () => {
    const state = withStats(fixtureGame(ridge, 0), one, { gold: 2 });
    expect(purchases(state)).toEqual(['plains_move', 'forest_move', 'mountain_move', 'fighting']);
  });

  it('weighs a speed only where this turn’s walk reaches its terrain', () => {
    // With no stamina the walk takes no step past node 1's plains, whatever it heads for.
    const state = withStats(fixtureGame(ridge, 0), one, { gold: 2, stamina: 0 });
    expect(purchases(state)).toEqual(['plains_move']);
  });

  it('weighs combat or magic only for a guard reached this turn that could beat it before buying', () => {
    expect(purchases(withStats(fixtureGame(ridge, 0), one, { gold: 2, stamina: 6 }))).not.toContain('fighting');
    expect(purchases(withStats(fixtureGame(ridge, 0), one, { gold: 2, fighting: 4 }))).not.toContain('fighting');
    expect(purchases(withStats(fixtureGame(ridge, 0), one, { gold: 2, fighting: 3 }))).toContain('fighting');
  });

  it('buys no unit past a certain win', () => {
    const state = buy(withStats(fixtureGame(ridge, 0), one, { gold: 2, fighting: 3 }), 'fighting');
    expect(purchases(state, ['fighting'])).not.toContain('fighting');
  });

  it('counts only sites still unclaimed', () => {
    const state = withStats(fixtureGame(ridge, 0), one, { gold: 2 });
    const claimed: GameState = { ...state, poiRuntime: state.poiRuntime.map((runtime, index) => (index === 3 ? { claimedBy: player('two'), claimedOnTurn: 1 } : runtime)) };
    expect(purchases(claimed)).not.toContain('fighting');
  });

  it('weighs nothing without the gold for one', () => {
    expect(purchases(withStats(fixtureGame(ridge, 0), one, { gold: 0 }))).toEqual([]);
  });

  it('offers only the moves that use up a purchase below it, and no rest', () => {
    const state = buy(withStats(fixtureGame(ridge, 0), one, { gold: 2 }), 'forest_move');
    const branches = enumerate(state, ['forest_move']);
    expect(branches.flatMap((branch) => (branch.kind === 'target' ? [branch.target.node] : []))).toEqual([2, 3, 4]);
    expect(branches.some((branch) => branch.kind === 'rest')).toBe(false);
  });

  it('offers targets and rest as before where nothing was bought', () => {
    const state = withStats(fixtureGame(ridge, 0), one, { gold: 2 });
    const targets = enumerate(state).filter((branch) => branch.kind === 'target');
    expect(targets).toHaveLength(4);
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
      buy: { kind: 'buy', player: one, skills: ['magic', 'fighting'] },
      action: { kind: 'rest', player: one },
    });
  });

  it('moves without buying when the search chose a move', () => {
    expect(planTurn(state, result(node({ kind: 'rest' }, 3)), options)).toEqual({ buy: null, action: { kind: 'rest', player: one }, branch: { kind: 'rest' } });
  });

  it('searches once more after a purchase nothing was tried below', () => {
    const plan = planTurn(state, result(node({ kind: 'buy', skill: 'forest_move' }, 1)), options);
    expect(plan.buy?.skills[0]).toBe('forest_move');
    if (plan.action === null || plan.buy === null) throw new Error('no move');
    const after = applyAction(state, plan.buy, options.dice).state;
    expect(() => applyAction(after, plan.action as NonNullable<typeof plan.action>, options.dice)).not.toThrow();
  });

  it('makes no move when its purchase ends the game (756)', () => {
    // Two leads by 3 with 3 gold left; one buys and two leads by 4.
    const close = withStats(withStats(fixtureGame(ridge, 0), player('two'), { gold: 4 }), one, { gold: 1 });
    const plan = planTurn(close, result(node({ kind: 'buy', skill: 'magic' }, 1)), computerSearchOptions(close, one, settings()));
    expect(plan).toEqual({ buy: { kind: 'buy', player: one, skills: ['magic'] }, action: null, branch: null });
  });
});

/**
 * [Q295] Andrei's "buy, then go": guarded gold the computer cannot win is
 * skipped, unless the units its gold buys could win it, and a guard it
 * reaches this turn is a choice only once the skill it holds could.
 *
 *   0(p) ── 1(p) ── 2(p) ── 3(p)
 *           gold 2  magic   gold 2
 *           combat  skill   combat
 *           guard 8         guard 8
 *
 * With 1 stamina and no speeds, only 1 is reached this turn.
 */
describe('guarded gold it cannot win (Q295)', () => {
  const pass = fixtureMap({
    terrains: ['plains', 'plains', 'plains', 'plains'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
    pois: [
      { node: 1, kind: 'gold', units: 2, guard: { type: 'fighting', strength: 8 } },
      { node: 2, kind: 'magic', units: 1, guard: null },
      { node: 3, kind: 'gold', units: 2, guard: { type: 'fighting', strength: 8 } },
    ],
  });
  const at = (stats: Parameters<typeof withStats>[2]) => withStats(fixtureGame(pass, 0), one, { stamina: 1, ...stats });
  const skipping = (config = DEFAULT_GAME_CONFIG): ComputerSettings => ({ ...settings(), config, unwinnableGuards: 'skipped' });
  const branchesAt = (state: GameState, bought: readonly RewardKind[] = [], config = DEFAULT_GAME_CONFIG) =>
    computerSearchOptions(state, one, skipping(config)).actions.enumerate(state, one, bought);
  const targetsOf = (branches: readonly MctsBranch[]) => branches.flatMap((branch) => (branch.kind === 'target' ? [branch.target.node] : [])).sort((a, b) => a - b);
  const buysOf = (branches: readonly MctsBranch[]) => branches.flatMap((branch) => (branch.kind === 'buy' ? [branch.skill] : []));

  it('buys before it goes to a guard it reaches this turn, and heads for a farther one its gold could win', () => {
    // A 6 plus fighting 1 does not beat 8; with the 2 units its gold buys, it does.
    const state = at({ fighting: 1, gold: 2 });
    const root = branchesAt(state);
    expect(targetsOf(root)).toEqual([2, 3]);
    expect(buysOf(root)).toContain('fighting');

    const once = buy(state, 'fighting');
    expect(targetsOf(branchesAt(once, ['fighting']))).toEqual([]);
    expect(buysOf(branchesAt(once, ['fighting']))).toContain('fighting');

    const twice = buy(once, 'fighting');
    expect(targetsOf(branchesAt(twice, ['fighting', 'fighting']))).toEqual([1]);
  });

  it('weighs every unclaimed site, as before, when the guards are weighed', () => {
    const state = at({ fighting: 1, gold: 2 });
    const weighing: ComputerSettings = { ...settings(), unwinnableGuards: 'weighed' };
    expect(targetsOf(computerSearchOptions(state, one, weighing).actions.enumerate(state, one))).toEqual([1, 2, 3]);
  });

  it('skips them in the game', () => {
    expect(targetsOf(enumerate(at({ fighting: 1, gold: 2 })))).toEqual([2, 3]);
  });

  it('skips gold its gold could not buy the win of, and buys nothing for it', () => {
    const state = at({ fighting: 1, gold: 1 });
    const root = branchesAt(state);
    expect(targetsOf(root)).toEqual([2]);
    expect(buysOf(root)).not.toContain('fighting');
  });

  it('fills its choices from the next closest site', () => {
    const one10 = { ...DEFAULT_GAME_CONFIG, balancing: { ...DEFAULT_GAME_CONFIG.balancing, CLOSE_CANDIDATE_COUNT: 1 } };
    const root = branchesAt(at({ fighting: 1, gold: 2 }), [], one10);
    expect(targetsOf(root)).toEqual([2]);
    expect(buysOf(root)).toContain('fighting');
  });

  it('rests when nothing is left it could win', () => {
    const state = at({ fighting: 1, gold: 0 });
    const claimed: GameState = { ...state, poiRuntime: state.poiRuntime.map((runtime, index) => (index === 1 ? { claimedBy: player('two'), claimedOnTurn: 1 } : runtime)) };
    expect(branchesAt(claimed)).toEqual([{ kind: 'rest' }]);
  });
});
