import { useEffect, useMemo, useState } from 'react';
import { buildArtCatalog, type ArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { loadArt, type LoadedArt } from '../render/pixi/textures.ts';
import { ArtPanel } from './ArtPanel.tsx';
import { MapView } from './MapView.tsx';
import { previewGame, randomSeed, type PreviewGame } from './preview.ts';

/**
 * The phase 3 page: one seed, one map, drawn the way a player will see it
 * (docs/IMPLEMENTATION_PLAN.md §2.2). `?seed=<seed>` picks the map; with no
 * seed a random one is chosen and written back into the address so it can be
 * shared.
 */
export function App() {
  const [seed, setSeed] = useState(initialSeed);
  const [draft, setDraft] = useState(seed);
  const [showSample, setShowSample] = useState(true);
  const [showArt, setShowArt] = useState(false);
  const [art, setArt] = useState<LoadedArt | null>(null);
  const [game, setGame] = useState<PreviewGame | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const catalog = useMemo<ArtCatalog | null>(() => {
    try {
      return buildArtCatalog(ART_FILES);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, []);

  useEffect(() => {
    if (catalog === null) return;
    loadArt(catalog).then(setArt, (error: unknown) => setProblem(String(error)));
  }, [catalog]);

  useEffect(() => {
    setGame(null);
    writeSeed(seed);
    // Let "Drawing the map" paint before generation takes the main thread.
    const timer = window.setTimeout(() => {
      try {
        setGame(previewGame(seed));
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    }, 30);
    return () => window.clearTimeout(timer);
  }, [seed]);

  const draw = (next: string): void => {
    const trimmed = next.trim();
    if (trimmed.length === 0) return;
    setDraft(trimmed);
    setSeed(trimmed);
  };

  const status =
    problem ?? (art === null ? 'Loading the art…' : game === null ? `Drawing the map for seed “${seed}”…` : null);

  return (
    <div className="shell">
      <header className="bar">
        <h1>Adventure Map</h1>
        <form
          className="seed"
          onSubmit={(event) => {
            event.preventDefault();
            draw(draft);
          }}
        >
          <label htmlFor="seed">Seed</label>
          <input
            id="seed"
            value={draft}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className="btn primary" type="submit">
            Draw
          </button>
          <button className="btn" type="button" onClick={() => draw(randomSeed())}>
            Random
          </button>
        </form>
        <button
          id="toggle-sample"
          className="btn"
          type="button"
          aria-pressed={showSample}
          onClick={() => setShowSample(!showSample)}
        >
          Sample move
        </button>
        <button
          id="toggle-art"
          className="btn"
          type="button"
          aria-pressed={showArt}
          onClick={() => setShowArt(!showArt)}
        >
          Art in use
        </button>
      </header>
      <main className="stage">
        {status === null && art !== null && game !== null ? (
          <MapView art={art} game={game} showSample={showSample} />
        ) : (
          <div className="status" role="status">
            {status}
          </div>
        )}
        {showArt && catalog !== null ? <ArtPanel catalog={catalog} onClose={() => setShowArt(false)} /> : null}
      </main>
    </div>
  );
}

function initialSeed(): string {
  try {
    const given = new URLSearchParams(window.location.search).get('seed');
    if (given !== null && given.trim().length > 0) return given.trim();
  } catch {
    // No readable address (an embedded preview): fall through to a random seed.
  }
  return randomSeed();
}

function writeSeed(seed: string): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', seed);
    window.history.replaceState(null, '', url);
  } catch {
    // Some embedded frames refuse history changes; the seed box still shows it.
  }
}
