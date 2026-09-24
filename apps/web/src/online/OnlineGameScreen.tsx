import { useEffect, useMemo, useState } from 'react';
import { createGameState, startingNodeFor, type GameId, type GameMap, type GameState } from '@adventure/core';
import type { SetupState } from '@adventure/protocol';
import { MapView } from '../page/MapView.tsx';
import { randomSeed } from '../page/seed.ts';
import { buildMapScene, type MapScene } from '../render/sceneModel.ts';
import { socketUrl, type Login } from './api.ts';
import { mapForSeed, useArt, useMapFor } from './assets.ts';
import { SetupPanel } from './SetupPanel.tsx';
import { useChannel } from './socket.ts';
import { sentence } from './text.ts';

interface OnlineGameScreenProps {
  readonly gameId: GameId;
  readonly login: Login;
  onBack(): void;
  onRefused(): void;
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
export function OnlineGameScreen({ gameId, login, onBack, onRefused }: OnlineGameScreenProps) {
  const me = login.user;
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [declined, setDeclined] = useState(false);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [seedDraft, setSeedDraft] = useState('');
  const { art, problem: artProblem } = useArt();

  const channel = useChannel(
    socketUrl(`/api/games/${gameId}`, login.token),
    (message) => {
      switch (message.type) {
        case 'setup.state':
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

  // Before the start, the engine's own opening position for these seats, so
  // the figures and the stamina shown are `createGameState`'s.
  const seats = setup?.seats;
  const opening = useMemo<GameState | null>(
    () =>
      map === null || seats === undefined || game !== null
        ? null
        : createGameState({
            id: gameId,
            map,
            players: seats.map((seat) => ({ id: seat.playerId, name: seat.name, avatarId: seat.avatarId, control: seat.control })),
            startingNode: startingNodeFor(map),
          }),
    [gameId, map, seats, game],
  );

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
              setup={setup}
              opening={shown}
              me={me}
              connected={channel.status === 'open'}
              declined={declined}
              send={(message) => {
                if (message.type === 'setup.requestJoin') setDeclined(false);
                return channel.send(message);
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
