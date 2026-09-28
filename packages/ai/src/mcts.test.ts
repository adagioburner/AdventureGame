import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '@adventure/config';
import { applyAction, createDiceSource, createRng, type GameState } from '@adventure/core';
import { goldExhaustedTermination, restWhenStuck, rolloutCursor, runRollout } from '@adventure/sim';
import {
  fixtureGame,
  fixtureMap,
  n,
  player,
  withPosition,
  withStats,
} from '../../core/src/rules/scenario.fixture.ts';
import { search, searchTree, startSearch } from './mcts.ts';
import {
  estimatedGoldAndSkillsEvaluator,
  hybridGoldAndSkillsEvaluator,
  simulatedRolloutEvaluator,
} from './policies/evaluators.ts';
import { closestPoiRolloutPolicy } from './policies/rollout.ts';
import { journeyTo, noWidening, orderKey, sortedPoiEnumerator, squareRootWidening, uctTreePolicy } from './policies/tree.ts';
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
    actions: sortedPoiEnumerator(config),
    widening: squareRootWidening(),
    rollout: closestPoiRolloutPolicy({ config, termination, restRule }),
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

describe('sortedPoiEnumerator', () => {
  const enumerator = sortedPoiEnumerator(DEFAULT_GAME_CONFIG);
  const targetsOf = (branches: readonly MctsBranch[]) =>
    branches.flatMap((branch) => (branch.kind === 'target' ? [branch.target.node] : []));
  /** Every branch of `state` in the order `firstToTry` takes them. */
  const inOrder = (state: GameState, seed = 'order'): MctsBranch[] => {
    const rng = createRng(seed);
    let untried = [...enumerator.enumerate(state, player('one'))];
    const order: MctsBranch[] = [];
    while (untried.length > 0) {
      const first = enumerator.firstToTry(state, player('one'), untried, rng);
      order.push(first);
      untried = untried.filter((branch) => branch !== first);
    }
    return order;
  };
  const label = (branch: MctsBranch) => (branch.kind === 'rest' ? 'rest' : branch.target.node);

  it('prunes nothing: every unclaimed POI, and rest even when every POI is in reach', () => {
    const rich = withStats(fixtureGame(star, 0), player('one'), { stamina: 30 });
    const branches = enumerator.enumerate(rich, player('one'));
    expect(targetsOf(branches).sort((a, b) => a - b)).toEqual([n(1), n(2), n(3), n(4), n(5), n(7)]);
    expect(branches.filter((branch) => branch.kind === 'rest')).toHaveLength(1);
  });

  it('branches only over unclaimed POIs, recomputed at the state given', () => {
    const state = withStats(fixtureGame(star, 0), player('one'), { stamina: 30 });
    const took = applyAction(state, { kind: 'move', player: player('one'), path: [n(1)] }, createDiceSource(createRng('x'), DEFAULT_GAME_CONFIG)).state;
    const targets = targetsOf(enumerator.enumerate(took, player('two')));
    expect(targets).not.toContain(n(1));
    expect(targets).toContain(n(7));
  });

  it('leaves out gold no roll can win, and keeps it once one roll can', () => {
    // Guard 8, fighting 1: a 6 makes 7, not more than 8.
    const hopeless = withStats(fixtureGame(strongGuard, 0), player('one'), { stamina: 30, fighting: 1 });
    expect(targetsOf(enumerator.enumerate(hopeless, player('one')))).toEqual([n(2)]);
    // Fighting 3: a 6 makes 9.
    const onASix = withStats(hopeless, player('one'), { fighting: 3 });
    expect(targetsOf(enumerator.enumerate(onASix, player('one')))).toEqual([n(2), n(7)]);
  });

  it('puts fewer turns first, then less stamina, then more units, and rest after every POI reached this turn', () => {
    // No skills, stamina 30: every plains POI is one turn and 1 stamina; the
    // forest gold is one turn and 5. Among the plains ones the stack of 3
    // stamina leads, then 2 gold, then the three single units in any order.
    const state = withStats(fixtureGame(star, 0), player('one'), { stamina: 30 });
    const order = inOrder(state).map(label);
    expect(order.slice(0, 2)).toEqual([n(4), n(1)]);
    expect([...order.slice(2, 5)].sort()).toEqual([n(2), n(3), n(5)].sort());
    expect(order.slice(5)).toEqual([n(7), 'rest']);
  });

  it('puts rest between the POIs reached this turn and those that take longer', () => {
    // Stamina 3: the plains POIs are still one turn; the forest gold needs a
    // rest on the way, three turns.
    const state = withStats(fixtureGame(star, 0), player('one'), { stamina: 3 });
    expect(inOrder(state).map(label).slice(5)).toEqual(['rest', n(7)]);
  });

  it('counts a guarded reward by the share of rolls that win it', () => {
    // Guard 4 and fighting 0: a 5 or a 6, two outcomes of six, so 3 gold
    // counts as 3 × 2 against a single unguarded unit's 1 × 6.
    const state = withStats(fixtureGame(star, 5), player('one'), { stamina: 30, forest_move: 2 });
    expect(orderKey(state, player('one'), { kind: 'target', target: { node: n(7), cost: 4 } }, DEFAULT_GAME_CONFIG)).toEqual({
      turns: 1,
      stamina: 0,
      units: 6,
    });
    // Node 5 is where it stands: reached this turn, for nothing, all six outcomes.
    expect(orderKey(state, player('one'), { kind: 'target', target: { node: n(5), cost: 0 } }, DEFAULT_GAME_CONFIG)).toEqual({
      turns: 1,
      stamina: 0,
      units: 6,
    });
  });

  it('breaks exact ties at random', () => {
    const state = withStats(fixtureGame(star, 0), player('one'), { stamina: 30 });
    const tied = enumerator.enumerate(state, player('one')).filter((branch) => [2, 3, 5].includes(label(branch) as number));
    const seen = new Set<unknown>();
    for (let run = 0; run < 40; run++) seen.add(label(enumerator.firstToTry(state, player('one'), tied, createRng(`tie-${run}`))));
    expect([...seen].sort()).toEqual([n(2), n(3), n(5)].sort());
  });
});

