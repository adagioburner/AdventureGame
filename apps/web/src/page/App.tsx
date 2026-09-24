import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_RULESET } from '@adventure/config';
import type { GameMap } from '@adventure/core';
import { atlasOf, buildArtCatalog, type ArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { HotseatGame, HOTSEAT_SEATS, newDiceSeed, type HotseatSeat } from '../modes/hotseat.ts';
import { loadArt, type LoadedArt } from '../render/pixi/textures.ts';
import { buildMapScene, type MapScene } from '../render/sceneModel.ts';
import { GameScreen } from './GameScreen.tsx';
import { initialSeed, mapFor, randomSeed, writeSeed } from './seed.ts';
import { SetupScreen } from './SetupScreen.tsx';

/**
 * The hotseat game (docs/IMPLEMENTATION_PLAN.md phase 4): pick a map by its
 * seed and set up the two seats, then play it out on one screen. `?seed=`
 * picks the map; with no seed a random one is chosen and written back into the
 * address so it can be shared.
 */
export function App() {
  const [seed, setSeed] = useState(initialSeed);
  const [draft, setDraft] = useState(seed);
  const [logOpen, setLogOpen] = useState(false);
  const [art, setArt] = useState<LoadedArt | null>(null);
  const [map, setMap] = useState<GameMap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [seats, setSeats] = useState<readonly HotseatSeat[] | null>(null);
  const [game, setGame] = useState<HotseatGame | null>(null);

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
    setSeats(defaultSeats(catalog));
    loadArt(catalog).then(setArt, (error: unknown) => setProblem(String(error)));
  }, [catalog]);

  useEffect(() => {
    setMap(null);
    writeSeed(seed);
    // Let "Drawing the map" paint before generation takes the main thread.
    const timer = window.setTimeout(() => {
      try {
        setMap(mapFor(seed));
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    }, 30);
    return () => window.clearTimeout(timer);
  }, [seed]);

  const scene = useMemo<MapScene | null>(
    () => (art === null || map === null ? null : buildMapScene(map, art.catalog, art.shape)),
    [art, map],
  );

  const draw = (next: string): void => {
    const trimmed = next.trim();
    if (trimmed.length === 0) return;
    setDraft(trimmed);
    setSeed(trimmed);
  };

  const start = (): void => {
    if (map === null || seats === null) return;
    const named = seats.map((seat, index) => ({ ...seat, name: seat.name.trim() || `Player ${index + 1}` }));
    setLogOpen(false);
    setGame(new HotseatGame({ map, seats: named, diceSeed: newDiceSeed() }));
  };

  const status =
    problem ?? (art === null ? 'Loading the art…' : map === null || scene === null ? `Drawing the map for seed “${seed}”…` : null);
  const playing = game !== null && status === null;

  return (
    <div className={`shell${playing ? ' playing' : ''}`}>
      <header className="bar">
        <h1>Adventure</h1>
        {playing ? (
          <>
            <span className="seed-shown">
              Seed <code>{seed}</code>
            </span>
            <button className="btn" type="button" onClick={() => setGame(null)}>
              New game
            </button>
            <button
              id="toggle-log"
              className="btn"
              type="button"
              aria-pressed={logOpen}
              onClick={() => setLogOpen(!logOpen)}
            >
              Turn log
            </button>
          </>
        ) : (
          <form
            className="seed"
            onSubmit={(event) => {
              event.preventDefault();
              draw(draft);
            }}
          >
            <label htmlFor="seed">Map seed</label>
            <input
              id="seed"
              value={draft}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="btn" type="submit">
              Draw
            </button>
            <button className="btn" type="button" onClick={() => draw(randomSeed())}>
              Random
            </button>
          </form>
        )}
      </header>
      {status !== null || art === null || map === null || scene === null || seats === null ? (
        <main className="stage">
          <div className="status" role="status">
            {status}
          </div>
        </main>
      ) : game !== null ? (
        <GameScreen
          key={game.setup.diceSeed}
          art={art}
          scene={scene}
          game={game}
          logOpen={logOpen}
          onCloseLog={() => setLogOpen(false)}
          onNewGame={() => setGame(null)}
        />
      ) : (
        <main className="stage setting-up">
          <SetupScreen art={art} map={map} scene={scene} seats={seats} onSeats={setSeats} onStart={start} />
        </main>
      )}
    </div>
  );
}

/**
 * Two seats with different figurines, so the two can be told apart on the map.
 * Both start as people (Q41), with §11's 10 seconds ready for either to be
 * handed to the computer.
 */
function defaultSeats(catalog: ArtCatalog): readonly HotseatSeat[] {
  const ids = atlasOf(catalog, catalog.manifest.figurines.sheet).sprites.map((sprite) => sprite.id);
  return Array.from({ length: HOTSEAT_SEATS }, (_unused, index) => ({
    name: `Player ${index + 1}`,
    avatarId: ids[index % ids.length] ?? '',
    control: 'human' as const,
    thinkingSeconds: Math.round(DEFAULT_RULESET.config.ai.MCTS_TIME_BUDGET_PER_MOVE_MS / 1000),
  }));
}
