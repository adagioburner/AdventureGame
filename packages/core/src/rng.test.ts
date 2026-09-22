import { describe, expect, it } from 'vitest';

import { createRng } from './rng.ts';

/**
 * The PRNG is load-bearing for everything reproducible in this repo: [SOURCE
 * §1.3] "a map is fully reproducible from `(seed, params)` — needed for
 * debugging, replays, and the balancing harness". So these tests check the
 * contract that reproducibility rests on, not the quality of the bits.
 */
describe('createRng', () => {
  it('produces the same stream for the same seed', () => {
    const draws = (): number[] => {
      const rng = createRng('adventure');
      return Array.from({ length: 20 }, () => rng.nextUint32());
    };
    expect(draws()).toEqual(draws());
  });

  it('produces a different stream for a different seed', () => {
    const a = createRng('adventure');
    const b = createRng('adventure ');
    const first = Array.from({ length: 20 }, () => a.nextUint32());
    const second = Array.from({ length: 20 }, () => b.nextUint32());
    expect(first).not.toEqual(second);
  });

  it('keeps nextFloat in [0, 1)', () => {
    const rng = createRng('floats');
    for (let i = 0; i < 1000; i++) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps nextInt in [0, maxExclusive)', () => {
    const rng = createRng('ints');
    for (let i = 0; i < 1000; i++) {
      const value = rng.nextInt(7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it('rejects a non-positive nextInt bound', () => {
    const rng = createRng('ints');
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(-1)).toThrow(RangeError);
  });

  it('treats nextIntInclusive as inclusive at both ends', () => {
    // The §11 ranges are inclusive — LEAF_COUNT 30–45 means 45 is reachable.
    const rng = createRng('inclusive');
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(rng.nextIntInclusive(3, 5));
    expect([...seen].sort()).toEqual([3, 4, 5]);
  });

  it('allows a single-value inclusive range and rejects an inverted one', () => {
    const rng = createRng('inclusive');
    expect(rng.nextIntInclusive(4, 4)).toBe(4);
    expect(() => rng.nextIntInclusive(5, 4)).toThrow(RangeError);
  });

  it('rejects picking from an empty array', () => {
    expect(() => createRng('pick').pick([])).toThrow(RangeError);
  });

  describe('weightedPick', () => {
    it('never returns a zero-weight item', () => {
      const rng = createRng('weights');
      const picks = Array.from({ length: 500 }, () => rng.weightedPick(['never', 'always'], [0, 1]));
      expect(new Set(picks)).toEqual(new Set(['always']));
    });

    it('returns each positive-weight item roughly in proportion', () => {
      const rng = createRng('weights');
      const picks = Array.from({ length: 10_000 }, () => rng.weightedPick(['a', 'b'], [1, 3]));
      const bs = picks.filter((pick) => pick === 'b').length;
      // Deterministic given the seed; the band is wide because this asserts
      // "the weights are honoured", not any distributional quality.
      expect(bs / picks.length).toBeGreaterThan(0.7);
      expect(bs / picks.length).toBeLessThan(0.8);
    });

    it('rejects malformed inputs rather than silently choosing', () => {
      const rng = createRng('weights');
      expect(() => rng.weightedPick([], [])).toThrow(RangeError);
      expect(() => rng.weightedPick(['a', 'b'], [1])).toThrow(RangeError);
      expect(() => rng.weightedPick(['a', 'b'], [0, 0])).toThrow(RangeError);
      expect(() => rng.weightedPick(['a', 'b'], [-1, 2])).toThrow(RangeError);
      expect(() => rng.weightedPick(['a', 'b'], [Number.NaN, 2])).toThrow(RangeError);
      expect(() => rng.weightedPick(['a', 'b'], [Number.POSITIVE_INFINITY, 2])).toThrow(RangeError);
    });
  });

  describe('shuffle', () => {
    it('returns a permutation without mutating its input', () => {
      const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
      const shuffled = createRng('shuffle').shuffle(input);
      expect(shuffled).not.toBe(input);
      expect([...shuffled].sort((a, b) => a - b)).toEqual([...input]);
      expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('actually reorders', () => {
      const input = Array.from({ length: 50 }, (_, i) => i);
      expect(createRng('shuffle').shuffle(input)).not.toEqual(input);
    });
  });

  describe('fork', () => {
    it('is deterministic in the label', () => {
      const first = createRng('base').fork('die-rolls').nextUint32();
      const second = createRng('base').fork('die-rolls').nextUint32();
      expect(first).toBe(second);
    });

    it('does not reproduce the parent stream, nor another label', () => {
      // §8's server-side die-roll stream "must not be predictable from the
      // public map seed", which is the whole reason `fork` exists.
      const parent = createRng('base').nextUint32();
      const dice = createRng('base').fork('die-rolls').nextUint32();
      const other = createRng('base').fork('something-else').nextUint32();
      expect(dice).not.toBe(parent);
      expect(dice).not.toBe(other);
    });

    it('leaves the parent stream untouched', () => {
      const withFork = createRng('base');
      withFork.fork('die-rolls');
      const withoutFork = createRng('base');
      expect(withFork.nextUint32()).toBe(withoutFork.nextUint32());
    });
  });

  /**
   * The golden file. See `golden/README.md`: if this snapshot moves, every
   * generated map has moved with it, so no other golden diff means anything
   * until this one is explained.
   */
  it('matches the committed stream for the reference seed', async () => {
    const rng = createRng('adventure');
    const lines = [
      '# createRng("adventure") — the first 16 draws of each accessor, in order.',
      '# See golden/README.md before updating this file.',
      '',
      ...Array.from({ length: 16 }, (_, i) => `uint32[${i}] ${rng.nextUint32()}`),
      ...Array.from({ length: 16 }, (_, i) => `float[${i}] ${rng.nextFloat().toFixed(12)}`),
      ...Array.from({ length: 16 }, (_, i) => `int6[${i}] ${rng.nextInt(6)}`),
      '',
    ].join('\n');
    await expect(lines).toMatchFileSnapshot('../../../golden/rng/sfc32-seed-adventure.txt');
  });
});
