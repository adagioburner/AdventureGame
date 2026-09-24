import { useEffect, useMemo, useRef, useState } from 'react';
import { createGameState, startingNodeFor, type GameId, type GameMap, type GameState } from '@adventure/core';
import { isOpenSeat, type SetupState } from '@adventure/protocol';
import { MapView } from '../page/MapView.tsx';
import { randomSeed } from '../page/seed.ts';
import { buildMapScene, type MapScene } from '../render/sceneModel.ts';
import { DEFAULT_RULESET } from '@adventure/config';
import { atlasOf, type ArtCatalog } from '../art/catalog.ts';
import { fromOnlineSetup, type LocalLimits, type LocalSetup } from '../setup/local.ts';
import { SetupPanel } from '../setup/SetupPanel.tsx';
import { sentence } from '../setup/text.ts';
import { socketUrl, type Login } from './api.ts';
import { mapForSeed, useArt, useMapFor } from './assets.ts';
import { useChannel } from './socket.ts';

interface OnlineGameScreenProps {
  readonly gameId: GameId;
  readonly login: Login;
  onBack(): void;
  onRefused(): void;
  /**
   * [Q51, 25] The game master turned "Play online" off and the game is gone
   * from the server: carry on with this setup on this device.
   */
  onGoLocal(setup: LocalSetup, seed: string): void;
}

/** How long a refusal from the server stays on screen. */
const NOTICE_MS = 4000;

/**
 * One online game (§6.1, Q48): its setup until the game master starts it, and
 * then the map with every figure on the starting node. Taking turns online is
 * phase 7.
 *
 * [Q48, 8] Everyone sees the map for the game's seed as the game master picks
 * it, each browser drawing it from the seed as the hot seat page does. At
 * Start the server asks the game master's browser for the map and sends it on
 * to everyone in the game (§12.1).
 */
