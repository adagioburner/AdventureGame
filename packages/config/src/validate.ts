import { TERRAINS } from './vocabulary.ts';
import type { PendingValue, Ruleset } from './types.ts';

export class RulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesetError';
  }
}

/** Thrown when code reaches a value GDD.md has not decided yet. */
export class UnresolvedDesignError extends Error {
  readonly gdd: string;
  readonly question: string;
  constructor(pendingValue: PendingValue<unknown>) {
    super(
      `Unresolved design decision (${pendingValue.gdd}): ${pendingValue.question}\n` +
        `See docs/OPEN_QUESTIONS.md. Do not substitute a default — ask the designer.`,
    );
    this.name = 'UnresolvedDesignError';
    this.gdd = pendingValue.gdd;
    this.question = pendingValue.question;
  }
}

/**
 * Read a pending value. Throws unless someone has actually supplied one.
 * This is the single chokepoint that keeps "undecided" from decaying into
 * "whatever the first implementer typed".
 */
export function resolvePending<T>(pendingValue: PendingValue<T>): T {
  if (pendingValue.value === null) throw new UnresolvedDesignError(pendingValue);
  return pendingValue.value;
}

/**
 * Structural invariants that the generation and balancing algorithms rely on.
 * Cheap enough to run at startup and in every test that builds a Ruleset.
 */
export function validateRuleset(ruleset: Ruleset): void {
  const problems: string[] = [];
  const { config, content } = ruleset;

  // §4.2 / §3: the reward groups must partition each terrain's POIs exactly.
  for (const terrain of TERRAINS) {
    const rows = content.REWARD_TABLE[terrain];
    const poiTotal = rows.reduce((sum, row) => sum + row.poiCount, 0);
    const expected = config.pois.POI_COUNT[terrain];
    if (poiTotal !== expected) {
      problems.push(
        `§4.2/§3: ${terrain} reward groups cover ${poiTotal} POIs but POI_COUNT.${terrain} is ${expected}; ` +
          `every POI must get exactly one kind.`,
      );
    }
    // §4.3 step 2: one guaranteed unit per POI, so the row cannot be short.
    for (const row of rows) {
      if (row.totalUnits < row.poiCount) {
        problems.push(
          `§4.3 step 2: ${terrain} group ${row.kind}/${row.guard ?? 'unguarded'} has ${row.totalUnits} units ` +
            `for ${row.poiCount} POIs; each POI needs one guaranteed unit.`,
        );
      }
      if (row.poiCount < 0 || row.totalUnits < 0) {
        problems.push(`§4.2: ${terrain} group ${row.kind} has a negative count.`);
      }
    }
    // A (kind, guard) key must appear at most once per terrain: the group *is*
    // the partition unit, so a duplicate key would mean two partitions of the
    // same POIs.
    const keys = rows.map((row) => `${row.kind}/${row.guard ?? 'none'}`);
    const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
    if (duplicate !== undefined) {
      problems.push(`§4.3 step 1: ${terrain} lists the reward group ${duplicate} twice.`);
    }
  }

  // §3: the three terrain POI counts are the whole POI population.
  const totalPois = TERRAINS.reduce((sum, terrain) => sum + config.pois.POI_COUNT[terrain], 0);
  if (totalPois > config.map.MAP_NODE_COUNT) {
    problems.push(`§3: ${totalPois} POIs requested but only ${config.map.MAP_NODE_COUNT} nodes.`);
  }

  // §2.1 step 4: area shares are an approximate target but must be a partition.
  const shareSum = TERRAINS.reduce((sum, terrain) => sum + config.map.TERRAIN_AREA_SHARE[terrain], 0);
  if (Math.abs(shareSum - 1) > 1e-9) {
    problems.push(`§2.1 step 4: TERRAIN_AREA_SHARE sums to ${shareSum}, expected 1.`);
  }

  assertRange(problems, 'LEAF_COUNT', config.map.LEAF_COUNT);
  assertRange(problems, 'VALLEY_COUNT', config.map.VALLEY_COUNT);
  assertRange(problems, 'VALLEY_LENGTH', config.map.VALLEY_LENGTH);
  assertRange(problems, 'GUARD_STRENGTH', config.pois.GUARD_STRENGTH);
  assertRange(problems, 'PLAYER_COUNT', config.players.PLAYER_COUNT);

  if (config.balancing.CLOSE_CANDIDATE_COUNT < 1) {
    problems.push('§5.1: CLOSE_CANDIDATE_COUNT must be at least 1.');
  }
  if (config.balancing.REMOTENESS_SIMULATION_RUNS < 1) {
    problems.push('§5.1: REMOTENESS_SIMULATION_RUNS must be at least 1.');
  }
  // §4.3: the distribution denominator is `current_count + (1 − remoteness) × W`
  // and is >= 1 by construction for any W >= 0. A negative W would break that
  // guarantee, which is the one thing the GDD's own derivation assumes.
  if (ruleset.config.balancing.REMOTENESS_WEIGHT_FOR_DISTRIBUTION < 0) {
    problems.push('§4.3: REMOTENESS_WEIGHT_FOR_DISTRIBUTION must be non-negative.');
  }

  if (problems.length > 0) {
    throw new RulesetError(`Invalid ruleset:\n  - ${problems.join('\n  - ')}`);
  }
}

function assertRange(problems: string[], name: string, range: { min: number; max: number }): void {
  if (range.min > range.max) problems.push(`§11: ${name}.min (${range.min}) exceeds ${name}.max (${range.max}).`);
}
