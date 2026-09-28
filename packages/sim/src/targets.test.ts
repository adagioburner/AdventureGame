import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG, type GameConfig, type PerTerrain } from '@adventure/config';
import { applyAction, asNodeId, createDiceSource, createRng, type PlayerStats } from '@adventure/core';
import { fixtureGame, fixtureMap, n, player, withStats } from '../../core/src/rules/scenario.fixture.ts';
import {
  atRandom,
  attractiveness,
  attractiveTargets,
  compareAttractiveness,
  dieOutcomes,
  effectiveDistance,
  keepMostAttractive,
  scoredTargets,
  winningOutcomes,
  type ScoredTarget,
} from './targets.ts';

const config = DEFAULT_GAME_CONFIG;

function speeds(plains: number, forest: number, mountain: number): PlayerStats {
  return { plains_move: plains, forest_move: forest, mountain_move: mountain, fighting: 0, magic: 0, gold: 0, stamina: 0 };
}

function steps(plains: number, forest: number, mountain: number): PerTerrain<number> {
  return { plains, forest, mountain };
}

/** min over n = 1..200 of 5n + stamina(n), written out as Andrei wrote it. */
function bruteForce(at: PerTerrain<number>, stats: PlayerStats): number {
  let best = Number.POSITIVE_INFINITY;
  for (let turns = 1; turns <= 200; turns++) {
    const stamina =
      Math.max(at.plains - turns * stats.plains_move, 0) +
      2 * Math.max(at.forest - turns * stats.forest_move, 0) +
      3 * Math.max(at.mountain - turns * stats.mountain_move, 0);
    best = Math.min(best, 5 * turns + stamina);
  }
  return best;
}

describe('effectiveDistance', () => {
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

  it('counts each turn as the stamina a rest gives back', () => {
    const cheapTurns: GameConfig = { ...config, movement: { ...config.movement, REST_STAMINA_GAIN: 2 } };
    // 6 mountain at 1 a turn: now 2 × 6 + 0 = 12 beats 2 + 15 = 17.
    expect(effectiveDistance(steps(0, 0, 6), speeds(0, 0, 1), cheapTurns)).toBe(12);
  });
});

describe('winningOutcomes', () => {
  const gold = (strength: number) =>
    fixtureMap({
      terrains: ['plains', 'plains'],
      edges: [[0, 1]],
      pois: [{ node: 1, kind: 'gold', units: 3, guard: { type: 'fighting', strength } }],
    }).pois[0]!;

  it('counts the rolls that beat the guard with the matching skill', () => {
    // Guard 4, fighting 0: a 5 or a 6.
    expect(winningOutcomes(gold(4), { ...speeds(0, 0, 0), fighting: 0 }, config)).toBe(2);
    // Guard 8, fighting 1: not even a 6.
    expect(winningOutcomes(gold(8), { ...speeds(0, 0, 0), fighting: 1 }, config)).toBe(0);
    expect(dieOutcomes(config)).toBe(6);
  });

  it('counts sums when the die is more than one', () => {
    const twoDice: GameConfig = { ...config, combat: { GUARD_DIE: { count: 2, sides: 6 } } };
    // Guard 10, fighting 0: 11 or 12, three ways of 36.
    expect(winningOutcomes(gold(10), { ...speeds(0, 0, 0), fighting: 0 }, twoDice)).toBe(3);
    expect(dieOutcomes(twoDice)).toBe(36);
  });
});

/**
 *      1 (forest) ── 2 (mountain)
 *     /
 *    0 ── 3 ── 4        0, 3 and 4 plains
 */
const fork = fixtureMap({
  terrains: ['plains', 'forest', 'mountain', 'plains', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
    [0, 3],
    [3, 4],
  ],
  pois: [
    { node: 1, kind: 'forest_move', units: 1, guard: null },
    { node: 2, kind: 'mountain_move', units: 2, guard: null },
    { node: 3, kind: 'stamina', units: 1, guard: null },
    { node: 4, kind: 'gold', units: 3, guard: { type: 'fighting', strength: 5 } },
  ],
});

