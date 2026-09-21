/**
 * Deterministic pseudo-random number generation.
 *
 * [SOURCE §1.3] "every one drawing from a single seeded PRNG so a map is fully
 * reproducible from `(seed, params)` — needed for debugging, replays, and the
 * balancing harness". Nothing in this repo may call `Math.random()`; every
 * stochastic component takes an `Rng` as an explicit argument.
 *
 * This file is infrastructure, not game design: the algorithm below (sfc32,
 * seeded through a string hash) is an implementation choice and carries no
 * provenance tag.
 */
export interface Rng {
  /** Raw 32-bit output. */
  nextUint32(): number;
  /** Uniform in [0, 1). */
  nextFloat(): number;
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Uniform integer in [min, max], inclusive — matches the GDD's ranges. */
  nextIntInclusive(min: number, max: number): number;
  /** Uniform choice. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /**
   * Choice with weights proportional to `weights[i]`. Used by §4.3 step 3;
   * the *weight formula* itself lives with the algorithm, not here.
   */
  weightedPick<T>(items: readonly T[], weights: readonly number[]): T;
  /** Fisher-Yates, returning a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /**
   * A deterministic independent stream derived from this one's seed.
   *
   * Map generation deliberately does *not* use this — §2.1 requires one single
   * stream threaded through all eight steps. `fork` exists for streams that
   * must be kept apart for a different reason, e.g. the server-side die-roll
   * stream (§8), which must not be predictable from the public map seed.
   */
  fork(label: string): Rng;
}

/** A map/game seed. Strings keep seeds shareable and human-readable. */
export type Seed = string;

function hashSeed(seed: string): [number, number, number, number] {
  // xmur3 — expands a string into four well-mixed 32-bit words.
  let h = 1779033703 ^ seed.length;
  const out: number[] = [];
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    out.push((h ^= h >>> 16) >>> 0);
  }
  return [out[0] ?? 1, out[1] ?? 2, out[2] ?? 3, out[3] ?? 4];
}

export function createRng(seed: Seed): Rng {
  let [a, b, c, d] = hashSeed(seed);

  const nextUint32 = (): number => {
    // sfc32
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const next = (t + d) | 0;
    c = (c + next) | 0;
    return next >>> 0;
  };

  const rng: Rng = {
    nextUint32,
    nextFloat: () => nextUint32() / 4294967296,
    nextInt(maxExclusive) {
      if (maxExclusive <= 0) throw new RangeError(`nextInt bound must be positive, got ${maxExclusive}`);
      return Math.floor(rng.nextFloat() * maxExclusive);
    },
    nextIntInclusive(min, max) {
      if (max < min) throw new RangeError(`nextIntInclusive: max ${max} < min ${min}`);
      return min + rng.nextInt(max - min + 1);
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('pick from empty array');
      return items[rng.nextInt(items.length)] as (typeof items)[number];
    },
    weightedPick(items, weights) {
      if (items.length === 0) throw new RangeError('weightedPick from empty array');
      if (items.length !== weights.length) throw new RangeError('weightedPick: length mismatch');
      let total = 0;
      for (const weight of weights) {
        if (!(weight >= 0) || !Number.isFinite(weight)) {
          throw new RangeError(`weightedPick: weight must be finite and non-negative, got ${weight}`);
        }
        total += weight;
      }
      if (total <= 0) throw new RangeError('weightedPick: weights sum to zero');
      let roll = rng.nextFloat() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i] as number;
        if (roll <= 0) return items[i] as (typeof items)[number];
      }
      return items[items.length - 1] as (typeof items)[number];
    },
    shuffle(items) {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = rng.nextInt(i + 1);
        const tmp = copy[i] as (typeof copy)[number];
        copy[i] = copy[j] as (typeof copy)[number];
        copy[j] = tmp;
      }
      return copy;
    },
    fork: (label) => createRng(`${seed}::${label}`),
  };

  return rng;
}