export function OnlineGameScreen({ gameId, login, onBack, onRefused, onGoLocal }: OnlineGameScreenProps) {
  const me = login.user;
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [declined, setDeclined] = useState(false);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [seedDraft, setSeedDraft] = useState('');
  const { art, problem: artProblem } = useArt();
  // Set when the game master turns "Play online" off, until the cancel lands.
  const goingLocal = useRef(false);

  const channel = useChannel(
    socketUrl(`/api/games/${gameId}`, login.token),
    (message) => {
      switch (message.type) {
        case 'setup.state':
          if (goingLocal.current && message.setup.phase === 'cancelled' && art !== null) {
            onGoLocal(fromOnlineSetup(message.setup, localLimits(art.catalog)), message.setup.mapSeed);
            return;
          }
          setSetup(message.setup);
          return;
        case 'setup.declined':
          setDeclined(true);
          return;
        case 'game.state':
          setGame(message.state);
          return;
        case 'gm.requestMapGeneration':
          // Let the page paint "Starting" before drawing takes the main thread.
          window.setTimeout(() => {
            channel.send({ type: 'gm.mapGenerated', gameId, map: mapForSeed(message.seed) });
          }, 30);
          return;
        case 'error':
          goingLocal.current = false;
          if (message.code === 'game_not_found') setMissing(true);
          else setNotice(sentence(message.message));
          return;
        default:
          return;
      }
    },
    onRefused,
  );

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const seed = setup?.mapSeed ?? null;
  useEffect(() => {
    if (seed !== null) setSeedDraft(seed);
  }, [seed]);

  const drawn = useMapFor(game === null ? seed : null);
  const map: GameMap | null = game?.map ?? drawn.map;
  const scene = useMemo<MapScene | null>(
    () => (art === null || map === null ? null : buildMapScene(map, art.catalog, art.shape)),
    [art, map],
  );

  // Before the start, the engine's own opening position for the seats someone
  // holds, so the figures on the map are `createGameState`'s. A Human seat
  // nobody holds has no figure to show (Q51, 22).
  const seats = setup?.seats;
  const opening = useMemo<GameState | null>(() => {
    if (map === null || seats === undefined || game !== null) return null;
    const state = createGameState({
      id: gameId,
      map,
      players: seats.map((seat) => ({ id: seat.playerId, name: seat.name, avatarId: seat.avatarId, control: seat.control })),
      startingNode: startingNodeFor(map),
    });
    const open = new Set(seats.filter(isOpenSeat).map((seat) => seat.playerId));
    return { ...state, players: state.players.filter((player) => !open.has(player.id)) };
  }, [gameId, map, seats, game]);

  const shown = game ?? opening;
  const isGameMaster = setup?.gameMaster === me.userId;
  const choosing = isGameMaster && setup?.phase === 'setup' && game === null;

  const setSeed = (next: string): void => {
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === seed) return;
    setSeedDraft(trimmed);
    channel.send({ type: 'setup.setSeed', gameId, seed: trimmed });
  };

  const status = missing
    ? 'There is no game at this address.'
    : setup?.phase === 'cancelled'
      ? 'The game master cancelled this game.'
      : (artProblem ??
        drawn.problem ??
        (setup === null
          ? channel.status === 'reconnecting'
            ? 'Reconnecting to the server…'
            : 'Opening the game…'
          : art === null
            ? 'Loading the art…'
            : map === null || scene === null
              ? `Drawing the map for seed “${seed ?? ''}”…`
              : null));

  return (
    <div className="shell">
      <header className="bar">
        <h1>Adventure</h1>
        {choosing ? (
          <form
            className="seed"
            onSubmit={(event) => {
              event.preventDefault();
              setSeed(seedDraft);
            }}
          >
            <label htmlFor="seed">Map seed</label>
            <input
              id="seed"
              value={seedDraft}
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setSeedDraft(event.target.value)}
            />
            <button className="btn" type="submit" disabled={channel.status !== 'open'}>
              Draw
            </button>
            <button className="btn" type="button" disabled={channel.status !== 'open'} onClick={() => setSeed(randomSeed())}>
              Random
            </button>
          </form>
        ) : setup !== null ? (
          <span className="seed-shown">
            {setup.name} · Seed <code>{setup.mapSeed}</code>
          </span>
        ) : (
          <span className="seed-shown" />
        )}
        <button className="btn" type="button" onClick={onBack}>
          Your games
        </button>
      </header>
      {status !== null || art === null || map === null || scene === null || setup === null || shown === null ? (
        <main className="stage">
          <div className="status" role="status">
            {status}
          </div>
        </main>
      ) : (
        <main className={`stage${game === null ? ' setting-up' : ''}`}>
          <MapView art={art} map={map} scene={scene} state={shown} path={null} waypoint={null} walker={null} />
          {game !== null ? (
            <div className="notice" role="status">
              {setup.seats.some((seat) => seat.userId === me.userId)
                ? 'Online turns arrive in the next phase.'
                : 'This game started without you. Online turns arrive in the next phase.'}
            </div>
          ) : (
            <SetupPanel
              art={art}
              panel={{
                kind: 'online',
                setup,
                me,
                connected: channel.status === 'open',
                declined,
                send: (message) => {
                  if (message.type === 'setup.requestJoin') setDeclined(false);
                  return channel.send(message);
                },
                onTurnOff: () => {
                  // [Q51, 25] Anyone who asked to join is told the game was
                  // cancelled, so the game master is asked first.
                  const others = [
                    ...setup.seats.filter((seat) => seat.userId !== null && seat.userId !== me.userId).map((seat) => seat.name),
                    ...setup.pending.map((request) => request.requestedName),
                  ];
                  if (
                    others.length > 0 &&
                    !window.confirm(
                      `Stop playing online? The game leaves the game list, and ${listOf(others)} will be told it was cancelled.`,
                    )
                  ) {
                    return;
                  }
                  if (channel.send({ type: 'setup.cancel', gameId })) goingLocal.current = true;
                },
              }}
            />
          )}
          {notice === null ? null : (
            <div className="notice problem-notice" role="alert">
              {notice}
            </div>
          )}
        </main>
      )}
    </div>
  );
}

/** "Bea", "Bea and Cal", "Bea, Cal and Dan". */
function listOf(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** §11's ranges and the figurine sheet, for a setup carried to this device. */
function localLimits(catalog: ArtCatalog): LocalLimits {
  return {
    playerCount: DEFAULT_RULESET.config.players.PLAYER_COUNT,
    thinkingSeconds: DEFAULT_RULESET.config.ai.THINKING_TIME_SECONDS,
    defaultThinkingSeconds: Math.round(DEFAULT_RULESET.config.ai.MCTS_TIME_BUDGET_PER_MOVE_MS / 1000),
    figures: atlasOf(catalog, catalog.manifest.figurines.sheet).sprites.map((sprite) => sprite.id),
  };
}
