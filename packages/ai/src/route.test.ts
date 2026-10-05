import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '@adventure/config';
import { applyAction, asNodeId, createDiceSource, createRng, playerById, poiRuntimeAt } from '@adventure/core';
import {
  bestRouteForSpeeds,
  bestRouteStepsFor,
  cheapestRoute,
  cheapestRouteSteps,
  closestByBestRoute,
  closestBySpeeds,
  macroAdvanceToTarget,
  rolloutCursor,
  turnTowards,
} from '@adventure/sim';
import { fixtureGame, fixtureMap, player, withStats } from '../../core/src/rules/scenario.fixture.ts';
import { computerSearchOptions, type ComputerSettings } from './computer.ts';
import { firstTurnOf } from './mcts.ts';
import { previewReachability, stepsReachability, usesFully } from './policies/tree.ts';

/**
 * [Q210] Stage 1: the computer's real move walks the best route for its
 * speeds; since stage 3 the games it imagines do too.
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

  it('has the players in the games it imagines walk the best route for their speeds too (stage 3)', () => {
    // Through the forest seat one arrives on its first turn; along the plains
    // its stamina would not have taken it past node 1.
    const state = withStats(fixtureGame(detour, 0), one, { forest_move: 3, plains_move: 1, stamina: 0 });
    const options = computerSearchOptions(state, one, settings());
    const end = options.rollout.run(rolloutCursor(state, one), createRng('imagined'), createDiceSource(createRng('imagined'), DEFAULT_GAME_CONFIG));
    expect(poiRuntimeAt(end.state, n(5))).toEqual({ claimedBy: one, claimedOnTurn: state.turn.number });
    // Before stage 3 they walked the cheapest route.
    expect(turnTowards(state, n(5), options.restRule)).toMatchObject({ kind: 'move', path: [n(1), n(2), n(3), n(4), n(5)] });
  });
});

/**
 * [Q210] Stage 2: the search's own choices count the best route for its
 * speeds, from the cached steps per terrain (820 A); the games it imagines
 * still count the cheapest.
 *
 *   0 ── 1 ── 2 ── 3 (gold) ── 4 ── 5 (magic)
 *   └─── 6f ── 7f ── 8f ───────────┘
 *
 * With forest speed 3, magic is 1 stamina away through the forest (score 6)
 * and 5 along the plains (score 10); gold is 3 along the plains (score 8).
 */
const sites = fixtureMap({
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
  pois: [
    { node: 5, kind: 'magic', units: 1, guard: null },
    { node: 3, kind: 'gold', units: 3, guard: null },
  ],
});

describe('the computer search’s own choices (Q210, stage 2, 820 A)', () => {
  it('ranks sites by the best route for its speeds, where its imagined games rank by the cheapest', () => {
    const state = withStats(fixtureGame(sites, 0), one, { forest_move: 3 });
    const eligible = new Set([n(3), n(5)]);
    expect(closestByBestRoute(state, playerById(state, one), eligible, 1)).toEqual([{ node: n(5), cost: 5 }]);
    expect(closestBySpeeds(state, playerById(state, one), eligible, 1)).toEqual([{ node: n(3), cost: 3 }]);
  });

  it('counts a site reached this turn along the best route, from its steps per terrain', () => {
    const state = withStats(fixtureGame(sites, 0), one, { forest_move: 3, stamina: 1 });
    const magic = { node: n(5), cost: 5 };
    expect(stepsReachability(bestRouteStepsFor).isReachableThisTurn(state, one, magic)).toBe(true);
    expect(previewReachability().isReachableThisTurn(state, one, magic)).toBe(false);
  });

  it('tells what is reached this turn from the steps per terrain exactly as walking the route does', () => {
    for (let forest = 0; forest <= 3; forest++) {
      for (let stamina = 0; stamina <= 7; stamina++) {
        const state = withStats(fixtureGame(sites, 0), one, { forest_move: forest, stamina });
        for (let node = 0; node <= 8; node++) {
          const site = { node: n(node), cost: 0 };
          expect(stepsReachability(cheapestRouteSteps).isReachableThisTurn(state, one, site)).toBe(
            previewReachability().isReachableThisTurn(state, one, site),
          );
        }
      }
    }
  });

  it('checks a purchase against the route the move walks (Q280)', () => {
    // Bought forest speed 3 is used up through the forest, the best route for it; the plains route walks none of it.
    const state = withStats(fixtureGame(sites, 0), one, { forest_move: 2, stamina: 0, gold: 1 });
    const after = applyAction(state, { kind: 'buy', player: one, skills: ['forest_move'] }, settings().dice).state;
    expect(usesFully(after, playerById(after, one), n(5), ['forest_move'], bestRouteForSpeeds)).toBe(true);
    expect(usesFully(after, playerById(after, one), n(5), ['forest_move'], cheapestRoute)).toBe(false);
  });

  it('walks a choice along the best route for its speeds, and the cheapest as before with searchRoutes cheapest', () => {
    const state = withStats(fixtureGame(sites, 0), one, { forest_move: 3, stamina: 10 });
    const options = computerSearchOptions(state, one, settings());
    expect(options.edgeRoute).toBe(bestRouteForSpeeds);
    expect(computerSearchOptions(state, one, { ...settings(), searchRoutes: 'cheapest' }).edgeRoute).toBe(cheapestRoute);
    const rules = { config: options.config, termination: options.termination, restRule: options.restRule, dice: options.dice, rng: options.rng };
    const walked = (route: typeof cheapestRoute) =>
      playerById(macroAdvanceToTarget(rolloutCursor(state, one), n(5), rules, route).cursor.state, one).stats.stamina;
    expect(walked(bestRouteForSpeeds)).toBe(9);
    expect(walked(cheapestRoute)).toBe(5);
  });
});
