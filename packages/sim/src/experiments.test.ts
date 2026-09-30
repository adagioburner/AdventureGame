import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type PerTerrain } from '@adventure/config';
import { createRng, routeTable, type GameState, type PlayerStats } from '@adventure/core';
import { fixtureGame, fixtureMap, n, player, withStats } from '../../core/src/rules/scenario.fixture.ts';
import { closestByTerrainCost, goldByProgressPicker, rewardUnitsClaimedShare } from './experiments.ts';
import { closestBySpeeds, effectiveDistance } from './speeds.ts';

const config = DEFAULT_GAME_CONFIG;

function speeds(plains: number, forest: number, mountain: number): PlayerStats {
  return { plains_move: plains, forest_move: forest, mountain_move: mountain, fighting: 0, magic: 0, gold: 0, stamina: 0 };
}

function steps(plains: number, forest: number, mountain: number): PerTerrain<number> {
  return { plains, forest, mountain };
}

/** 5n + stamina(n) for every n up to far past the longest route. */
function bruteForce(at: PerTerrain<number>, stats: PlayerStats): number {
  let best = Number.POSITIVE_INFINITY;
  for (let turns = 1; turns <= 100; turns++) {
    const left = (count: number, speed: number) => Math.max(0, count - turns * speed);
    const total = 5 * turns + left(at.plains, stats.plains_move) + 2 * left(at.forest, stats.forest_move) + 3 * left(at.mountain, stats.mountain_move);
    best = Math.min(best, total);
  }
  return best;
}

describe('effectiveDistance (Q65, 423)', () => {
  it('is 5 on the POI itself', () => {
    expect(effectiveDistance(steps(0, 0, 0), speeds(0, 0, 0), config)).toBe(5);
  });

  it('pays every step in stamina with no speed, in one turn', () => {
    // 4 plains, 3 forest: 5 + 4 + 2 × 3.
    expect(effectiveDistance(steps(4, 3, 0), speeds(0, 0, 0), config)).toBe(15);
  });

  it('takes more turns when a turn saves more than 5 stamina', () => {
    // 6 mountain steps at 2 a turn: 5 + 3 × 4 = 17, 10 + 3 × 2 = 16, 15 + 0 = 15.
    expect(effectiveDistance(steps(0, 0, 6), speeds(0, 0, 2), config)).toBe(15);
    // At 1 a turn a turn saves only 3: 5 + 3 × 5 = 20 is the least.
    expect(effectiveDistance(steps(0, 0, 6), speeds(0, 0, 1), config)).toBe(20);
  });

  it('is the least of 5n + stamina(n) over every n', () => {
    const rng = createRng('distances');
    for (let trial = 0; trial < 2000; trial++) {
      const at = steps(rng.nextInt(25), rng.nextInt(25), rng.nextInt(25));
      const stats = speeds(rng.nextInt(5), rng.nextInt(5), rng.nextInt(5));
      expect(effectiveDistance(at, stats, config)).toBe(bruteForce(at, stats));
    }
  });
});

/**
 * From plains node 0: a site 2 mountain steps away (node 2), and one 5 plains
 * steps away (node 7). By today's cost the plains one is nearer, 5 against 6.
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

describe('steps per terrain on the cheapest route (422 A)', () => {
  it('counts the steps onto each terrain, not the one left', () => {
    const counted = routeTable(fork.graph, config).stepsFrom(n(0));
    expect([counted.plains[2], counted.forest[2], counted.mountain[2]]).toEqual([0, 0, 2]);
    expect([counted.plains[7], counted.forest[7], counted.mountain[7]]).toEqual([5, 0, 0]);
    expect([counted.plains[0], counted.forest[0], counted.mountain[0]]).toEqual([0, 0, 0]);
  });
});

describe('closestBySpeeds (Q112, 424 A)', () => {
  const eligible = new Set([n(2), n(7)]);
  const seatOne = (state: GameState) => state.players[0]!;

  it('keeps today\'s order for a player with no speed', () => {
    // Plains site: 5 + 5 = 10; mountain site: 5 + 3 × 2 = 11.
    const state = fixtureGame(fork, 0);
    expect(closestBySpeeds(state, seatOne(state), eligible, 2)).toEqual([
      { node: n(7), cost: 5 },
      { node: n(2), cost: 6 },
    ]);
  });

  it('puts the mountain site first for a player with mountain speed', () => {
    const state = withStats(fixtureGame(fork, 0), player('one'), { mountain_move: 2 });
    expect(closestBySpeeds(state, seatOne(state), eligible, 2).map((candidate) => candidate.node)).toEqual([n(2), n(7)]);
    expect(closestBySpeeds(state, seatOne(state), eligible, 1).map((candidate) => candidate.node)).toEqual([n(2)]);
  });

  it('ranks by weighted terrain cost alone in the comparison ranking', () => {
    const state = withStats(fixtureGame(fork, 0), player('one'), { mountain_move: 2 });
    expect(closestByTerrainCost(state, seatOne(state), eligible, 2).map((candidate) => candidate.node)).toEqual([n(7), n(2)]);
  });
});

describe('goldByProgressPicker (421 A)', () => {
  const candidates = [
    { node: n(2), cost: 6 },
    { node: n(7), cost: 5 },
  ];

  it('picks among all the closest before anything is claimed', () => {
    const state = fixtureGame(fork, 0);
    expect(rewardUnitsClaimedShare(state)).toBe(0);
    const picker = goldByProgressPicker();
    const rng = createRng('picks');
    const picked = new Set<number>();
    for (let draw = 0; draw < 50; draw++) picked.add(picker(state, state.players[0]!, candidates, rng).node);
    expect([...picked].sort((a, b) => a - b)).toEqual([n(2), n(7)]);
  });

  it('always picks gold once every reward is claimed', () => {
    const fresh = fixtureGame(fork, 0);
    const state: GameState = {
      ...fresh,
      poiRuntime: fresh.poiRuntime.map(() => ({ claimedBy: player('two'), claimedOnTurn: 1 })),
    };
    expect(rewardUnitsClaimedShare(state)).toBe(1);
    const picker = goldByProgressPicker();
    const rng = createRng('picks');
    for (let draw = 0; draw < 50; draw++) expect(picker(state, state.players[0]!, candidates, rng).node).toBe(n(7));
  });
});
