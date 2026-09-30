import { SKILL_KINDS } from '@adventure/config';
import { routeTable, type GameState, type NodeId, type PlayerState, type Rng } from '@adventure/core';
import { closestPoiCandidates, type PoiCandidate } from './candidates.ts';

/**
 * Other ways for the computer player to choose where to go, kept apart from
 * the game's own so the balancing harness can compare them one at a time
 * (Andrei, 2026-09-30: "one change at a time"). The game uses none of them;
 * its own ranking, `closestBySpeeds`, is in `speeds.ts`.
 */

/** Which of `candidates` a player in an imagined game heads for. */
export type TargetPicker = (state: GameState, player: PlayerState, candidates: readonly PoiCandidate[], rng: Rng) => PoiCandidate;

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

/**
 * The share of the map's gold and skill units anyone has claimed: Q111's
 * progress, which is Andrei's "rewards_claimed / 120" on a map with 45 gold
 * and 75 skill units.
 */
export function rewardUnitsClaimedShare(state: GameState): number {
  let total = 0;
  let claimed = 0;
  for (let index = 0; index < state.map.pois.length; index++) {
    const reward = state.map.pois[index]?.reward;
    if (reward === undefined) continue;
    if (reward.kind !== 'gold' && !SKILL_KINDS.some((kind) => kind === reward.kind)) continue;
    total += reward.units;
    if (state.poiRuntime[index]?.claimedBy !== null) claimed += reward.units;
  }
  return total === 0 ? 1 : claimed / total;
}

/**
 * Idea 1, 2026-09-30 12:24: "simulated walks should prefer gold more as the
 * game progresses (progress measured as rewards_clamed / 120)"; 421 A: with
 * chance p a player heads for a random gold site among its closest, otherwise
 * any of them, as today. With no gold among them, any of them.
 */
export function goldByProgressPicker(): TargetPicker {
  return (state, _player, candidates, rng) => {
    const progress = rewardUnitsClaimedShare(state);
    if (rng.nextFloat() < progress) {
      const gold = candidates.filter((candidate) => poiKindAt(state, candidate.node) === 'gold');
      if (gold.length > 0) return rng.pick(gold);
    }
    return rng.pick(candidates);
  };
}

function poiKindAt(state: GameState, node: NodeId): string | undefined {
  return state.map.pois.find((poi) => poi.node === node)?.reward.kind;
}
