import { NotImplementedError } from '../errors.ts';
import type { PlayerId } from '../ids.ts';
import type { PlayerState } from '../player.ts';
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
  // The most gold anyone holds, the most anyone else holds, and how many
  // hold the most; found in one pass, since the games the computer imagines
  // ask after every gold claim.
  let most = Number.NEGATIVE_INFINITY;
  let runnerUp = Number.NEGATIVE_INFINITY;
  let leaders = 0;
  for (const player of state.players) {
    const gold = player.stats.gold;
    if (gold > most) {
      runnerUp = most;
      most = gold;
      leaders = 1;
    } else if (gold === most) {
      leaders += 1;
    } else if (gold > runnerUp) {
      runnerUp = gold;
    }
  }
  if (leaders === 0) return [];

  const unclaimed = unclaimedGoldUnits(state);
  if (leaders > 1) {
    // Tied at the top: a win only once nothing is left to break the tie.
    return unclaimed === 0 ? state.players.filter((player) => player.stats.gold === most).map((player) => player.id) : [];
  }

  const leader = state.players.find((player) => player.stats.gold === most) as PlayerState;
  // A lone player has no one to lead; `PLAYER_COUNT.min` is 2, so this is defensive.
  if (runnerUp === Number.NEGATIVE_INFINITY) return [leader.id];

  return most - runnerUp > unclaimed ? [leader.id] : [];
}

/**
 * [Q55, 45] When a game's lifetime runs out mid-game, "the player holding the
 * most gold wins, a tie shared, as the computer's simulated games do at their
 * turn limit (Q44)". [Q85, 291] The same when the game master ends a game.
 * Everyone on the most gold, however much that is.
 */
export function mostGold(state: GameState): readonly PlayerId[] {
  const most = Math.max(...state.players.map((player) => player.stats.gold));
  return state.players.filter((player) => player.stats.gold === most).map((player) => player.id);
}
