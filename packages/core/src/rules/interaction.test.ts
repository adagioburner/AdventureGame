import { describe, expect, it } from 'vitest';

import { RuleViolationError } from '../errors.ts';
import type { PlayerStats } from '../player.ts';
import { guardSkillStat, resolveInteraction } from './interaction.ts';
import { fixtureGame, fixtureMap, n, player } from './scenario.fixture.ts';

/**
 *   0(p) ── 1(p) ── 2(p) ── 3(p)
 *
 *   1: 3 gold behind a fighting guard of strength 5 — §8's POI.
 *   2: 2 gold behind a magic guard of strength 5.
 *   3: 1 plains-move skill, unguarded.
 */
const map = fixtureMap({
  terrains: ['plains', 'plains', 'plains', 'plains'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
  ],
  pois: [
    { node: 1, kind: 'gold', units: 3, guard: { type: 'fighting', strength: 5 } },
    { node: 2, kind: 'gold', units: 2, guard: { type: 'magic', strength: 5 } },
    { node: 3, kind: 'plains_move', units: 1, guard: null },
  ],
});

const state = fixtureGame(map, 0);

/** §8's player: fighting 2, and no magic. */
const stats: PlayerStats = {
  plains_move: 3,
  forest_move: 1,
  mountain_move: 0,
  fighting: 2,
  magic: 0,
  gold: 0,
  stamina: 14,
};

const d6 = (value: number) => ({ value, sides: 6 });

describe('guardSkillStat', () => {
  it('matches the guard colour to the stat it is rolled against', () => {
    expect(guardSkillStat({ type: 'fighting', strength: 5 })).toBe('fighting');
    expect(guardSkillStat({ type: 'magic', strength: 5 })).toBe('magic');
  });
});

describe('resolveInteraction', () => {
  it('takes §8’s reward on a 4 against a fighting guard of 5', () => {
    // "Rolls a 4, +2 fighting = 6 > 5: reward taken, turn ends."
    const resolution = resolveInteraction(state, n(1), stats, d6(4));
    expect(resolution.claimed).toBe(true);
    expect(resolution.reward).toEqual({ kind: 'gold', units: 3 });
    expect(resolution.skillUsed).toBe('fighting');
    expect(resolution.roll).toEqual(d6(4));
  });

  it('fails on a tie, since §8 asks for strictly greater', () => {
    // 3 + 2 fighting = 5, which does not beat a guard of 5.
    const resolution = resolveInteraction(state, n(1), stats, d6(3));
    expect(resolution.claimed).toBe(false);
    // The reward is still reported: it is what was at stake, and it stays on
    // the node. A failed roll has no other cost, so there is nothing else here.
    expect(resolution.reward).toEqual({ kind: 'gold', units: 3 });
  });

  it('rolls against the guard’s own colour, so the other skill does not help', () => {
    const magicless = resolveInteraction(state, n(2), stats, d6(4));
    expect(magicless.skillUsed).toBe('magic');
    // 4 + 0 magic = 4, under 5, even though fighting 2 would have carried it.
    expect(magicless.claimed).toBe(false);
  });

  it('simply takes an unguarded reward, with no roll at all', () => {
    const resolution = resolveInteraction(state, n(3), stats, null);
    expect(resolution.claimed).toBe(true);
    expect(resolution.roll).toBeNull();
    expect(resolution.skillUsed).toBeNull();
    expect(resolution.reward).toEqual({ kind: 'plains_move', units: 1 });
  });

  it('finds nothing on an ordinary node', () => {
    expect(resolveInteraction(state, n(0), stats, null)).toEqual({
      node: n(0),
      reward: null,
      roll: null,
      skillUsed: null,
      claimed: false,
    });
  });

  it('finds nothing on a POI already claimed — §4.5 consumes the reward', () => {
    const afterClaim = {
      ...state,
      poiRuntime: state.poiRuntime.map((runtime, index) =>
        index === 2 ? { claimedBy: player('one'), claimedOnTurn: 4 } : runtime,
      ),
    };
    expect(resolveInteraction(afterClaim, n(3), stats, null).claimed).toBe(false);
    expect(resolveInteraction(afterClaim, n(3), stats, null).reward).toBeNull();
  });

  it('refuses to resolve a guarded POI without a roll', () => {
    expect(() => resolveInteraction(state, n(1), stats, null)).toThrow(RuleViolationError);
  });

  it('refuses a roll that is not the ruleset’s GUARD_DIE', () => {
    expect(() => resolveInteraction(state, n(1), stats, { value: 17, sides: 20 })).toThrow(RuleViolationError);
    expect(() => resolveInteraction(state, n(1), stats, { value: 7, sides: 6 })).toThrow(RuleViolationError);
    expect(() => resolveInteraction(state, n(1), stats, { value: 0, sides: 6 })).toThrow(RuleViolationError);
  });
});
