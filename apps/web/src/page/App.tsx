import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_RULESET,
  FOREST_MAGIC_GUARD_CHANCE,
  magicGuardChanceOf,
  mapSizeForPlayers,
  mapSizeOfRuleset,
  type MapSize,
} from '@adventure/config';
import type { GameMap } from '@adventure/core';
import { atlasOf, buildArtCatalog, type ArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { HotseatGame, newDiceSeed } from '../modes/hotseat.ts';
import { forgetKept, keep, keptMagicGuardChance, keptMapSize, readKept, replayKept } from '../modes/kept.ts';
import { hotseatPlay } from '../modes/play.ts';
import { loadArt, type LoadedArt } from '../render/pixi/textures.ts';
import { buildMapScene, type MapScene } from '../render/sceneModel.ts';
import { inOrder, newLocalSetup, startingOrder, toHotseatSeats, type LocalLimits, type LocalSetup } from '../setup/local.ts';
import { SetupPanel } from '../setup/SetupPanel.tsx';
import { GameScreen } from './GameScreen.tsx';
import { MapView } from './MapView.tsx';
import { initialSeed, mapFor, writeSeed } from './seed.ts';
import { BarMenu } from './BarMenu.tsx';
import { GameTitle } from './GameTitle.tsx';
import { RulesButton } from './Rules.tsx';
import { SeedForm } from './SeedForm.tsx';
import { paintSky } from './sky.ts';

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
  /** More buttons for the top bar: the site's "Games". */
  readonly barExtra?: ReactNode;
}

/**
 * A game on this device (docs/IMPLEMENTATION_PLAN.md phase 4): pick a map by
 * its seed and set up the seats on the one setup screen (Q51), then play it
 * out on one screen. `?seed=` picks the map; with no seed a random one is
 * chosen and written back into the address so it can be shared.
 */
export function App({ playOnline, carried, barExtra }: AppProps = {}) {
  // [Q56, 66] The game this browser kept, picked up where it was, unless a
  // stored game's setup was just carried here to start a new one.
  const [kept] = useState(() => (carried === undefined ? readKept() : null));
  const [seed, setSeed] = useState(() => kept?.seed ?? initialSeed());
  const [draft, setDraft] = useState(seed);
  const [logOpen, setLogOpen] = useState(false);
  const [art, setArt] = useState<LoadedArt | null>(null);
  const [map, setMap] = useState<GameMap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [setup, setSetup] = useState<LocalSetup | null>(null);
  // [Q165, 650] The order Shuffle seats drew for the game being played;
  // `null` while the seats go as set. The panel keeps showing them as set.
  const [order, setOrder] = useState<readonly string[] | null>(() => kept?.order ?? null);
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
    setSetup(carried ?? kept?.setup ?? newLocalSetup(limits));
    paintSky(catalog);
    loadArt(catalog).then(setArt, (error: unknown) => setProblem(String(error)));
  }, [catalog, limits]);

  // [Q160] The size of map the screen needs: a game's own; the kept game's
  // while it is being picked up; otherwise the one the number of players asks
  // for, so going from 3 players to 4, or back, draws the map again.
  const [resuming, setResuming] = useState(kept !== null);
  const size: MapSize | null =
    game !== null
      ? mapSizeOfRuleset(game.setup.map.ruleset)
      : resuming && kept !== null
        ? keptMapSize(kept)
        : setup === null
          ? null
          : mapSizeForPlayers(setup.seats.length);
  // [Q185, 730 A] Likewise the chance its forest gold is magic-guarded at: a
  // kept game's own, which may be the coin flip it began with; otherwise today's.
  const magicChance =
    game !== null
      ? magicGuardChanceOf(game.setup.map.ruleset)
      : resuming && kept !== null
        ? keptMagicGuardChance(kept)
        : FOREST_MAGIC_GUARD_CHANCE;

  useEffect(() => {
    if (size === null) return;
    // [Q160, 635 A] A new number of players keeps the map it had on screen,
    // and the setup panel with it, until the new size is drawn; a new seed
    // says it is drawing.
    setMap((shown) => (shown !== null && shown.seed === seed ? shown : null));
    writeSeed(seed);
    // Let "Drawing the map" paint before generation takes the main thread.
    const timer = window.setTimeout(() => {
      try {
        setMap(mapFor(seed, size, magicChance));
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    }, 30);
    return () => window.clearTimeout(timer);
  }, [seed, size, magicChance]);

  // [Q56, 66] Once its map is drawn, the kept game is played again to where it was.
  useEffect(() => {
    if (
      kept === null ||
      !resuming ||
      map === null ||
      map.seed !== kept.seed ||
      mapSizeOfRuleset(map.ruleset) !== keptMapSize(kept) ||
      magicGuardChanceOf(map.ruleset) !== keptMagicGuardChance(kept)
    ) {
      return;
    }
    setResuming(false);
    const again = replayKept(kept, map);
    if (again === null) forgetKept();
    else setGame(again);
  }, [kept, map, resuming]);
  // Every turn is kept as it is played, until New game.
  useEffect(() => {
    if (game === null || play === null || setup === null) return;
    const save = (): void => keep(game.setup.map.seed, setup, order, game);
    save();
    return play.subscribe(save);
  }, [game, play, setup, order]);
  const newGame = (): void => {
    forgetKept();
    setGame(null);
  };

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
    // Never on the map of the number of players before, while the new one is drawn.
    // Nor on a kept game's map with its forest guards from before (Q185).
    if (
      map === null ||
      setup === null ||
      mapSizeOfRuleset(map.ruleset) !== mapSizeForPlayers(setup.seats.length) ||
      magicGuardChanceOf(map.ruleset) !== FOREST_MAGIC_GUARD_CHANCE
    ) {
      return;
    }
    setLogOpen(false);
    // [Q165, 650] With Shuffle seats on, the seats are drawn now.
    const drawn = setup.shuffleSeats === true ? startingOrder(setup) : null;
    setOrder(drawn);
    setGame(new HotseatGame({ map, seats: toHotseatSeats(inOrder(setup, drawn)), diceSeed: newDiceSeed() }));
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
      <header className={`bar${playing || barExtra === undefined || barExtra === null ? '' : ' setup-bar'}`}>
        <GameTitle />
        {playing ? (
          <>
            <span className="seed-shown">
              Seed <code>{seed}</code>
            </span>
            <BarMenu>
              <button className="btn" type="button" onClick={newGame}>
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
              {barExtra}
              <RulesButton />
            </BarMenu>
          </>
        ) : (
          <>
            <SeedForm draft={draft} current={seed} onDraftChange={setDraft} onDraw={draw} />
            {barExtra}
          </>
        )}
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
          onNewGame={newGame}
        />
      ) : (
        <main className="stage setting-up">
          <MapView art={art} map={map} scene={scene} state={opening} path={null} waypoint={null} walker={null} frame="island" />
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
