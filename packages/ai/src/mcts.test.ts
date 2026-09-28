import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '@adventure/config';
import { applyAction, createDiceSource, createRng, type GameState } from '@adventure/core';
import { goldExhaustedTermination, restWhenStuck, rolloutCursor, runRollout } from '@adventure/sim';
import {
  fixtureGame,
  fixtureMap,
  n,
  player,
  withStats,
} from '../../core/src/rules/scenario.fixture.ts';
import { search, searchTree, startSearch } from './mcts.ts';
import {
  estimatedGoldAndSkillsEvaluator,
  hybridGoldAndSkillsEvaluator,
  simulatedRolloutEvaluator,
} from './policies/evaluators.ts';
import { attractivePoiRolloutPolicy } from './policies/rollout.ts';
import { attractivePoiEnumerator, uctTreePolicy } from './policies/tree.ts';
import type { MctsBranch, MctsOptions } from './types.ts';

const restRule = restWhenStuck();

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
    actions: attractivePoiEnumerator(config),
    rollout: attractivePoiRolloutPolicy({ config, termination, restRule }),
    evaluator: simulatedRolloutEvaluator(),
    termination,
    restRule,
    dice: createDiceSource(createRng('search-dice'), config),
    rng: createRng('search'),
    timeBudgetMs: 200,
    now: tickingClock(),
    ...overrides,
  };
}

/** The star with its forest gold behind a guard of 8 instead of 4. */
const strongGuard = fixtureMap({
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
    { node: 2, kind: 'plains_move', units: 1, guard: null },
    { node: 7, kind: 'gold', units: 3, guard: { type: 'fighting', strength: 8 } },
  ],
});

describe('attractivePoiEnumerator', () => {
  const targetsOf = (branches: readonly MctsBranch[]) =>
    branches.flatMap((branch) => (branch.kind === 'target' ? [branch.target.node] : [])).sort((a, b) => a - b);
  const enumerate = (state: GameState, config = DEFAULT_GAME_CONFIG, subject = player('one')) =>
    attractivePoiEnumerator(config).enumerate(state, subject, createRng('enumerate'));

  it('branches over the most attractive POIs of each kind, never stamina, and rest always (Q65)', () => {
    const rich = withStats(fixtureGame(star, 0), player('one'), { stamina: 30 });
    const branches = enumerate(rich);
    expect(targetsOf(branches)).toEqual([n(1), n(2), n(3), n(5), n(7)]);
    expect(branches.filter((branch) => branch.kind === 'rest')).toHaveLength(1);

    // One of a kind: gold 2 on 1 at 6 (3 a gold) beats gold 3 on 7 at 10
    // won on a 5 or a 6 (10 a gold).
    const one = { ...DEFAULT_GAME_CONFIG, ai: { ...DEFAULT_GAME_CONFIG.ai, ATTRACTIVE_POIS_PER_KIND: 1 } };
    expect(targetsOf(enumerate(rich, one))).toEqual([n(1), n(2), n(3), n(5)]);
  });

  it('branches only over unclaimed POIs, recomputed at the state given', () => {
    const state = withStats(fixtureGame(star, 0), player('one'), { stamina: 30 });
    const took = applyAction(state, { kind: 'move', player: player('one'), path: [n(1)] }, createDiceSource(createRng('x'), DEFAULT_GAME_CONFIG)).state;
    const targets = targetsOf(enumerate(took, DEFAULT_GAME_CONFIG, player('two')));
    expect(targets).not.toContain(n(1));
    expect(targets).toContain(n(7));
  });

  it('settles a tie the same way at every visit to a position, and at random between searches', () => {
    // Four gold stacks of 1, each one plains step from 0: all tied.
    const ring = fixtureMap({
      terrains: ['plains', 'plains', 'plains', 'plains', 'plains'],
      edges: [
        [0, 1],
        [0, 2],
        [0, 3],
        [0, 4],
      ],
      pois: [1, 2, 3, 4].map((node) => ({ node, kind: 'gold' as const, units: 1, guard: null })),
    });
    const state = fixtureGame(ring, 0);
    const kept = new Set<string>();
    for (let search = 0; search < 20; search++) {
      const enumerator = attractivePoiEnumerator(DEFAULT_GAME_CONFIG);
      const rng = createRng(`search-${search}`);
      const first = targetsOf(enumerator.enumerate(state, player('one'), rng));
      expect(first).toHaveLength(2);
      for (let visit = 0; visit < 10; visit++) expect(targetsOf(enumerator.enumerate(state, player('one'), rng))).toEqual(first);
      kept.add(first.join());
    }
    expect(kept.size).toBeGreaterThan(1);
  });

  it('leaves out gold no roll can win, and keeps it once one roll can', () => {
    // Guard 8, fighting 1: a 6 makes 7, not more than 8.
    const hopeless = withStats(fixtureGame(strongGuard, 0), player('one'), { stamina: 30, fighting: 1 });
    expect(targetsOf(enumerate(hopeless))).toEqual([n(2)]);
    // Fighting 3: a 6 makes 9.
    const onASix = withStats(hopeless, player('one'), { fighting: 3 });
    expect(targetsOf(enumerate(onASix))).toEqual([n(2), n(7)]);
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
        restRule,
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

describe('startSearch', () => {
  it('thinks a slice at a time until the budget is spent', () => {
    const state = fixtureGame(star, 0);
    const clock = tickingClock();
    const sliced = startSearch(state, optionsFor(state, { now: clock, timeBudgetMs: 150 }));
    let slices = 1;
    while (!sliced.step(10)) slices++;
    expect(slices).toBeGreaterThan(5);
    expect(clock()).toBeLessThanOrEqual(160);
    const { root, iterations } = sliced.result();
    expect(root.visits).toBe(iterations);
  });

  it('comes to the same choice as one long search', () => {
    const state = fixtureGame(star, 0);
    const sliced = startSearch(state, optionsFor(state, { timeBudgetMs: 2000 }));
    while (!sliced.step(25));
    expect(sliced.result().best.action).toEqual({ kind: 'target', target: expect.objectContaining({ node: n(1) }) });
  });

  it('has no result before its first slice, and refuses the wrong player', () => {
    const state = fixtureGame(star, 0);
    expect(() => startSearch(state, optionsFor(state)).result()).toThrow(RangeError);
    expect(() => startSearch(state, optionsFor(state, { subject: player('two') }))).toThrow(RangeError);
  });
});
