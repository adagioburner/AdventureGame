import { NotImplementedError } from '../errors.ts';
import type { PlayerId } from '../ids.ts';
import type { GameState } from '../state.ts';

/**
 * [SOURCE §2] Gold still unclaimed on the map — the threshold the win
 * condition compares a lead against.
 */
export function unclaimedGoldUnits(state: GameState): number {
  let total = 0;
  for (let index = 0; index < state.map.pois.length; index++) {
    const poi = state.map.pois[index];
    if (poi === undefined || poi.reward.kind !== 'gold') continue;
    if (state.poiRuntime[index]?.claimedBy === null) total += poi.reward.units;
  }
  return total;
}

/**
 * [SOURCE §2] "A player wins once their gold lead over every other player
 * exceeds the amount of gold still unclaimed on the map [evaluated each time a
 * POI with gold is claimed]; a tie for the win results in shared victory."
 *
 * [SOURCE §1, chat] The tie clause, which did not compose on its own: "players
 * can be tied for the win only when there is no more gold left on the map."
 * That makes the two clauses consistent — a lead of 0 can only win when the
 * threshold it must exceed is also 0.
 *
 * So:
 *   - one player at the top → they win when `max − runnerUp > unclaimedGold`;
 *   - several tied at the top → shared victory exactly when no gold remains.
 *
 * "lead over every other player" is the lead over the *best* other player, so
 * the runner-up is the only one that matters.
 *
 * Returns the winners (several on a shared victory), or an empty array if
 * nobody has won yet.
 */
export function checkVictory(state: GameState): readonly PlayerId[] {
  const unclaimed = unclaimedGoldUnits(state);
  const byGoldDescending = [...state.players].sort((a, b) => b.stats.gold - a.stats.gold);

  const leader = byGoldDescending[0];
  if (leader === undefined) return [];

  const leaders = state.players.filter((player) => player.stats.gold === leader.stats.gold);
  if (leaders.length > 1) {
    // Tied at the top: a win only once nothing is left to break the tie.
    return unclaimed === 0 ? leaders.map((player) => player.id) : [];
  }

  const runnerUp = byGoldDescending[1];
  // A lone player has no one to lead; `PLAYER_COUNT.min` is 2, so this is defensive.
  if (runnerUp === undefined) return [leader.id];

  return leader.stats.gold - runnerUp.stats.gold > unclaimed ? [leader.id] : [];
}
