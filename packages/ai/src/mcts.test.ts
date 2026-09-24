import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '@adventure/config';
import { applyAction, createDiceSource, createRng, type GameState } from '@adventure/core';
import { goldExhaustedTermination, rolloutCursor, runRollout, type RestRule } from '@adventure/sim';
import {
  fixtureGame,
  fixtureMap,
  n,
  player,
  withPosition,
  withStats,
} from '../../core/src/rules/scenario.fixture.ts';
import { search, searchTree } from './mcts.ts';
import {
  estimatedGoldAndSkillsEvaluator,
  hybridGoldAndSkillsEvaluator,
  simulatedRolloutEvaluator,
} from './policies/evaluators.ts';
import { closestPoiRolloutPolicy } from './policies/rollout.ts';
import { closestUnclaimedPoiEnumerator, previewReachability, uctTreePolicy } from './policies/tree.ts';
import type { MctsOptions } from './types.ts';

/** For these tests only: which rule the game uses is the designer's call. */
const restWhenStuck: RestRule = {
  name: 'test: rest when stuck',
  restsInstead: (_state, _player, _route, preview) => preview.reachableStepCount === 0,
};

/**
 * A star of plains around node 0, with a spur of forest: seven POIs, two of
 * them gold, the rest skills and stamina.
 *
 *        1   2   3
 *         \  |  /
 *      4 ─── 0 ─── 5 ── 6 (forest) ── 7 (forest)
 */
const star = fixtureMap({
  terrains: ['plains', 'plains', 'plains', 'plains', 'plains', 'plains', 'forest', 'forest'],
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [0, 5],
    [5, 6],
    [6, 7],
  ],
  pois: [
    { node: 1, kind: 'gold', units: 2, guard: null },
    { node: 2, kind: 'plains_move', units: 1, guard: null },
    { node: 3, kind: 'fighting', units: 1, guard: null },
    { node: 4, kind: 'stamina', units: 3, guard: null },
    { node: 5, kind: 'magic', units: 1, guard: null },
    { node: 7, kind: 'gold', units: 3, guard: { type: 'fighting', strength: 4 } },
  ],
});

/** A clock that moves one millisecond each time it is read. */
function tickingClock(): () => number {
  let now = 0;
  return () => now++;
}

function optionsFor(state: GameState, overrides: Partial<MctsOptions> = {}): MctsOptions {
  const config = DEFAULT_GAME_CONFIG;
  const termination = goldExhaustedTermination();
  return {
    subject: state.players[state.turn.activeSeat - 1]?.id ?? player('one'),
    config,
    treePolicy: uctTreePolicy(config.ai.MCTS_EXPLORATION_CONSTANT),
    actions: closestUnclaimedPoiEnumerator(config, previewReachability()),
    rollout: closestPoiRolloutPolicy({ config, termination, restRule: restWhenStuck }),
    evaluator: simulatedRolloutEvaluator(),
    termination,
    restRule: restWhenStuck,
    dice: createDiceSource(createRng('search-dice'), config),
    rng: createRng('search'),
    timeBudgetMs: 200,
    now: tickingClock(),
    ...overrides,
  };
}

describe('closestUnclaimedPoiEnumerator', () => {
  const enumerate = (state: GameState) =>
    closestUnclaimedPoiEnumerator(DEFAULT_GAME_CONFIG, previewReachability()).enumerate(state, player('one'));

  it('offers rest only when fewer than 3 of its targets can be reached this turn', () => {
    const rich = withStats(fixtureGame(star, 0), player('one'), { stamina: 30 });
    expect(enumerate(rich).some((branch) => branch.kind === 'rest')).toBe(false);

    const broke = withStats(fixtureGame(star, 0), player('one'), { stamina: 0 });
    expect(enumerate(broke).some((branch) => branch.kind === 'rest')).toBe(true);

    // Two plains steps free: exactly two of the targets reachable, still < 3.
    const two = withStats(fixtureGame(star, 1), player('one'), { stamina: 0, plains_move: 2 });
    const reachable = enumerate(two).filter((branch) => branch.kind === 'target' && branch.target.cost <= 2);
    expect(reachable.length).toBeGreaterThanOrEqual(3);
    expect(enumerate(two).some((branch) => branch.kind === 'rest')).toBe(false);
  });

  it('branches only over unclaimed POIs, recomputed at the state given', () => {
    const state = withStats(fixtureGame(star, 0), player('one'), { stamina: 30 });
    const took = applyAction(state, { kind: 'move', player: player('one'), path: [n(1)] }, createDiceSource(createRng('x'), DEFAULT_GAME_CONFIG)).state;
    const targets = closestUnclaimedPoiEnumerator(DEFAULT_GAME_CONFIG, previewReachability())
      .enumerate(took, player('two'))
      .flatMap((branch) => (branch.kind === 'target' ? [branch.target.node] : []));
    expect(targets).not.toContain(n(1));
    expect(targets).toContain(n(7));
  });
});

