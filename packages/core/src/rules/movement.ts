import type { GameConfig } from '@adventure/config';
import { NotImplementedError } from '../errors.ts';
import type { NodeId } from '../ids.ts';
import type { MapGraph } from '../graph.ts';
import type { MovementAllowance, PlayerStats } from '../player.ts';
import type { MovementResolution } from '../action.ts';
import type { PathPreview } from '../path.ts';

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
  _graph: MapGraph,
  _from: NodeId,
  _path: readonly NodeId[],
  _allowance: MovementAllowance,
  _stamina: number,
  _config: GameConfig,
): MovementResolution {
  throw new NotImplementedError('resolveMovement', 'GDD.md §7 (worked example in §8)');
}

/**
 * The same accounting as `resolveMovement`, but producing the per-step colours
 * the UI draws (§7.1) instead of mutating anything. Deliberately the same
 * function family so the preview a player sees and the move the server commits
 * can never disagree — this is the main reason the rules live in a package both
 * the client and the server import.
 */
export function previewPath(
  _graph: MapGraph,
  _from: NodeId,
  _path: readonly NodeId[],
  _allowance: MovementAllowance,
  _stamina: number,
  _config: GameConfig,
): PathPreview {
  throw new NotImplementedError('previewPath', 'GDD.md §7.1');
}
