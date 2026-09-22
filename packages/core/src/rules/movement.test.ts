import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_CONFIG } from '@adventure/config';
import { RuleViolationError } from '../errors.ts';
import type { MovementAllowance } from '../player.ts';
import { previewPath, refreshAllowance, resolveMovement } from './movement.ts';
import { fixtureMap, n } from './scenario.fixture.ts';

const config = DEFAULT_GAME_CONFIG;

/**
 * §8's map: five plains in a row, then a forest node, then a mountain one.
 *
 *   0(p) ── 1(p) ── 2(p) ── 3(p) ── 4(p) ── 5(f) ── 6(m)
 */
const worked = fixtureMap({
  terrains: ['plains', 'plains', 'plains', 'plains', 'plains', 'forest', 'mountain'],
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
  ],
});

/** §8's player: plains-move 3, forest-move 1, mountain-move 0. */
const workedAllowance: MovementAllowance = { plains: 3, forest: 1, mountain: 0 };

describe('refreshAllowance', () => {
  it('is the three moving-skill levels, one allowance per terrain', () => {
    const allowance = refreshAllowance({
      plains_move: 3,
      forest_move: 1,
      mountain_move: 0,
      fighting: 2,
      magic: 0,
      gold: 0,
      stamina: 14,
    });
    expect(allowance).toEqual({ plains: 3, forest: 1, mountain: 0 });
  });
});

describe('resolveMovement — §8 worked example', () => {
  const resolution = resolveMovement(
    worked.graph,
    n(0),
    [n(1), n(2), n(3), n(4), n(5)],
    workedAllowance,
    14,
    config,
  );

  it('walks the whole path', () => {
    expect(resolution.to).toBe(n(5));
    expect(resolution.walked).toEqual([n(1), n(2), n(3), n(4), n(5)]);
    expect(resolution.remainder).toEqual([]);
  });

  it('charges 1 stamina — three plains steps free, the fourth paid, the forest step free', () => {
    // "Moves 3 plains nodes free, a 4th plains node costs 1 stamina (13 left),
    // then 1 forest node free."
    expect(resolution.staminaSpent).toBe(1);
    expect(14 - resolution.staminaSpent).toBe(13);
  });

  it('spends each terrain allowance separately', () => {
    expect(resolution.allowanceSpent).toEqual({ plains: 3, forest: 1, mountain: 0 });
  });
});

describe('resolveMovement', () => {
  it('charges the terrain of the node being entered, not the one being left', () => {
    // Standing on plains with no plains allowance: stepping onto the forest node
    // costs 2 (forest), not 1 (the plains node left behind).
    const resolution = resolveMovement(worked.graph, n(4), [n(5)], { plains: 0, forest: 0, mountain: 0 }, 5, config);
    expect(resolution.staminaSpent).toBe(2);
  });

  it('stops where the stamina runs out and saves the rest of the path', () => {
    // No allowance, 2 stamina: two plains steps, then nothing left for a third.
    const resolution = resolveMovement(
      worked.graph,
      n(0),
      [n(1), n(2), n(3), n(4)],
      { plains: 0, forest: 0, mountain: 0 },
      2,
      config,
    );
    expect(resolution.to).toBe(n(2));
    expect(resolution.walked).toEqual([n(1), n(2)]);
    expect(resolution.remainder).toEqual([n(3), n(4)]);
    expect(resolution.staminaSpent).toBe(2);
  });

  it('stops at a step it cannot afford rather than stepping over it', () => {
    // 2 stamina, and a forest step (2) sits in front of a plains step (1). The
    // plains step is affordable in isolation and still unreachable this turn.
    const resolution = resolveMovement(
      worked.graph,
      n(4),
      [n(5), n(6)],
      { plains: 0, forest: 0, mountain: 0 },
      2,
      config,
    );
    expect(resolution.walked).toEqual([n(5)]);
    expect(resolution.remainder).toEqual([n(6)]);
    expect(resolution.staminaSpent).toBe(2);
  });

  it('may spend a player down to exactly zero stamina', () => {
    const resolution = resolveMovement(worked.graph, n(0), [n(1)], { plains: 0, forest: 0, mountain: 0 }, 1, config);
    expect(resolution.walked).toEqual([n(1)]);
    expect(resolution.staminaSpent).toBe(1);
  });

  it('treats an empty path as staying put, which §8 says is a legal turn', () => {
    const resolution = resolveMovement(worked.graph, n(3), [], workedAllowance, 14, config);
    expect(resolution.to).toBe(n(3));
    expect(resolution.walked).toEqual([]);
    expect(resolution.remainder).toEqual([]);
    expect(resolution.staminaSpent).toBe(0);
  });

  it('rejects a path that is not a walk in the graph', () => {
    expect(() => resolveMovement(worked.graph, n(0), [n(2)], workedAllowance, 14, config)).toThrow(RuleViolationError);
  });

  it('rejects a malformed path even when this turn would stop before reaching the bad step', () => {
    // One step of stamina-free allowance, then a jump that is not an edge.
    expect(() =>
      resolveMovement(worked.graph, n(0), [n(1), n(4)], { plains: 1, forest: 0, mountain: 0 }, 0, config),
    ).toThrow(RuleViolationError);
  });
});

