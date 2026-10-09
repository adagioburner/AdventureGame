import type { GameState, NodeId, PlayerState, Rng } from '@adventure/core';
import type { PoiCandidate } from './candidates.ts';

/** Which of `candidates` a player in an imagined game heads for. */
export type TargetPicker = (state: GameState, player: PlayerState, candidates: readonly PoiCandidate[], rng: Rng) => PoiCandidate;

/**
 * How far the game has run, for the players the computer imagines: the sites
 * anyone has claimed over all the map's sites, every site counting alike
 * whatever its reward (Q291). 0 at the opening, 1 once every site is taken.
 *
 * [SOURCE §9, chat] Andrei, 2026-10-09: "progress measured by the number of
 * sites [...] it's a simpler model so it will be better for further
 * development", and "the number of sites claimed is a good enough indicator".
 * It replaced the gold and skill units claimed (Q111's progress).
 */
export function sitesClaimedShare(state: GameState): number {
  const total = state.map.pois.length;
  if (total === 0) return 1;
  let claimed = 0;
  for (let index = 0; index < total; index++) if (state.poiRuntime[index]?.claimedBy !== null) claimed += 1;
  return claimed / total;
}

/**
 * The game's computer: the players in the games it imagines head for gold
 * more as the game goes on (Q290). With chance p, the game's progress
 * (`sitesClaimedShare`), a player heads for a random gold site among its
 * closest, otherwise for any of them; with no gold among them, any of them.
 * At the opening it is the uniform pick of §9's rollout policy, and near the
 * end imagined players go almost only for gold.
 *
 * [SOURCE §9, chat] Andrei, 2026-10-09: "when the computer players play
 * imaginary games let us make them favor gold sites versus others based on the
 * game progress", Q290 A. Measured in 120 two-player games at 3 s a move
 * against the computer before: 71 wins to 46, 3 shared, +1.7 ± 0.8 gold a game.
 */
export function goldByProgressPicker(): TargetPicker {
  return (state, _player, candidates, rng) => {
    if (rng.nextFloat() < sitesClaimedShare(state)) {
      const gold = candidates.filter((candidate) => poiKindAt(state, candidate.node) === 'gold');
      if (gold.length > 0) return rng.pick(gold);
    }
    return rng.pick(candidates);
  };
}

function poiKindAt(state: GameState, node: NodeId): string | undefined {
  const index = state.map.poiByNode.get(node);
  return index === undefined ? undefined : state.map.pois[index]?.reward.kind;
}
