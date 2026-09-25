import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_RULESET } from '@adventure/config';
import type { GameMap } from '@adventure/core';
import { atlasOf, buildArtCatalog, type ArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { HotseatGame, newDiceSeed } from '../modes/hotseat.ts';
import { hotseatPlay } from '../modes/play.ts';
import { loadArt, type LoadedArt } from '../render/pixi/textures.ts';
import { buildMapScene, type MapScene } from '../render/sceneModel.ts';
import { newLocalSetup, toHotseatSeats, type LocalLimits, type LocalSetup } from '../setup/local.ts';
import { SetupPanel } from '../setup/SetupPanel.tsx';
import { GameScreen } from './GameScreen.tsx';
import { MapView } from './MapView.tsx';
import { initialSeed, mapFor, randomSeed, writeSeed } from './seed.ts';

export interface AppProps {
  /**
   * [Q51, 25 and 26] On the site, for someone logged in: turns "Play online"
   * on, storing the game with this setup and seed, and opens it. Rejects with
   * a sentence saying why it could not. Without it, as on the game page, which
   * has no server, the setup screen has no switch (29).
   */
  readonly playOnline?: ((setup: LocalSetup, seed: string) => Promise<void>) | undefined;
  /** A stored game's setup, brought back here when "Play online" was turned off. */
  readonly carried?: LocalSetup | undefined;
  /** More buttons for the top bar: the site's "Your games". */
  readonly barExtra?: ReactNode;
}

/**
 * A game on this device (docs/IMPLEMENTATION_PLAN.md phase 4): pick a map by
 * its seed and set up the seats on the one setup screen (Q51), then play it
 * out on one screen. `?seed=` picks the map; with no seed a random one is
 * chosen and written back into the address so it can be shared.
 */
export function App({ playOnline, carried, barExtra }: AppProps = {}) {
  const [seed, setSeed] = useState(initialSeed);
  const [draft, setDraft] = useState(seed);
  const [logOpen, setLogOpen] = useState(false);
  const [art, setArt] = useState<LoadedArt | null>(null);
  const [map, setMap] = useState<GameMap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [setup, setSetup] = useState<LocalSetup | null>(null);
  const [game, setGame] = useState<HotseatGame | null>(null);
  const play = useMemo(() => (game === null ? null : hotseatPlay(game)), [game]);
  const [goingOnline, setGoingOnline] = useState<{ readonly busy: boolean; readonly problem: string | null }>({
    busy: false,
    problem: null,
  });

  const catalog = useMemo<ArtCatalog | null>(() => {
    try {
      return buildArtCatalog(ART_FILES);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, []);

  const limits = useMemo<LocalLimits | null>(() => (catalog === null ? null : localLimits(catalog)), [catalog]);

  useEffect(() => {
    if (catalog === null || limits === null) return;
    setSetup(carried ?? newLocalSetup(limits));
    loadArt(catalog).then(setArt, (error: unknown) => setProblem(String(error)));
  }, [catalog, limits]);

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

  // The opening position is the engine's, so the figures on the map are
  // `createGameState`'s own.
  const opening = useMemo(
    () => (map === null || setup === null ? null : new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: 'setup' }).state),
    [map, setup],
  );

  const start = (): void => {
    if (map === null || setup === null) return;
    setLogOpen(false);
    setGame(new HotseatGame({ map, seats: toHotseatSeats(setup), diceSeed: newDiceSeed() }));
  };

  const turnOnline = (): void => {
    if (playOnline === undefined || setup === null || goingOnline.busy) return;
    setGoingOnline({ busy: true, problem: null });
    playOnline(setup, seed).catch((error: unknown) =>
      setGoingOnline({ busy: false, problem: error instanceof Error ? error.message : String(error) }),
    );
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
        {barExtra}
      </header>
      {status !== null || art === null || map === null || scene === null || setup === null || limits === null || opening === null ? (
        <main className="stage">
          <div className="status" role="status">
            {status}
          </div>
        </main>
      ) : game !== null && play !== null ? (
        <GameScreen
          key={game.setup.diceSeed}
          art={art}
          scene={scene}
          play={play}
          logOpen={logOpen}
          onCloseLog={() => setLogOpen(false)}
          onNewGame={() => setGame(null)}
        />
      ) : (
        <main className="stage setting-up">
          <MapView art={art} map={map} scene={scene} state={opening} path={null} waypoint={null} walker={null} />
          <SetupPanel
            art={art}
            panel={{
              kind: 'local',
              setup,
              limits,
              onChange: setSetup,
              onStart: start,
              playOnline: playOnline === undefined ? null : { ...goingOnline, turnOn: turnOnline },
            }}
          />
        </main>
      )}
    </div>
  );
}

/** [Q51] §11's ranges and the figurine sheet, which a game on this device is checked against. */
function localLimits(catalog: ArtCatalog): LocalLimits {
  return {
    playerCount: DEFAULT_RULESET.config.players.PLAYER_COUNT,
    thinkingSeconds: DEFAULT_RULESET.config.ai.THINKING_TIME_SECONDS,
    defaultThinkingSeconds: Math.round(DEFAULT_RULESET.config.ai.MCTS_TIME_BUDGET_PER_MOVE_MS / 1000),
    figures: atlasOf(catalog, catalog.manifest.figurines.sheet).sprites.map((sprite) => sprite.id),
  };
}
