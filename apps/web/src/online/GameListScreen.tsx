import { useEffect, useState } from 'react';
import type { GameId } from '@adventure/core';
import type { GameSummary, SitePost, SitePostRefusal } from '@adventure/protocol';
import { BarMenu } from '../page/BarMenu.tsx';
import { GameTitle } from '../page/GameTitle.tsx';
import { RulesButton } from '../page/Rules.tsx';
import { socketUrl, type Login } from './api.ts';
import { sentence } from '../setup/text.ts';
import { endsLabel, useMinuteClock } from './ends.ts';
import { SiteBoard, type BoardView } from './SiteBoard.tsx';
import { useChannel } from './socket.ts';
import { TrashBin } from './TrashBin.tsx';

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
 * this device.
 *
 * [Q90, 310 to 314] The game master's finished games have a trash bin left
 * of Open, which deletes the game for everyone once they confirm.
 *
 * [Q300] The site's board is on this page too, beside the lists or below
 * them (`SiteBoard`), over the same socket.
 */
export function GameListScreen({ login, onOpen, onLogOut, onRefused }: GameListScreenProps) {
  const me = login.user;
  const [games, setGames] = useState<readonly GameSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardView | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const channel = useChannel(
    socketUrl('/api/lobby', login.token),
    (message) => {
      if (message.type === 'lobby.games') setGames(message.games);
      else if (message.type === 'lobby.created') onOpen(message.gameId);
      else if (message.type === 'lobby.board') setBoard(message);
      else if (message.type === 'lobby.posted') {
        setDraft('');
        setSending(false);
      } else if (message.type === 'lobby.postRefused') {
        setNotice(refusalNotice(message.reason));
        setSending(false);
      } else if (message.type === 'error') {
        // An answer to a post on its way is the board's; anything else is the page's.
        if (sending) {
          setNotice(sentence(message.message));
          setSending(false);
        } else setProblem(sentence(message.message));
        setCreating(false);
      }
    },
    onRefused,
  );
  // A post on its way when the socket dropped has no answer coming; its words stay in the box.
  useEffect(() => {
    if (channel.status !== 'open') setSending(false);
  }, [channel.status]);

  const create = (): void => {
    if (creating) return;
    setProblem(null);
    if (channel.send({ type: 'lobby.create', name: `${me.displayName}’s game` })) setCreating(true);
  };

  // [Q90, 311] Asks first, as End the game and Cancel do. The row leaves the
  // list when the server sends it again without the game.
  const remove = (game: GameSummary): void => {
    if (!window.confirm('Delete this game? It leaves everyone’s game list and cannot be opened again.')) return;
    setProblem(null);
    channel.send({ type: 'lobby.deleteGame', gameId: game.gameId });
  };

  // [Q300] The words stay in the box until the post is on the board.
  const sendPost = (): void => {
    setNotice(null);
    if (channel.send({ type: 'lobby.post', body: draft })) setSending(true);
  };
  // [Q300, 6] Asks first, as a game master's delete does.
  const deletePost = (post: SitePost): void => {
    if (!window.confirm(`Delete ${post.authorName}’s message? Its words are erased for everyone.`)) return;
    setProblem(null);
    channel.send({ type: 'lobby.deletePost', postId: post.id });
  };
  // [Q300, 11] Asks first, both ways.
  const blockPoster = (post: SitePost, blocked: boolean): void => {
    const question = blocked
      ? `Stop ${post.authorName} from posting on the board? They can still read it and play.`
      : `Let ${post.authorName} post on the board again?`;
    if (!window.confirm(question)) return;
    setProblem(null);
    channel.send({ type: 'lobby.blockPoster', userId: post.author, blocked });
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
        <GameTitle />
        <span className="seed-shown">
          Logged in as <b>{me.displayName}</b>
        </span>
        <BarMenu>
          <button className="btn" type="button" disabled={creating || channel.status !== 'open'} onClick={create}>
            New game
          </button>
          <button className="btn" type="button" onClick={onLogOut}>
            Log out
          </button>
          <RulesButton />
        </BarMenu>
      </header>
      <main className="site-page with-board">
        <div className="site-lists">
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
                                {/* [Q317, 6] "watching" for a game this user was let in to watch. */}
                                {game.watching
                                  ? 'watching'
                                  : game.phase === 'setup'
                                    ? `waiting for players, ${game.seatsTaken} of ${game.seatsTotal}`
                                    : 'started'}
                                {endsOf(game)}
                              </>
                            )}
                          </p>
                        </div>
                        {/* [Q90, 312 to 314] Every finished game of the game master's, left of Open. */}
                        {game.phase === 'finished' && game.gameMaster === me.userId ? (
                          <button
                            className="btn delete-game"
                            type="button"
                            aria-label={`Delete ${game.name}`}
                            title="Delete"
                            disabled={channel.status !== 'open'}
                            onClick={() => remove(game)}
                          >
                            <TrashBin />
                          </button>
                        ) : null}
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
        </div>
        <SiteBoard
          me={me.userId}
          board={board}
          now={now}
          draft={draft}
          onDraft={setDraft}
          sending={sending}
          connected={channel.status === 'open'}
          notice={notice}
          onSend={sendPost}
          onDelete={deletePost}
          onBlock={blockPoster}
        />
      </main>
    </div>
  );
}

/** [Q300, 9 and 10] The line over the box when a post was not put on the board. */
function refusalNotice(reason: SitePostRefusal): string {
  return reason === 'offensive' ? 'Not posted: it may be offensive.' : 'Not posted: messages can’t be checked right now. Try again later.';
}

/**
 * [Q56, 63] "Finished · Bea won" or "Finished · Bea and Cal share the win";
 * [Q85, 293] "Ended by the game master · Bea won" when the game master ended
 * it, and just "Ended by the game master" for one ended before it had a winner.
 */
function resultOf(game: GameSummary): string {
  const result = game.result;
  const how = result?.ending === 'game_master' ? 'Ended by the game master' : 'Finished';
  const names = result?.winners ?? [];
  if (names.length === 0) return how;
  if (names.length === 1) return `${how} · ${names[0] ?? ''} won`;
  return `${how} · ${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''} share the win`;
}
