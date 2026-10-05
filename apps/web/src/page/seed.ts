import {
  rulesetForMapSize,
  withEarlierStaminaUnits,
  withMagicGuardChance,
  withoutDeepStart,
  withoutFortressesApart,
  withoutSeparateAreas,
  withoutStaminaSites,
  withRewardsBeforeMove,
  type MapSize,
} from '@adventure/config';
import { friendlySeed, type GameMap, type Seed } from '@adventure/core';
import { generateMap } from '@adventure/mapgen';
import { defaultRemotenessScorer } from '@adventure/sim';

/**
 * The map for a seed, at the size the number of players asks for (Q160).
 * Generation is client-side by §12.1, so the page needs no server and no file:
 * the seed and the size are the whole input. The same seed draws a different
 * map at each size.
 *
 * [Q185, 730 A] `magicGuardChance` draws it with forest gold magic-guarded at
 * that chance instead of today's, for a kept game that began before it changed.
 * [Q227] `deepStart` false draws it as before the start moved deep into the
 * plains, for a kept game from before. [Q240] `staminaSites` false draws it as
 * before the plains had stamina sites, likewise. [Q245] `separateAreas` false
 * draws it as before the forest and mountains grew in separate areas, with
 * valleys, likewise. [Q250] `rewardsMoved` false draws it with the rewards on
 * the terrains they had before they moved, likewise; every older difference
 * above is drawn on top of that. [Q255] `fortressesApart` false draws it with
 * the fortresses where they were drawn, not kept apart, likewise. [Q260]
 * `moreStaminaUnits` false draws it with the forest stamina sites' hearts as
 * they were before, 10 (14 on the larger map), likewise.
 */
export function mapFor(
  seed: Seed,
  size: MapSize,
  magicGuardChance?: number,
  deepStart = true,
  staminaSites = true,
  separateAreas = true,
  rewardsMoved = true,
  fortressesApart = true,
  moreStaminaUnits = true,
): GameMap {
  const latest = rulesetForMapSize(size);
  const today = rewardsMoved ? latest : withRewardsBeforeMove(latest);
  const chance = magicGuardChance === undefined ? today : withMagicGuardChance(today, magicGuardChance);
  const start = deepStart ? chance : withoutDeepStart(chance);
  const stamina = staminaSites ? start : withoutStaminaSites(start);
  const areas = separateAreas ? stamina : withoutSeparateAreas(stamina);
  const apart = fortressesApart ? areas : withoutFortressesApart(areas);
  const ruleset = moreStaminaUnits ? apart : withEarlierStaminaUnits(apart);
  return generateMap({ seed, ruleset, remotenessScorer: defaultRemotenessScorer });
}

/** A shareable random seed, for `?seed=` with no value. */
export function randomSeed(): Seed {
  return friendlySeed(Math.random);
}

export function initialSeed(): Seed {
  try {
    const given = new URLSearchParams(window.location.search).get('seed');
    if (given !== null && given.trim().length > 0) return given.trim();
  } catch {
    // No readable address (an embedded preview): fall through to a random seed.
  }
  return randomSeed();
}

export function writeSeed(seed: Seed): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', seed);
    window.history.replaceState(null, '', url);
  } catch {
    // Some embedded frames refuse history changes; the seed box still shows it.
  }
}
