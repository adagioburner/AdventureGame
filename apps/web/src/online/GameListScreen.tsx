import { useState } from 'react';
import type { GameId } from '@adventure/core';
import type { GameSummary } from '@adventure/protocol';
import { socketUrl, type Login } from './api.ts';
import { sentence } from './text.ts';
import { useChannel } from './socket.ts';

interface GameListScreenProps {
  readonly login: Login;
  onOpen(gameId: GameId): void;
  onHotseat(): void;
  onLogOut(): void;
  onRefused(): void;
}

/** A game name's longest, as the server takes it (`SetupLimits.gameNameMaxLength`). */
const GAME_NAME_MAX = 40;

/**
 * [Q48, 5 and 6] The game list: your games, waiting or started, then the open
 * games waiting for players, and a new game named by its creator, "<username>’s
 * game" to begin with. The server sends the whole list again whenever any row
 * changes. [Q50] Its top bar has the login page's "Play on one device" too,
 * so hot seat needs no logging out.
 */
export function GameListScreen({ login, onOpen, onHotseat, onLogOut, onRefused }: GameListScreenProps) {
  const me = login.user;
  const [games, setGames] = useState<readonly GameSummary[] | null>(null);
  const [name, setName] = useState(`${me.displayName}’s game`);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const channel = useChannel(
    socketUrl('/api/lobby', login.token),
    (message) => {
      if (message.type === 'lobby.games') setGames(message.games);
      else if (message.type === 'lobby.created') onOpen(message.gameId);
      else if (message.type === 'error') {
        setProblem(sentence(message.message));
        setCreating(false);
      }
    },
    onRefused,
  );

  const create = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || creating) return;
    setProblem(null);
    if (channel.send({ type: 'lobby.create', name: trimmed })) setCreating(true);
  };

  const mine = games?.filter((game) => game.mine) ?? [];
  const open = games?.filter((game) => !game.mine) ?? [];

  return (
    <div className="shell">
      <header className="bar">
        <h1>Adventure</h1>
        <span className="seed-shown">
          Logged in as <b>{me.displayName}</b>
        </span>
        <button className="btn" type="button" onClick={onHotseat}>
          Play on one device
        </button>
        <button className="btn" type="button" onClick={onLogOut}>
          Log out
        </button>
      </header>
      <main className="site-page">
        <form
          className="card site-card"
          aria-label="New game"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <h2>New game</h2>
          <label className="field">
            <span>Game name</span>
            <input
              name="game-name"
              value={name}
              maxLength={GAME_NAME_MAX}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {problem === null ? null : (
            <p className="problem" role="alert">
              {problem}
            </p>
          )}
          <button className="btn primary start" type="submit" disabled={creating || channel.status !== 'open' || name.trim().length === 0}>
            Create the game
          </button>
        </form>

        {games === null ? (
          <p className="muted" role="status">
            {channel.status === 'reconnecting' ? 'Reconnecting to the server…' : 'Loading the games…'}
          </p>
        ) : (
          <>
            <section className="card site-card" aria-label="Your games">
              <h2>Your games</h2>
              {mine.length === 0 ? (
                <p className="muted">You are not in any game yet.</p>
              ) : (
                <ul className="games">
                  {mine.map((game) => (
                    <li key={game.gameId} className="game-row">
                      <div>
                        <h3>{game.name}</h3>
                        <p className="muted">
                          {game.gameMaster === me.userId ? 'You are the game master' : `Game master: ${game.gameMasterName}`} ·{' '}
                          {game.phase === 'setup' ? `waiting for players, ${game.seatsTaken} of ${game.seatsTotal}` : 'started'}
                        </p>
                      </div>
                      <button className="btn" type="button" onClick={() => onOpen(game.gameId)}>
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card site-card" aria-label="Open games">
              <h2>Open games</h2>
              {open.length === 0 ? (
                <p className="muted">No games are waiting for players.</p>
              ) : (
                <ul className="games">
                  {open.map((game) => (
                    <li key={game.gameId} className="game-row">
                      <div>
                        <h3>{game.name}</h3>
                        <p className="muted">
                          Game master: {game.gameMasterName} · {game.seatsTaken} of {game.seatsTotal}
                        </p>
                      </div>
                      <button className="btn primary" type="button" onClick={() => onOpen(game.gameId)}>
                        Ask to join
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {channel.status === 'reconnecting' ? (
              <p className="muted" role="status">
                Reconnecting to the server…
              </p>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