describe('journeyTo', () => {
  it('walks the route as the rules would, resting on a turn it cannot take a step', () => {
    // Stamina 3 from node 0 to the forest gold: plains 1 and forest 2 on the
    // first turn, nothing left for the last forest step on the second, so it
    // rests (+5), and takes it on the third.
    const state = withStats(fixtureGame(star, 0), player('one'), { stamina: 3 });
    expect(journeyTo(state, player('one'), [n(5), n(6), n(7)], DEFAULT_GAME_CONFIG)).toEqual({ turns: 3, stamina: 5 });
  });

  it('spends free steps before stamina, every turn', () => {
    const state = withStats(fixtureGame(star, 0), player('one'), { stamina: 0, plains_move: 1, forest_move: 1 });
    // Turn 1: plains free, forest free, then 0 stamina for the second forest
    // step. Turn 2: the forest allowance again.
    expect(journeyTo(state, player('one'), [n(5), n(6), n(7)], DEFAULT_GAME_CONFIG)).toEqual({ turns: 2, stamina: 0 });
  });

  it('counts standing on the POI as reached this turn, for nothing', () => {
    const state = fixtureGame(star, 7);
    expect(journeyTo(state, player('one'), [], DEFAULT_GAME_CONFIG)).toEqual({ turns: 1, stamina: 0 });
  });
});

describe('the search', () => {
  const nodeOf = (branch: MctsBranch | null) => (branch?.kind === 'rest' ? 'rest' : branch?.target.node);

  it('tries the branches at a node in the enumerator\'s order', () => {
    const state = withStats(fixtureGame(star, 0), player('one'), { stamina: 30 });
    // With every branch open, seven iterations try the root's seven once each, in order.
    const { root } = searchTree(state, optionsFor(state, { timeBudgetMs: 7, widening: noWidening() }));
    const tried = root.children.map((child) => nodeOf(child.action));
    expect(tried.slice(0, 2)).toEqual([n(4), n(1)]);
    expect(tried.slice(5)).toEqual([n(7), 'rest']);
  });

  it('opens ⌈√n⌉ branches at a node that has had n games, in order, and keeps them open', () => {
    const state = withStats(fixtureGame(star, 0), player('one'), { stamina: 30 });
    let opened: unknown[] = [];
    for (const iterations of [1, 2, 3, 5, 6, 10, 17, 26, 37, 50]) {
      const { root } = searchTree(state, optionsFor(state, { timeBudgetMs: iterations }));
      // The root had iterations - 1 games before the last one, which may open one more.
      expect(root.children.length).toBe(Math.min(7, Math.max(1, Math.ceil(Math.sqrt(iterations - 1)))));
      const tried = root.children.map((child) => nodeOf(child.action));
      expect(tried.slice(0, opened.length)).toEqual(opened);
      opened = tried;
    }
    expect(opened.slice(0, 2)).toEqual([n(4), n(1)]);
    expect(opened.slice(5)).toEqual([n(7), 'rest']);
  });

  it('opens the next branch when none of the open ones can be taken in this position (154)', () => {
    const state = fixtureGame(star, 0);
    // The first iteration offers only node 1; every later one offers 2 and 3
    // but no longer 1, as if another seat had claimed it in that sample.
    let calls = 0;
    const target = (node: number): MctsBranch => ({ kind: 'target', target: { node: n(node), cost: 1 } });
    const shifting: MctsOptions['actions'] = {
      name: 'shifting',
      enumerate: () => (calls++ === 0 ? [target(1)] : [target(2), target(3)]),
      firstToTry: (_state, _subject, untried) => untried[0] as MctsBranch,
    };
    // After one game the root may have 1 branch open; its only one can't be
    // taken, so the second iteration opens node 2 anyway.
    const { root } = searchTree(state, optionsFor(state, { timeBudgetMs: 2, actions: shifting }));
    expect(root.children.map((child) => nodeOf(child.action))).toEqual([n(1), n(2)]);
  });

  it('opens nothing more at a node until enough games have passed through it', () => {
    expect([0, 1, 2, 4, 5, 81, 82, 2401, 2402].map((visits) => squareRootWidening().openLimit(visits))).toEqual([
      1, 1, 2, 2, 3, 9, 10, 49, 50,
    ]);
    expect(noWidening().openLimit(0)).toBe(Number.POSITIVE_INFINITY);
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