describe('previewReachability', () => {
  it('counts a target reachable when the cheapest route arrives this turn', () => {
    const state = withStats(withPosition(fixtureGame(star, 0), player('one'), 5), player('one'), { stamina: 3, forest_move: 0 });
    const reach = previewReachability();
    expect(reach.isReachableThisTurn(state, player('one'), { node: n(7), cost: 4 })).toBe(false);
    const richer = withStats(state, player('one'), { stamina: 4 });
    expect(reach.isReachableThisTurn(richer, player('one'), { node: n(7), cost: 4 })).toBe(true);
    expect(reach.isReachableThisTurn(state, player('one'), { node: n(5), cost: 0 })).toBe(true);
  });
});

describe('evaluators', () => {
  it('all stay inside [0, 1] over whole rollouts', () => {
    const evaluators = [simulatedRolloutEvaluator(), estimatedGoldAndSkillsEvaluator(), hybridGoldAndSkillsEvaluator()];
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const state = fixtureGame(star, 0);
      const atNode = rolloutCursor(state, player('one'));
      const end = runRollout(rolloutCursor(state, player('one')), {
        config: DEFAULT_GAME_CONFIG,
        termination: goldExhaustedTermination(),
        restRule: restWhenStuck,
        rng: createRng(seed),
        dice: createDiceSource(createRng(seed), DEFAULT_GAME_CONFIG),
      });
      for (const evaluator of evaluators) {
        for (const subject of [player('one'), player('two')]) {
          const value = evaluator.evaluate(atNode, end, subject);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('search', () => {
  it('stays inside its time budget and returns one legal turn for the subject', () => {
    const state = fixtureGame(star, 0);
    const clock = tickingClock();
    const options = optionsFor(state, { now: clock, timeBudgetMs: 150 });
    const action = search(state, options);
    // One read to start, one per iteration: the budget is spent, not overrun.
    expect(clock()).toBeLessThanOrEqual(152);
    expect(action.player).toBe(player('one'));
    expect(() => applyAction(state, action, createDiceSource(createRng('check'), DEFAULT_GAME_CONFIG))).not.toThrow();
  });

  it('runs at least one iteration however small the budget', () => {
    const state = fixtureGame(star, 0);
    const result = searchTree(state, optionsFor(state, { timeBudgetMs: 0 }));
    expect(result.iterations).toBe(1);
    expect(result.root.children.length).toBe(1);
  });

  it('counts every iteration once at the root', () => {
    const state = fixtureGame(star, 0);
    const result = searchTree(state, optionsFor(state));
    expect(result.root.visits).toBe(result.iterations);
    expect(result.root.children.reduce((sum, child) => sum + child.visits, 0)).toBe(result.iterations);
  });

  it('plays the second seat too, reading that seat’s gold', () => {
    const state = applyAction(fixtureGame(star, 0), { kind: 'rest', player: player('one') }, createDiceSource(createRng('x'), DEFAULT_GAME_CONFIG)).state;
    const action = search(state, optionsFor(state));
    expect(action.player).toBe(player('two'));
  });

  it('takes the gold next door over everything else when it has the time', () => {
    // Gold 2 on 1 is one free... stamina step away; the guarded 3 is four
    // steps into forest behind a guard of 4.
    const state = fixtureGame(star, 0);
    const action = search(state, optionsFor(state, { timeBudgetMs: 2000 }));
    expect(action).toEqual({ kind: 'move', player: player('one'), path: [n(1)], waypoint: null });
  });

  it('is reproducible from its seeds and clock', () => {
    const state = fixtureGame(star, 0);
    expect(search(state, optionsFor(state))).toEqual(search(state, optionsFor(state)));
  });

  it('refuses to search for a player whose turn it is not', () => {
    const state = fixtureGame(star, 0);
    expect(() => search(state, optionsFor(state, { subject: player('two') }))).toThrow(RangeError);
  });
});
