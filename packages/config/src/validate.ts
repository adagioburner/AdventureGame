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
      // Q255: road steps are whole steps; a straight line can be any length.
      if (row.apart !== undefined) {
        if (!(Number.isInteger(row.apart.roadSteps) && row.apart.roadSteps >= 0)) {
          problems.push(
            `Q255: ${terrain} group ${row.kind}/${row.guard ?? 'unguarded'} keeps its POIs ${row.apart.roadSteps} ` +
              `road steps apart; that must be a whole number of steps, 0 or more.`,
          );
        }
        if (!(row.apart.lineSpaces >= 0)) {
          problems.push(
            `Q255: ${terrain} group ${row.kind}/${row.guard ?? 'unguarded'} keeps its POIs ${row.apart.lineSpaces} ` +
              `spaces apart in a straight line; that must be 0 or more.`,
          );
        }
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

  // §2.1 step 6b: counts of places and roads, so whole numbers; 0 turns that
  // part of the step off. The length limit is a multiple of a real road.
  for (const name of ['BORDER_ROAD_PLACES', 'BORDER_AREA_MIN_SIZE', 'JOINED_PIECE_ROADS'] as const) {
    const value = config.map[name];
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`§2.1 step 6b: ${name} must be a non-negative integer.`);
    }
  }
  if (!(config.map.BORDER_ROAD_MAX_LENGTH > 0)) {
    problems.push('§2.1 step 6b: BORDER_ROAD_MAX_LENGTH must be positive.');
  }

  if (config.balancing.CLOSE_CANDIDATE_COUNT < 1) {
    problems.push('§9: CLOSE_CANDIDATE_COUNT must be at least 1.');
  }
  if (config.balancing.REMOTENESS_CANDIDATE_COUNT < 1) {
    problems.push('§5.1: REMOTENESS_CANDIDATE_COUNT must be at least 1.');
  }
  if (config.balancing.REMOTENESS_SIMULATION_RUNS < 1) {
    problems.push('§5.1: REMOTENESS_SIMULATION_RUNS must be at least 1.');
  }
  // §4.3: the distribution denominator is `current_count + (1 − remoteness) × W`
  // and is >= 1 by construction for any W >= 0. A negative W would break that
  // guarantee, which is the one thing the GDD's own derivation assumes.
  if (config.balancing.REMOTENESS_WEIGHT_FOR_DISTRIBUTION < 0) {
    problems.push('§4.3: REMOTENESS_WEIGHT_FOR_DISTRIBUTION must be non-negative.');
  }
  // §4.3 step 4 repeats a draw; a negative count is not a shorter pass, it is a
  // typo. Zero is legitimate — it turns the swap pass off and leaves step 3's
  // distribution exactly as it falls, which is what the measurement compared to.
  const swapPasses = config.balancing.REWARD_SWAP_PASSES;
  if (!Number.isInteger(swapPasses) || swapPasses < 0) {
    problems.push('§4.3: REWARD_SWAP_PASSES must be a non-negative integer.');
  }

  // Q190: a whole number of gold for a unit, and only kinds gold may buy: never
  // gold itself, and never stamina (753).
  const buying = config.buying;
  if (!Number.isInteger(buying.GOLD_PER_UNIT) || buying.GOLD_PER_UNIT < 1) {
    problems.push('Q190: buying.GOLD_PER_UNIT must be a positive integer.');
  }
  if (buying.KINDS.includes('gold') || buying.KINDS.includes('stamina')) problems.push('Q190: gold buys neither gold nor stamina.');
  if (!Number.isFinite(config.ai.BUY_SKIP_STAMINA) || config.ai.BUY_SKIP_STAMINA < 0) {
    problems.push('Q190: ai.BUY_SKIP_STAMINA must be a non-negative number.');
  }
  // Q227: whole steps, and a limit remoteness can be below.
  const start = config.start;
  if (!Number.isInteger(start.NEARBY_STEPS) || start.NEARBY_STEPS < 0) {
    problems.push('Q227: start.NEARBY_STEPS must be a non-negative integer.');
  }
  if (!(start.MAX_REMOTENESS > 0)) {
    problems.push('Q227: start.MAX_REMOTENESS must be a positive number.');
  }
  // Q245: whole seeds, at least 1 a terrain, which step 4 needs to grow it at all.
  const seeds = config.map.TERRAIN_SEEDS;
  for (const terrain of TERRAINS) {
    const range = seeds[terrain];
    if (!Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min < 1) {
      problems.push(`Q245: map.TERRAIN_SEEDS.${terrain} must be whole numbers of at least 1.`);
    }
    assertRange(problems, `TERRAIN_SEEDS.${terrain}`, range);
  }
  const apart = config.map.KEPT_APART;
  if (!Number.isInteger(apart.GAP.min) || !Number.isInteger(apart.GAP.max) || apart.GAP.min < 1) {
    problems.push('Q245: map.KEPT_APART.GAP must be whole numbers of at least 1.');
  }
  assertRange(problems, 'KEPT_APART.GAP', apart.GAP);
  if (apart.TERRAINS.some((terrain) => !TERRAINS.includes(terrain)) || new Set(apart.TERRAINS).size !== apart.TERRAINS.length) {
    problems.push('Q245: map.KEPT_APART.TERRAINS must name each terrain at most once.');
  }
  if (!Number.isInteger(config.map.VALLEY_COUNT.min) || config.map.VALLEY_COUNT.min < 0) {
    problems.push('§11: VALLEY_COUNT.min must be a whole number, 0 or more.');
  }
  // Q200: whole gold, none at the least.
  const gold = config.players.STARTING_GOLD;
  if (!Number.isInteger(gold) || gold < 0) {
    problems.push('Q200: players.STARTING_GOLD must be a non-negative integer.');
  }
  // Q240: whole stamina for a unit, at least 1.
  const perUnit = config.pois.STAMINA_PER_UNIT;
  if (!Number.isInteger(perUnit) || perUnit < 1) {
    problems.push('Q240: pois.STAMINA_PER_UNIT must be a positive integer.');
  }

  if (problems.length > 0) {
    throw new RulesetError(`Invalid ruleset:\n  - ${problems.join('\n  - ')}`);
  }
}

function assertRange(problems: string[], name: string, range: { min: number; max: number }): void {
  if (range.min > range.max) problems.push(`§11: ${name}.min (${range.min}) exceeds ${name}.max (${range.max}).`);
}
