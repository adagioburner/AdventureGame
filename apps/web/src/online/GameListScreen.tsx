import { useState } from 'react';
import type { GameId } from '@adventure/core';
import type { GameSummary } from '@adventure/protocol';
import { socketUrl, type Login } from './api.ts';
import { sentence } from '../setup/text.ts';
import { endsLabel, useMinuteClock } from './ends.ts';
import { useChannel } from './socket.ts';

interface GameListScreenProps {
  readonly login: Login;
  onOpen(gameId: GameId): void;
  onLogOut(): void;
  onRefused(): void;
}

/**
 * [Q48, 5] The game list: your games, waiting or started, then the open games
 * waiting for players. The server sends the whole list again whenever any row
 * changes.
 *
 * [Q51, 26] New game, in the top bar, opens the one setup screen with "Play
 * online" on: the game is made at once, named "<username>’s game" (the name
 * can be changed there, 27), and turning the switch off makes it a game on
 * this device. It stands where Q50's "Play on one device" stood.
 */
export function GameListScreen({ login, onOpen, onLogOut, onRefused }: GameListScreenProps) {
  const me = login.user;
  const [games, setGames] = useState<readonly GameSummary[] | null>(null);
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
    if (creating) return;
    setProblem(null);
    if (channel.send({ type: 'lobby.create', name: `${me.displayName}’s game` })) setCreating(true);
  };

  const mine = games?.filter((game) => game.mine) ?? [];
  const open = games?.filter((game) => !game.mine) ?? [];
  const now = useMinuteClock();
  // [Q55, 46] When a game ends, highlighted in its last 24 hours; none for a finished game.
  const endsOf = (game: GameSummary) => {
    if (game.phase === 'finished' || game.endsAt === null) return null;
    const ends = endsLabel(game.endsAt, now);
    return (
      <>
        {' · '}
        <span className={ends.soon ? 'highlight' : undefined}>{ends.text}</span>
      </>
    );
  };

  return (
    <div className="shell">
      <header className="bar">
        <h1>Adventure</h1>
        <span className="seed-shown">
          Logged in as <b>{me.displayName}</b>
        </span>
        <button className="btn" type="button" disabled={creating || channel.status !== 'open'} onClick={create}>
          New game
        </button>
        <button className="btn" type="button" onClick={onLogOut}>
          Log out
        </button>
      </header>
      <main className="site-page">
        {problem === null ? null : (
          <p className="problem" role="alert">
            {problem}
          </p>
        )}

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
                          {/* [Q56, 63] Waiting, started (with "Your turn" at the front on your turn) or finished. */}
                          {game.phase === 'finished' ? (
                            resultOf(game)
                          ) : (
                            <>
                              {game.yourTurn ? <span className="highlight">Your turn · </span> : null}
                              {game.gameMaster === me.userId ? 'You are the game master' : `Game master: ${game.gameMasterName}`} ·{' '}
                              {game.phase === 'setup' ? `waiting for players, ${game.seatsTaken} of ${game.seatsTotal}` : 'started'}
                              {endsOf(game)}
                            </>
                          )}
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
                          {endsOf(game)}
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

/** [Q56, 63] "Finished · Bea won", "Finished · Bea and Cal share the win" or "Ended by the game master". */
function resultOf(game: GameSummary): string {
  const result = game.result;
  if (result?.ending === 'game_master') return 'Ended by the game master';
  const names = result?.winners ?? [];
  if (names.length === 0) return 'Finished';
  if (names.length === 1) return `Finished · ${names[0] ?? ''} won`;
  return `Finished · ${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''} share the win`;
}
