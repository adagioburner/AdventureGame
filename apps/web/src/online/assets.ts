import { useEffect, useState } from 'react';
import { mapSizeOfRuleset, type MapSize } from '@adventure/config';
import type { GameMap, Seed } from '@adventure/core';
import { buildArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { mapFor } from '../page/seed.ts';
import { loadArt, type LoadedArt } from '../render/pixi/textures.ts';

/**
 * The art and the maps the site's pages share, loaded once per visit however
 * often a page opens and closes.
 */

let art: Promise<LoadedArt> | null = null;

export function useArt(): { readonly art: LoadedArt | null; readonly problem: string | null } {
  const [loaded, setLoaded] = useState<LoadedArt | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    art ??= (async () => loadArt(buildArtCatalog(ART_FILES)))();
    art.then(
      (found) => live && setLoaded(found),
      (error: unknown) => live && setProblem(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      live = false;
    };
  }, []);
  return { art: loaded, problem };
}

/** The last map drawn, so the game master's browser does not draw it twice at Start. */
let lastMap: GameMap | null = null;

function isMapFor(map: GameMap | null, seed: Seed, size: MapSize): map is GameMap {
  return map !== null && map.seed === seed && mapSizeOfRuleset(map.ruleset) === size;
}

/** The map for `seed` at `size` (Q160), drawn in this browser as the hot seat page draws it (§12.1). */
export function mapForSeed(seed: Seed, size: MapSize): GameMap {
  if (!isMapFor(lastMap, seed, size)) lastMap = mapFor(seed, size);
  return lastMap;
}

/**
 * The map for `seed`, or null while it is being drawn. The drawing waits a
 * moment first so the page can say it is drawing before generation takes the
 * main thread, as on the hot seat page.
 */
export function useMapFor(seed: Seed | null, size: MapSize): { readonly map: GameMap | null; readonly problem: string | null } {
  const [map, setMap] = useState<GameMap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (seed === null) return;
    if (isMapFor(lastMap, seed, size)) {
      setMap(lastMap);
      return;
    }
    setMap(null);
    const timer = window.setTimeout(() => {
      try {
        setMap(mapForSeed(seed, size));
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    }, 30);
    return () => window.clearTimeout(timer);
  }, [seed, size]);
  return { map: seed !== null && isMapFor(map, seed, size) ? map : null, problem };
}