describe('previewPath', () => {
  it('colours §8’s example green, green, green, yellow, green', () => {
    const preview = previewPath(worked.graph, n(0), [n(1), n(2), n(3), n(4), n(5)], workedAllowance, 14, config);
    expect(preview.steps.map((step) => step.color)).toEqual(['free', 'free', 'free', 'stamina', 'free']);
    expect(preview.steps.map((step) => step.staminaCost)).toEqual([0, 0, 0, 1, 0]);
    expect(preview.destination).toBe(n(5));
    expect(preview.destinationReachable).toBe(true);
    expect(preview.totalStaminaCost).toBe(1);
  });

  it('greys out the steps beyond this turn, including the destination', () => {
    const preview = previewPath(
      worked.graph,
      n(0),
      [n(1), n(2), n(3), n(4)],
      { plains: 0, forest: 0, mountain: 0 },
      2,
      config,
    );
    expect(preview.steps.map((step) => step.color)).toEqual(['stamina', 'stamina', 'unreachable', 'unreachable']);
    expect(preview.reachableStepCount).toBe(2);
    expect(preview.destinationReachable).toBe(false);
    // Nothing is charged for a step not taken.
    expect(preview.steps.map((step) => step.staminaCost)).toEqual([1, 1, 0, 0]);
    expect(preview.totalStaminaCost).toBe(2);
  });

  it('agrees with resolveMovement on every argument it is given', () => {
    // The whole reason the two are one function family: what a player is shown
    // and what the server commits cannot disagree.
    for (let stamina = 0; stamina <= 8; stamina++) {
      for (const allowance of [
        { plains: 0, forest: 0, mountain: 0 },
        { plains: 2, forest: 0, mountain: 0 },
        workedAllowance,
      ]) {
        const path = [n(1), n(2), n(3), n(4), n(5), n(6)];
        const preview = previewPath(worked.graph, n(0), path, allowance, stamina, config);
        const resolution = resolveMovement(worked.graph, n(0), path, allowance, stamina, config);
        expect(preview.reachableStepCount).toBe(resolution.walked.length);
        expect(preview.totalStaminaCost).toBe(resolution.staminaSpent);
        expect(preview.destinationReachable).toBe(resolution.remainder.length === 0);
      }
    }
  });

  it('is empty for an empty path, whose destination is where the player stands', () => {
    const preview = previewPath(worked.graph, n(3), [], workedAllowance, 14, config);
    expect(preview.steps).toEqual([]);
    expect(preview.destination).toBe(n(3));
    expect(preview.destinationReachable).toBe(true);
  });
});
