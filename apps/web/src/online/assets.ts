import { useEffect, useState } from 'react';
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

/** The map for `seed`, drawn in this browser as the hot seat page draws it (§12.1). */
export function mapForSeed(seed: Seed): GameMap {
  if (lastMap?.seed !== seed) lastMap = mapFor(seed);
  return lastMap;
}

/**
 * The map for `seed`, or null while it is being drawn. The drawing waits a
 * moment first so the page can say it is drawing before generation takes the
 * main thread, as on the hot seat page.
 */
export function useMapFor(seed: Seed | null): { readonly map: GameMap | null; readonly problem: string | null } {
  const [map, setMap] = useState<GameMap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (seed === null) return;
    if (lastMap?.seed === seed) {
      setMap(lastMap);
      return;
    }
    setMap(null);
    const timer = window.setTimeout(() => {
      try {
        setMap(mapForSeed(seed));
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    }, 30);
    return () => window.clearTimeout(timer);
  }, [seed]);
  return { map: map?.seed === seed ? map : null, problem };
}
