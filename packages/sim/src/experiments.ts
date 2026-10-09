import { routeTable, type GameState, type NodeId, type PlayerState } from '@adventure/core';
import { closestPoiCandidates, type PoiCandidate } from './candidates.ts';

/**
 * Other ways for the computer player to choose where to go, kept apart from
 * the game's own so the balancing harness can compare them one at a time
 * (Andrei, 2026-09-30: "one change at a time"). The game uses none of them;
 * its own ranking, `closestBySpeeds`, is in `speeds.ts`.
 */

/**
 * The computer player's ranking before Q112: by weighted terrain cost alone,
 * whatever the player's speeds, as the remoteness walk still ranks (§5.1). For
 * comparing the computer player against its earlier self.
 */
export function closestByTerrainCost(
  state: GameState,
  player: PlayerState,
  eligible: ReadonlySet<NodeId>,
  count: number,
): readonly PoiCandidate[] {
  const config = state.map.ruleset.config;
  return closestPoiCandidates(state.map.graph, player.position, eligible, count, config, routeTable(state.map.graph, config));
}