describe('scoredTargets', () => {
  const byNode = (targets: readonly ScoredTarget[]) => new Map(targets.map((target) => [target.node, target]));

  it('scores every unclaimed POI a player could take by its steps, distance and chance', () => {
    const state = fixtureGame(fork, 0);
    const scored = byNode(scoredTargets(state, player('one'), config));
    // Stamina is never a target.
    expect([...scored.keys()].sort()).toEqual([n(1), n(2), n(4)].sort());

    expect(scored.get(n(2))).toMatchObject({ kind: 'mountain_move', steps: steps(0, 1, 1), distance: 10, units: 2 });
    expect(attractiveness(scored.get(n(2))!)).toBe(5);
    expect(scored.get(n(1))).toMatchObject({ steps: steps(0, 1, 0), distance: 7, units: 1 });
    // Guard 5, fighting 0: only a 6, so 3 gold at 7 counts as half a gold.
    expect(scored.get(n(4))).toMatchObject({ steps: steps(2, 0, 0), distance: 7, units: 3, winning: 1, outcomes: 6 });
    expect(attractiveness(scored.get(n(4))!)).toBe(14);
  });

  it('works from where the player stands, with its own skills', () => {
    const state = withStats(fixtureGame(fork, 0), player('one'), { forest_move: 1, mountain_move: 1 });
    expect(byNode(scoredTargets(state, player('one'), config)).get(n(2))?.distance).toBe(5);
  });

  it('leaves out claimed POIs and gold no roll can win', () => {
    const state = withStats(fixtureGame(fork, 0), player('one'), { stamina: 30 });
    const took = applyAction(state, { kind: 'move', player: player('one'), path: [n(1)] }, createDiceSource(createRng('x'), config)).state;
    expect(scoredTargets(took, player('two'), config).map((target) => target.node)).not.toContain(n(1));

    // Guard 7 against fighting 0 needs more than a 6.
    const walled = fixtureMap({
      terrains: ['plains', 'plains', 'plains'],
      edges: [
        [0, 1],
        [1, 2],
      ],
      pois: [
        { node: 1, kind: 'gold', units: 3, guard: { type: 'fighting', strength: 7 } },
        { node: 2, kind: 'gold', units: 1, guard: null },
      ],
    });
    const hopeless = fixtureGame(walled, 0);
    expect(scoredTargets(hopeless, player('one'), config).map((target) => target.node)).toEqual([n(2)]);
    // Fighting 2: a 6 makes 8.
    const armed = withStats(hopeless, player('one'), { fighting: 2 });
    expect(scoredTargets(armed, player('one'), config).map((target) => target.node)).toEqual([n(1), n(2)]);
  });
});

describe('keepMostAttractive', () => {
  let next = 0;
  const target = (kind: ScoredTarget['kind'], distance: number, units = 1, winning = 6): ScoredTarget => ({
    node: asNodeId(next++),
    cost: 0,
    kind,
    steps: steps(0, 0, 0),
    distance,
    units,
    winning,
    outcomes: 6,
  });

  it('keeps the most attractive of each kind, and every one of a kind with fewer', () => {
    const gold = [target('gold', 40), target('gold', 10), target('gold', 30), target('gold', 20)];
    const magic = [target('magic', 50)];
    const kept = keepMostAttractive([...gold, ...magic], 2, atRandom(createRng('keep')));
    expect(kept).toEqual([magic[0], gold[1], gold[3]]);
  });

  it('counts a guarded reward by its units times the chance', () => {
    // 3 gold won on a 5 or a 6 at 30 is as attractive as 1 sure gold at 30.
    const guarded = target('gold', 30, 3, 2);
    const sure = target('gold', 30, 1, 6);
    expect(compareAttractiveness(guarded, sure)).toBe(0);
    expect(attractiveness(guarded)).toBe(30);
  });

  it('settles a tie for the last place at random', () => {
    const best = target('gold', 5);
    const tied = [target('gold', 10), target('gold', 10), target('gold', 10)];
    const seen = new Set<unknown>();
    for (let run = 0; run < 40; run++) {
      const kept = keepMostAttractive([...tied, best], 2, atRandom(createRng(`tie-${run}`)));
      expect(kept[0]).toBe(best);
      seen.add(kept[1]?.node);
    }
    expect(seen.size).toBe(3);
  });

  it('keeps ATTRACTIVE_POIS_PER_KIND of each kind in a game', () => {
    const one: GameConfig = { ...config, ai: { ...config.ai, ATTRACTIVE_POIS_PER_KIND: 1 } };
    const line = fixtureMap({
      terrains: ['plains', 'plains', 'plains', 'plains'],
      edges: [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
      pois: [
        { node: 1, kind: 'gold', units: 1, guard: null },
        { node: 2, kind: 'gold', units: 1, guard: null },
        { node: 3, kind: 'gold', units: 5, guard: null },
      ],
    });
    const state = fixtureGame(line, 0);
    // 6 / 1, 7 / 1 and 8 / 5: the far stack is the most attractive.
    expect(attractiveTargets(state, player('one'), one, atRandom(createRng('x'))).map((kept) => kept.node)).toEqual([n(3)]);
    expect(attractiveTargets(state, player('one'), config, atRandom(createRng('x'))).map((kept) => kept.node)).toEqual([n(3), n(1)]);
  });
});
