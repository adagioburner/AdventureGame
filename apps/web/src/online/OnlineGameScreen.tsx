import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createGameState, startingNodeFor, type GameId, type GameMap, type GameState, type PlayerId, type UserId } from '@adventure/core';
import { DAY_MS, isOpenSeat, LONGEST_LIFETIME_DAYS, type GameRecord, type SetupState } from '@adventure/protocol';
import { MissedRecords, OnlineGame } from '../modes/online.ts';
import { onlinePlay, type OnlinePlay } from '../modes/play.ts';
import { GameScreen, PHONE } from '../page/GameScreen.tsx';
import { MapView } from '../page/MapView.tsx';
import { randomSeed } from '../page/seed.ts';
import { buildMapScene, type MapScene } from '../render/sceneModel.ts';
import { DEFAULT_RULESET } from '@adventure/config';
import { atlasOf, type ArtCatalog } from '../art/catalog.ts';
import { fromOnlineSetup, type LocalLimits, type LocalSetup } from '../setup/local.ts';
import { SetupPanel } from '../setup/SetupPanel.tsx';
import { sentence } from '../setup/text.ts';
import { socketUrl, type Login } from './api.ts';
import { endsLabel, useMinuteClock } from './ends.ts';
import { mapForSeed, useArt, useMapFor } from './assets.ts';
import { MessageBoard } from './MessageBoard.tsx';
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
 * then the game itself, played on the server (§7.1, §12.1) and shown on the
 * same play screen as a game on one device.
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
  const [removed, setRemoved] = useState(false);
  const [seedDraft, setSeedDraft] = useState('');
  // Play: the game once its records have arrived, the people away, and the log.
  const [play, setPlay] = useState<OnlinePlay | null>(null);
  const [away, setAway] = useState<readonly UserId[]>([]);
  // [Q56, 58] The turn log or the message board, in the one place either
  // opens; on a phone, over the map, and neither while both are closed.
  const [panel, setPanel] = useState<'log' | 'board' | null>(() => (phone() ? null : 'log'));
  // The latest setup and started state, for the history that follows them.
  const latest = useRef<{ setup: SetupState | null; started: GameState | null; play: OnlinePlay | null }>({
    setup: null,
    started: null,
    play: null,
  });
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
          latest.current.setup = message.setup;
          latest.current.play?.setSetup(message.setup);
          setSetup(message.setup);
          return;
        case 'setup.declined':
          setDeclined(true);
          return;
        case 'game.state':
          // Once play has opened, a reconnect's records bring it up to date instead.
          if (latest.current.play !== null) return;
          latest.current.started = message.state;
          setGame(message.state);
          return;
        case 'game.history': {
          const current = latest.current.play;
          if (current === null) {
            const { setup: now, started } = latest.current;
            if (now === null || started === null) return;
            const opened = OnlineGame.open(now, started, message.records);
            const next = onlinePlay({ setup: now, me: me.userId, ...opened, send: (sent) => channel.send(sent) });
            latest.current.play = next;
            setPlay(next);
            return;
          }
          // [Q54, 32] Back after a dropped connection: the turns missed meanwhile.
          // A turn this page sent that is not among them never arrived, and
          // can be sent again.
          receive(current, message.records, 'caught_up');
          current.refused(null);
          return;
        }
        case 'game.played':
          if (latest.current.play !== null) receive(latest.current.play, [message.record], 'played');
          return;
        case 'game.presence':
          setAway(message.away);
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
          else if (message.code === 'game_removed') setRemoved(true);
          else if (latest.current.play !== null) latest.current.play.refused(sentence(message.message), message.code);
          else setNotice(sentence(message.message));
          return;
        default:
          return;
      }
    },
    onRefused,
  );

  /** Applies records the server sent, skipping any already applied; a gap means one was missed, and the game is loaded again. */
  const receive = (current: OnlinePlay, records: readonly GameRecord[], shown: 'played' | 'caught_up'): void => {
    for (const record of records) {
      if (record.seq <= current.lastSeq) continue;
      try {
        current.receive(record, shown);
      } catch (error) {
        if (!(error instanceof MissedRecords)) throw error;
        channel.restart();
        return;
      }
    }
  };

  // The game as the server has it, as each change arrives: for the tab title,
  // the board and the top bar, which do not wait for a turn to play out.
  const [live, setLive] = useState<GameState | null>(null);
  useEffect(() => {
    if (play === null) return;
    setLive(play.state);
    return play.subscribe(() => setLive(play.state));
  }, [play]);
  // [Q54, 34] The tab reads "Your turn · Adventure" while it is this player's turn.
  const liveActive = live === null ? undefined : live.players[live.turn.activeSeat - 1];
  const yourTurn = live !== null && live.status === 'in_progress' && liveActive !== undefined && play !== null && play.localPlayers.has(liveActive.id);
  useEffect(() => {
    if (!yourTurn) return;
    document.title = 'Your turn · Adventure';
    return () => {
      document.title = 'Adventure';
    };
  }, [yourTurn]);

  // [Q54, 31 and 33] Who is away, as players, and what the game waits on when it waits on them.
  const awayPlayers = useMemo<ReadonlySet<PlayerId>>(() => {
    const users = new Set(away);
    return new Set((setup?.seats ?? []).filter((seat) => seat.userId !== null && users.has(seat.userId)).map((seat) => seat.playerId));
  }, [away, setup]);
  const waitingOn = useCallback(
    (state: GameState): string | null => {
      if (setup === null || state.status !== 'in_progress') return null;
      const active = state.players[state.turn.activeSeat - 1];
      if (active === undefined) return null;
      const users = new Set(away);
      if (active.control === 'ai') {
        // A computer's move is thought on the game master's page.
        if (setup.gameMaster === me.userId || !users.has(setup.gameMaster)) return null;
        const master = setup.seats.find((seat) => seat.userId === setup.gameMaster)?.name;
        return master === undefined ? 'Waiting for the game master to come back.' : `Waiting for the game master, ${master}, to come back.`;
      }
      const holder = setup.seats.find((seat) => seat.playerId === active.id)?.userId ?? null;
      if (holder === null || holder === me.userId || !users.has(holder)) return null;
      return `Waiting for ${active.name}, who is away. The game master can move ${active.name} on.`;
    },
    [setup, away, me.userId],
  );
  const now = useMinuteClock();

  // [Q56, 57 and 59] The seat this person holds, if any: they can post, and resign while a person plays it.
  const mySeat = setup?.seats.find((seat) => seat.userId === me.userId) ?? null;
  const myPlayer = mySeat === null || live === null ? undefined : live.players.find((player) => player.id === mySeat.playerId);
  const inProgress = live !== null && live.status === 'in_progress';

  // [Q56, 60] Posts not yet seen on this device, counted on the Messages button while the board is closed.
  const posts = live?.messageBoard ?? [];
  const [seen, setSeen] = useState(() => readSeen(gameId));
  useEffect(() => {
    if (panel !== 'board' || posts.length <= seen) return;
    setSeen(posts.length);
    writeSeen(gameId, posts.length);
  }, [panel, posts.length, seen, gameId]);
  const unread = panel === 'board' ? 0 : posts.slice(seen).filter((post) => post.author !== mySeat?.playerId).length;

  // [Q56, 56] The game master's panel under the end time.
  const [endsOpen, setEndsOpen] = useState(false);
  const endsMenu = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!endsOpen) return;
    const close = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || endsMenu.current?.contains(event.target) !== true) setEndsOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [endsOpen]);

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
    : removed
      ? 'This game has ended and been removed.'
      : setup?.phase === 'cancelled'
      ? 'The game master cancelled this game.'
      : setup?.phase === 'expired'
      ? 'This game ran out of time before it started.'
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

  // [Q55, 46] When the game ends, until it has.
  const ends = setup === null || setup.closedAt !== null ? null : endsLabel(setup.endsAt, now);
  const endsShown = ends === null ? null : <span className={`ends${ends.soon ? ' soon' : ''}`}>{ends.text}</span>;

  if (play !== null && status === null && art !== null && scene !== null && setup !== null) {
    const offline = channel.status !== 'open';
    const longest = setup.createdAt + LONGEST_LIFETIME_DAYS * DAY_MS;
    return (
      <div className="shell playing">
        <header className="bar">
          <h1>Adventure</h1>
          <span className="seed-shown">
            {setup.name} · Seed <code>{setup.mapSeed}</code>
          </span>
          {/* [Q56, 56] For the game master the end time opens Add a day and End the game. */}
          {isGameMaster && inProgress && endsShown !== null ? (
            <div className="ends-menu" ref={endsMenu}>
              <button className="btn ends-button" type="button" aria-expanded={endsOpen} onClick={() => setEndsOpen(!endsOpen)}>
                {endsShown}
              </button>
              {endsOpen ? (
                <div className="ends-panel" role="group" aria-label="The game’s end">
                  <button
                    className="btn"
                    type="button"
                    disabled={offline || setup.endsAt >= longest}
                    onClick={() => channel.send({ type: 'gm.extendLifetime', gameId })}
                  >
                    Add a day
                  </button>
                  {setup.endsAt >= longest ? <p className="muted">A game lasts at most {LONGEST_LIFETIME_DAYS} days.</p> : null}
                  <button
                    className="btn"
                    type="button"
                    disabled={offline}
                    onClick={() => {
                      if (!window.confirm('End the game now? It ends with no winner.')) return;
                      if (channel.send({ type: 'gm.endGame', gameId })) setEndsOpen(false);
                    }}
                  >
                    End the game
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            endsShown
          )}
          {/* [Q56, 57] Anyone whose seat a person still plays can resign it to the computer. */}
          {inProgress && myPlayer !== undefined && myPlayer.control === 'human' ? (
            <button
              className="btn"
              type="button"
              disabled={offline}
              onClick={() => {
                if (
                  !window.confirm(`Resign from this game? The computer plays ${myPlayer.name} from now on. You can still watch and post messages.`)
                ) {
                  return;
                }
                channel.send({ type: 'player.resign', gameId });
              }}
            >
              Resign
            </button>
          ) : null}
          <button className="btn" type="button" onClick={onBack}>
            Your games
          </button>
          <button
            className="btn side-toggle"
            type="button"
            aria-pressed={panel === 'log'}
            onClick={() => setPanel(panel === 'log' && phone() ? null : 'log')}
          >
            Turn log
          </button>
          <button
            className="btn side-toggle"
            type="button"
            aria-pressed={panel === 'board'}
            onClick={() => setPanel(panel === 'board' ? (phone() ? null : 'log') : 'board')}
          >
            {unread > 0 ? `Messages ${unread}` : 'Messages'}
          </button>
        </header>
        <GameScreen
          key={setup.gameId}
          art={art}
          scene={scene}
          play={play}
          logOpen={panel === 'log'}
          away={awayPlayers}
          waitingOn={waitingOn}
          offline={offline}
          board={
            panel === 'board' && live !== null ? (
              <MessageBoard
                catalog={art.catalog}
                posts={posts}
                players={live.players}
                now={now}
                onPost={mySeat === null ? null : (body) => channel.send({ type: 'board.post', gameId, body })}
                onClose={() => setPanel(null)}
              />
            ) : null
          }
          newGameLabel="Your games"
          onCloseLog={() => setPanel(null)}
          onNewGame={onBack}
        />
      </div>
    );
  }

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
        {endsShown}
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
          {game !== null ? null : (
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

function phone(): boolean {
  return window.matchMedia(PHONE).matches;
}

/** [Q56, 60] How many of a game's posts this device has shown; kept in the browser, and 0 where it cannot be. */
function readSeen(gameId: GameId): number {
  try {
    const stored = Number(window.localStorage.getItem(`adventure.postsSeen.${gameId}`));
    return Number.isFinite(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
}

function writeSeen(gameId: GameId, count: number): void {
  try {
    window.localStorage.setItem(`adventure.postsSeen.${gameId}`, String(count));
  } catch {
    // Without storage the count starts again on the next visit.
  }
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
