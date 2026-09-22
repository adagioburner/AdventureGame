import type { GameConfig, PerTerrain, Terrain } from '@adventure/config';
import { RuleViolationError } from '../errors.ts';
import type { NodeId } from '../ids.ts';
import { neighbours, type MapGraph } from '../graph.ts';
import type { MovementAllowance, PlayerStats } from '../player.ts';
import type { MovementResolution } from '../action.ts';
import { terrainStepCost, type PathPreview, type PathStep } from '../path.ts';

/**
 * [SOURCE §2] "a moving skill of level N lets a player step onto N nodes of
 * that terrain type per turn for free; the allowance refreshes every turn and
 * each terrain has its own independent allowance."
 *
 * The allowance *is* the skill level, so this is the whole rule.
 */
export function refreshAllowance(stats: PlayerStats): MovementAllowance {
  return {
    plains: stats.plains_move,
    forest: stats.forest_move,
    mountain: stats.mountain_move,
  };
}

/* -------------------------------------------------------------------------- */
/*  The one accounting pass                                                    */
/* -------------------------------------------------------------------------- */

/** What one step of a path costs, once the allowance in force has been applied. */
interface StepCharge {
  readonly node: NodeId;
  readonly terrain: Terrain;
  /** True when the free per-terrain allowance covered this step. */
  readonly free: boolean;
  /** Stamina charged for entering this node; 0 when `free`. */
  readonly staminaCost: number;
}

/** The result of charging a path against one turn's allowance and stamina. */
interface PathWalk {
  /** One entry per step actually taken this turn, in path order. */
  readonly charges: readonly StepCharge[];
  readonly staminaSpent: number;
  readonly allowanceSpent: PerTerrain<number>;
}

/**
 * The single accounting pass behind both `resolveMovement` and `previewPath`.
 *
 * The rule, in the order it applies (§7, worked through in §8):
 *
 *  - the terrain charged is that of the node being **entered**, not the one
 *    being left;
 *  - the free per-terrain allowance is consumed in path order, independently
 *    per terrain;
 *  - beyond it, `STAMINA_COST` is spent — 1 plains / 2 forest / 3 mountain;
 *  - the walk stops at the first step it cannot pay for. It stops there rather
 *    than skipping on: a player cannot step over a node they cannot afford, so
 *    a later step being free does not make it reachable this turn.
 *
 * The whole path is validated before any of it is charged: a path that is not a
 * walk in the graph is a malformed request whether or not this turn would have
 * reached the bad step.
 */
function walkPath(
  graph: MapGraph,
  from: NodeId,
  path: readonly NodeId[],
  allowance: MovementAllowance,
  stamina: number,
  config: GameConfig,
): PathWalk {
  assertWalkable(graph, from, path);

  const remainingAllowance: Record<Terrain, number> = { ...allowance };
  const allowanceSpent: Record<Terrain, number> = { plains: 0, forest: 0, mountain: 0 };
  const charges: StepCharge[] = [];
  let staminaLeft = stamina;
  let staminaSpent = 0;

  for (const node of path) {
    const terrain = terrainOf(graph, node);
    if (remainingAllowance[terrain] > 0) {
      remainingAllowance[terrain]--;
      allowanceSpent[terrain]++;
      charges.push({ node, terrain, free: true, staminaCost: 0 });
      continue;
    }

    const cost = terrainStepCost(terrain, config);
    if (cost > staminaLeft) break;
    staminaLeft -= cost;
    staminaSpent += cost;
    charges.push({ node, terrain, free: false, staminaCost: cost });
  }

  return { charges, staminaSpent, allowanceSpent };
}

function terrainOf(graph: MapGraph, node: NodeId): Terrain {
  const target = graph.nodes[node];
  if (target === undefined) throw new RuleViolationError(`path enters unknown node ${node}`);
  return target.terrain;
}

/** A path is a sequence of nodes each adjacent to the last, starting from `from`. */
function assertWalkable(graph: MapGraph, from: NodeId, path: readonly NodeId[]): void {
  let cursor = from;
  for (const node of path) {
    if (!neighbours(graph, cursor).includes(node)) {
      throw new RuleViolationError(`path step ${cursor} → ${node} is not an edge of the map`);
    }
    cursor = node;
  }
}

/* -------------------------------------------------------------------------- */
/*  The two public views of it                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Walk `path` as far as this turn allows, charging the free allowance first and
 * stamina beyond it.
 *
 * [SOURCE §2] "Beyond the free allowance, stamina is spent: 1 (plains) / 2
 * (forest) / 3 (mountain) per node."
 * [SOURCE §4] "the character walks to the destination or as far as it gets this
 * turn", and the unwalked remainder is saved as next turn's planned path.
 *
 * Reference behaviour to implement against — §8's worked example: stamina 14,
 * plains-move 3, forest-move 1, mountain-move 0, standing on plains. Three
 * plains steps are free, a fourth costs 1 stamina (13 left), then one forest
 * step is free. Note the allowance is consumed in path order, per terrain, and
 * the forest step is free because forest-move is 1 — the terrain charged is
 * that of the node being *entered*.
 */
export function resolveMovement(
  graph: MapGraph,
  from: NodeId,
  path: readonly NodeId[],
  allowance: MovementAllowance,
  stamina: number,
  config: GameConfig,
): MovementResolution {
  const walk = walkPath(graph, from, path, allowance, stamina, config);
  const taken = walk.charges.length;
  const last = walk.charges[taken - 1];

  return {
    from,
    to: last?.node ?? from,
    walked: path.slice(0, taken),
    remainder: path.slice(taken),
    staminaSpent: walk.staminaSpent,
    allowanceSpent: walk.allowanceSpent,
  };
}

/**
 * The same accounting as `resolveMovement`, but producing the per-step colours
 * the UI draws (§7.1) instead of mutating anything. Deliberately the same
 * function family so the preview a player sees and the move the server commits
 * can never disagree — this is the main reason the rules live in a package both
 * the client and the server import.
 *
 * [SOURCE §4] green = covered by the current skill allowance, yellow = costs
 * stamina (labelled with the cost), grey = unreachable. Grey steps carry a
 * `staminaCost` of 0 because nothing is charged for a step not taken; what a
 * grey step *would* cost is not this turn's business, and [SOURCE §4, chat]
 * grey is a statement about this turn only and may never be cached across
 * turns.
 *
 * `totalStaminaCost` is therefore what this turn spends — the sum over the
 * reachable prefix, equal by construction to `resolveMovement`'s
 * `staminaSpent` for the same arguments.
 */
export function previewPath(
  graph: MapGraph,
  from: NodeId,
  path: readonly NodeId[],
  allowance: MovementAllowance,
  stamina: number,
  config: GameConfig,
): PathPreview {
  const walk = walkPath(graph, from, path, allowance, stamina, config);
  const reachableStepCount = walk.charges.length;

  const steps: PathStep[] = path.map((node, index) => {
    const charge = walk.charges[index];
    if (charge === undefined) return { node, color: 'unreachable', staminaCost: 0 };
    return {
      node,
      color: charge.free ? 'free' : 'stamina',
      staminaCost: charge.staminaCost,
    };
  });

  return {
    steps,
    destination: path[path.length - 1] ?? from,
    destinationReachable: reachableStepCount === path.length,
    reachableStepCount,
    totalStaminaCost: walk.staminaSpent,
  };
}
