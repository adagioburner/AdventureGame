import type { GameMap, GameState, PlayerState, Rng } from '@adventure/core';
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
  // Asked whenever a player in an imagined game picks a site, and the sites
  // change only when one is claimed (`poiRuntime` is replaced then and never
  // altered), so the last answer is kept until they do.
  if (state.poiRuntime === shareSites && state.map === shareMap) return shareKnown;
  const total = state.map.pois.length;
  let claimed = 0;
  for (let index = 0; index < total; index++) if (state.poiRuntime[index]?.claimedBy !== null) claimed += 1;
  shareSites = state.poiRuntime;
  shareMap = state.map;
  shareKnown = total === 0 ? 1 : claimed / total;
  return shareKnown;
}

let shareSites: GameState['poiRuntime'] | null = null;
let shareMap: GameState['map'] | null = null;
let shareKnown = 1;

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
      const golden = goldSites(state.map);
      const gold = candidates.filter((candidate) => golden[candidate.node] === 1);
      if (gold.length > 0) return rng.pick(gold);
    }
    return rng.pick(candidates);
  };
}

/** Which spaces hold a gold site, 1 by node id, worked out once per map: asked for every pick. */
function goldSites(map: GameMap): Uint8Array {
  if (map === goldMap) return goldKnown as Uint8Array;
  let golden = goldByMap.get(map);
  if (golden === undefined) {
    golden = new Uint8Array(map.graph.nodes.length);
    for (const poi of map.pois) if (poi.reward.kind === 'gold') golden[poi.node] = 1;
    goldByMap.set(map, golden);
  }
  goldMap = map;
  goldKnown = golden;
  return golden;
}

const goldByMap = new WeakMap<GameMap, Uint8Array>();
let goldMap: GameMap | null = null;
let goldKnown: Uint8Array | null = null;
