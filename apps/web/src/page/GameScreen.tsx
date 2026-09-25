import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  previewPath,
  type GameEvent,
  type GameState,
  type NodeId,
  type PathPreview,
  type PlayerId,
  type PlayerState,
  type Point,
  type TurnAction,
} from '@adventure/core';
import { createMoveModeController, type EnterRefusal, type MoveModeState } from '../interaction/moveMode.ts';
import type { Pick } from '../interaction/picking.ts';
import type { PlayedTurn } from '../modes/hotseat.ts';
import type { PlayedChange, PlaySource, PlayUpdate } from '../modes/play.ts';
import { position } from '../render/geometry.ts';
import type { LoadedArt } from '../render/pixi/textures.ts';
import type { FigureCue, MapScene, Walker } from '../render/sceneModel.ts';
import { ClaimNotice, EndCard, ResultCard } from './Cards.tsx';
import { isUnguardedClaim, journalEntry, type JournalEntry } from './journal.ts';
import { MapView, type MapHandle } from './MapView.tsx';
import { Players } from './Players.tsx';
import { TurnControls } from './TurnControls.tsx';
import { TurnLog } from './TurnLog.tsx';

/** The page's phone layout, as `index.html` switches to it. */
export const PHONE = '(max-width: 899px)';

/**
 * How long End Turn's walk takes per step, the die tumbles, a notice stays up,
 * and an unguarded claim's notice takes to fade in, stays up (2 seconds, his
 * pick) and takes to fade out; and how long a computer's die card stays up
 * (3 seconds, Q42).
 */
export const timing = { stepMs: 220, tumbleMs: 1100, noticeMs: 2200, appearMs: 200, claimMs: 2000, fadeMs: 500, computerCardMs: 3000 };

interface GameScreenProps {
  readonly art: LoadedArt;
  readonly scene: MapScene;
  readonly play: PlaySource;
  readonly logOpen: boolean;
  /** [Q54, 31 and 33] Online, the players with no connection. */
  readonly away?: ReadonlySet<PlayerId> | undefined;
  /** [Q54, 31 and 33] Online, what the game shown waits on when someone is away; `null` when nobody is. */
  readonly waitingOn?: ((state: GameState) => string | null) | undefined;
  /** [Q56, 71] Online, the connection to the server is down and being brought back. */
  readonly offline?: boolean;
  /** [Q56, 58] Online, the message board, shown where the turn log is while it is open. */
  readonly board?: ReactNode;
  /** [Q56, 61] What the end card's button reads: "New game" unless given. */
  readonly newGameLabel?: string;
  onCloseLog(): void;
  onNewGame(): void;
}

/** The route a turn's walk is shown along: the one drawn when it was committed. */
interface Planned {
  readonly path: PathPreview | null;
  readonly waypoint: NodeId | null;
}

/**
 * One game on the §7.1 UI: a hotseat game (§7.2), with no out-of-turn
 * planning, or a stored game the server plays (`play`).
 *
 * End Turn plays out in three beats — the figure walks the steps the engine
 * says it walked, the die tumbles if a guard was faced, then the new state is
 * shown and the next seat's controls come up. The engine has resolved the
 * whole turn before the first beat; the beats only reveal it. Turns are shown
 * one after another, in the order `play` reports them.
 */
export function GameScreen({
  art,
  scene,
  play: source,
  logOpen,
  away,
  waitingOn,
  offline = false,
  board = null,
  newGameLabel,
  onCloseLog,
  onNewGame,
}: GameScreenProps) {
  const catalog = art.catalog;
  const [shown, setShown] = useState<GameState>(source.state);
  const [move, setMove] = useState<MoveModeState>({ kind: 'idle' });
  const [armed, setArmed] = useState(false);
  const [walker, setWalker] = useState<Walker | null>(null);
  const [inFlight, setInFlight] = useState<{ path: PathPreview | null; waypoint: NodeId | null } | null>(null);
  const [result, setResult] = useState<{ turn: PlayedTurn; rolling: boolean } | null>(null);
  const [entries, setEntries] = useState<readonly JournalEntry[]>(() => journalOf(source.history));
  const [notice, setNotice] = useState<string | null>(null);
  const [endOpen, setEndOpen] = useState(true);
  // Whether the player planning has picked their figure up; until they do,
  // the current player's figure blinks, even over a route saved from their
  // last turn.
  const [engaged, setEngaged] = useState(false);
  const [planner, setPlanner] = useState<PlayerId | null>(null);
  // [Andrei, 2026-09-25] Q57: the map either follows the players on turn or
  // stays where the viewer put it, and the Track button says which. It is
  // pressed when a game opens (76).
  const [tracking, setTracking] = useState(true);
  const handle = useRef<MapHandle | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const busy = inFlight !== null;
  // Online, a turn this page committed that the server has not played yet.
  const [awaiting, setAwaiting] = useState(false);

  const say = useCallback((text: string) => setNotice(text), []);
  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), timing.noticeMs);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // [Andrei, 2026-09-24] "the unguarded poi should produce a card that fades
  // itself. The guarded POI produce a card with a die roll that has an ok
  // button": an unguarded claim's notice has no OK and goes once it has faded.
  useEffect(() => {
    if (result === null || result.rolling || !isUnguardedClaim(result.turn)) return;
    const timer = window.setTimeout(() => setResult(null), timing.claimMs + timing.fadeMs);
    return () => window.clearTimeout(timer);
  }, [result]);
  // [Andrei, 2026-09-24] Q42: "the computer's die panel closes itself, pressing
  // OK is not necessary". OK still closes it sooner. [Q56, 50] Online, so does every other player's:
  // only a card of this page's own player waits for OK.
  useEffect(() => {
    if (result === null || result.rolling || isUnguardedClaim(result.turn)) return;
    if (source.localPlayers.has(result.turn.player)) return;
    const timer = window.setTimeout(() => setResult(null), timing.computerCardMs);
    return () => window.clearTimeout(timer);
  }, [result, source]);
  const locateFigure = useCallback((player: PlayerId) => handle.current?.screenOfFigure(player) ?? null, []);

  const commit = useRef<(action: TurnAction) => void>(() => undefined);
  /** Commit a turn to `play`, keeping `planned` to walk it along when it comes back. */
  const play = useRef<(action: TurnAction, planned: Planned) => void>(() => undefined);
  /** The route of the turn this page committed last, until that turn is shown. */
  const committed = useRef<{ readonly turn: number; readonly planned: Planned } | null>(null);
  const controller = useMemo(
    () =>
      createMoveModeController({
        mode: source.mode,
        localPlayers: source.localPlayers,
        commit: (action) => commit.current(action),
      }),
    [source],
  );
  // [Q56, 53] Online, the route being drawn is saved on the server as it is
  // drawn: what was sent last, until the game shows it saved.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    const sync = (): void => {
      setMove(controller.state);
      setArmed(controller.waypointArmed);
      setEngaged(controller.engaged);
      setPlanner(controller.planner);
      // [Q57, 73] Picking a figure up, or changing its route, is planning: Track unpresses.
      if (controller.engaged) setTracking(false);
      const save = source.savePlan;
      const who = controller.planner;
      if (save === null || who === null) return;
      const saved = savedRouteKey(source.state, who);
      if (sent.current === saved) sent.current = null;
      const now = controller.state;
      if (!controller.engaged || now.kind !== 'previewing') return;
      const key = routeKey(now.path, now.waypoint);
      if (key === saved || key === sent.current) return;
      if (save(who, now.path, now.waypoint)) sent.current = key;
    };
    const unsubscribe = controller.subscribe(sync);
    controller.setGame(source.state);
    sync();
    return unsubscribe;
  }, [controller, source]);

  commit.current = (action) => {
    // The route End Turn committed stays drawn while the figure walks it.
    const planned =
      action.kind === 'move' && move.kind === 'previewing' ? { path: move.preview, waypoint: move.waypoint } : { path: null, waypoint: null };
    play.current(action, planned);
  };
  play.current = (action, planned) => {
    committed.current = { turn: source.state.turn.number, planned };
    try {
      source.commit(action);
    } catch (error) {
      committed.current = null;
      say(error instanceof Error ? error.message : String(error));
      controller.setGame(source.state);
      return;
    }
    // Online the turn comes back once the server has played it; until then
    // its route stays drawn and nothing else can be committed.
    if (committed.current !== null) {
      setInFlight(planned);
      setAwaiting(true);
    }
  };

  // Every update `play` reports is shown in turn: a turn plays out before the
  // next one starts, and a change that is not a turn just shows the new state.
  const queue = useRef<PlayUpdate[]>([]);
  const showing = useRef(false);
  const show = useRef<(update: PlayUpdate) => Promise<void>>(async () => undefined);
  show.current = async (update) => {
    if (update.kind === 'refused') {
      // What this page committed was not played: its controls come back.
      if (committed.current !== null) {
        committed.current = null;
        setInFlight(null);
        setAwaiting(false);
      }
      controller.setGame(source.state);
      if (update.reason !== null) say(update.reason);
      return;
    }
    const { before, after, turn, movedOn = false } = update.change;
    if (turn === null || update.shown === 'caught_up') {
      // [Q54, 32] A turn missed while the connection was down is in the log,
      // and the map shows where it left everyone, with no walk.
      if (turn !== null) setEntries((current) => [journalEntry(turn, before, movedOn), ...current]);
      const mine = committed.current;
      if (turn !== null && mine !== null && mine.turn <= before.turn.number) {
        committed.current = null;
        setInFlight(null);
        setAwaiting(false);
      }
      setShown(after);
      controller.setGame(after);
      if (after.status === 'finished') setEndOpen(true);
      return;
    }
    const mine = committed.current;
    if (mine !== null && mine.turn <= before.turn.number) {
      committed.current = null;
      setAwaiting(false);
    }
    setResult(null);
    // [Q56, 50] A turn this page did not commit, another player's online, is
    // walked along its own route, drawn as their End turn drew it.
    setInFlight(
      mine !== null && mine.turn === before.turn.number
        ? mine.planned
        : { path: routeOf(before, turn.action), waypoint: turn.action.kind === 'move' ? (turn.action.waypoint ?? null) : null },
    );
    // Whatever happens while it plays out, the turn has been played: the
    // page must end up showing it, never stuck part-way.
    await playOut(turn, before).catch(() => undefined);
    setWalker(null);
    setShown(turn.after);
    setEntries((current) => [journalEntry(turn, before, movedOn), ...current]);
    setInFlight(null);
    controller.setGame(turn.after);
    if (turn.after.status === 'finished') {
      setEndOpen(true);
      return;
    }
    // [Q56, 55] A player the game master moved on is told so, whenever it happens.
    if (movedOn && source.localPlayers.has(turn.player) && source.mode.allowOutOfTurnPlanning) {
      say('The game master moved you on.');
      return;
    }
    // [Q56, 52] Online, the notice reads "Your turn" on the page of the player whose turn it is.
    const next = turn.after.players[turn.after.turn.activeSeat - 1];
    if (next === undefined) return;
    say(source.mode.allowOutOfTurnPlanning && source.localPlayers.has(next.id) ? 'Your turn' : `${next.name}’s turn`);
  };
  useEffect(() => {
    const drain = async (): Promise<void> => {
      if (showing.current) return;
      showing.current = true;
      for (let update = queue.current.shift(); update !== undefined; update = queue.current.shift()) await show.current(update);
      showing.current = false;
    };
    const unsubscribe = source.subscribe((update) => {
      queue.current.push(update);
      void drain();
    });
    return () => {
      unsubscribe();
      queue.current = [];
    };
  }, [source]);

  /** The walk, then the die: what End Turn shows before the result is revealed. */
  const playOut = async (turn: PlayedTurn, before: GameState): Promise<void> => {
    const moved = find(turn.events, 'moved');
    if (moved !== undefined && moved.resolution.walked.length > 0) {
      const nodes = [moved.resolution.from, ...moved.resolution.walked].map((node) => position(before.map.graph, node));
      await walk(turn.player, nodes, setWalker);
    }
    const interacted = find(turn.events, 'interacted');
    if (interacted === undefined || interacted.resolution.reward === null) return;
    if (interacted.resolution.roll !== null) {
      setResult({ turn, rolling: true });
      await sleep(timing.tumbleMs);
    }
    setResult({ turn, rolling: false });
  };

  // [Andrei, 2026-09-24] Q42: a computer's turn starts with it thinking for its
  // seat's time, while its figure blinks, and then plays out like a person's
  // End turn: its route drawn, the walk, the die. Leaving the game stops it.
  useEffect(() => {
    const computer = source.computer;
    if (computer === null || busy || shown !== source.state || shown.status !== 'in_progress') return;
    const player = shown.players[shown.turn.activeSeat - 1];
    if (player === undefined || !source.thinksFor(player)) return;
    const cancel = { aborted: false };
    computer.chooseAction(shown, player.id, cancel).then(
      (action) => {
        if (!cancel.aborted) play.current(action, { path: routeOf(shown, action), waypoint: null });
      },
      (error: unknown) => say(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      cancel.aborted = true;
    };
  }, [source, shown, busy, say]);

  // [Andrei, 2026-09-24] "we need to center the map on the current player's
  // figure at the beginning of each turn, both human and AI" (Q46): the map
  // glides there at the zoom it already has, from the first turn on. After an
  // unguarded claim it waits until the claim's notice has faded, since the
  // notice rides on the figure that made the claim. [Q57, 74] Only while Track
  // is pressed; on one device it presses itself at the start of every turn,
  // since a new person is at the screen (77).
  const centeredTurn = useRef<number | null>(null);
  useEffect(() => {
    if (!mapReady || busy || shown.status !== 'in_progress') return;
    if (result !== null && isUnguardedClaim(result.turn)) return;
    if (centeredTurn.current === shown.turn.number) return;
    const player = shown.players[shown.turn.activeSeat - 1];
    if (player === undefined) return;
    centeredTurn.current = shown.turn.number;
    if (source.mode.allowOutOfTurnPlanning && !tracking) return;
    setTracking(true);
    handle.current?.glideTo(player.position);
  }, [mapReady, busy, shown, result, source, tracking]);

  const refuse = (why: EnterRefusal): void => {
    const active = shown.players[shown.turn.activeSeat - 1];
    if (why === 'not_your_turn' && active !== undefined) say(`It is ${active.name}’s turn. In hot seat nobody plans out of turn.`);
  };

  const active = shown.players[shown.turn.activeSeat - 1];
  const online = source.mode.allowOutOfTurnPlanning;
  // [Q56, 48 and 49] Online, a turn that is not this page's player's: they
  // watch it, and can plan their own next move meanwhile.
  const othersTurn = online && active !== undefined && !source.localPlayers.has(active.id);
  /** Who Plan a move plans for: the player on turn on one device, this page's own player online. */
  const planFor = online ? shown.players.find((player) => source.localPlayers.has(player.id)) : active;
  const canPlan = online ? planFor !== undefined : active?.control !== 'ai';
  const onTap = (target: Pick, shift: boolean): void => {
    if (busy || shown.status !== 'in_progress') return;
    if (controller.state.kind === 'idle') {
      // On one device the figure on turn is the one picked up where figures
      // stand together; online it is this page's own.
      const clicked = online
        ? (target.players.find((player) => source.localPlayers.has(player)) ?? target.players[0])
        : (target.players.find((player) => player === active?.id) ?? target.players[0]);
      if (clicked === undefined) {
        if (target.node !== null && canPlan) say('Tap your figure, or Plan a move, before choosing where to go.');
        return;
      }
      const refused = controller.enter(clicked);
      if (refused !== null) return refuse(refused);
      setResult(null);
      return;
    }
    // Tapping your own figure while a route is up picks it up; it does not
    // make its own node the destination.
    const planning = controller.planner;
    if (planning !== null && target.players.includes(planning)) {
      controller.engage();
      return;
    }
    const node = target.node;
    if (node === null) return;
    controller.choose(node, shift);
  };

  const plan = (): void => {
    if (planFor === undefined) return;
    const refused = controller.enter(planFor.id);
    if (refused !== null) return refuse(refused);
    setResult(null);
    // A phone shows the whole map too small to find a figure or tap a node,
    // so planning from the button there starts close in on the player.
    if (window.matchMedia(PHONE).matches) handle.current?.centerOn(planFor.position);
  };
  const findActive = (): void => {
    if (active === undefined) return;
    setTracking(false);
    handle.current?.centerOn(active.position);
  };
  /**
   * [Q57, 74 and 75] Pressing Track closes planning, keeping the route, and
   * glides the map to the figure walking or else the player on turn; pressing
   * it again unpresses it.
   */
  const pressTrack = (): void => {
    if (tracking) {
      setTracking(false);
      return;
    }
    controller.putDown();
    setTracking(true);
    handle.current?.track(active?.position ?? null);
  };
  /** [Q57, 76] End turn and Rest press Track, without moving the map, so the walk and the turns after it are watched. */
  const endTurn = (rest: boolean): void => {
    if (rest) controller.rest();
    else controller.endTurn();
    if (!controller.engaged) setTracking(true);
  };
  /** Cancel puts the route down, and online clears the saved one too ([Q56, 53]). */
  const cancel = useRef<() => void>(() => undefined);
  cancel.current = () => {
    const who = controller.planner;
    controller.cancel();
    const save = source.savePlan;
    if (save === null || who === null) return;
    const empty = routeKey([], null);
    if (savedRouteKey(source.state, who) === empty && (sent.current === null || sent.current === empty)) return;
    if (save(who, [], null)) sent.current = empty;
  };
  // [Q56, 54] The game master's Move on, asked first, for a person on turn.
  const moveOn = source.moveOn;
  const onMoveOn =
    moveOn !== null && othersTurn && active !== undefined && active.control === 'human'
      ? () => {
          if (!window.confirm(`Play ${active.name}’s saved route now? With none saved, ${active.name} rests.`)) return;
          try {
            moveOn(active);
          } catch (error) {
            say(error instanceof Error ? error.message : String(error));
          }
        }
      : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A read-only window for the screenshot scripts and browser checks: where a
  // node is on screen, and the game as the engine holds it.
  useEffect(() => {
    const hooks = {
      state: () => source.state,
      shown: () => shown,
      diceSeed: source.diceSeed,
      busy: () => busy,
      thinking: () => !busy && shown === source.state && shown.status === 'in_progress' && active !== undefined && source.thinksFor(active),
      move: () => controller.state,
      planner: () => (controller.engaged ? controller.planner : null),
      tracking: () => tracking,
      screenOf: (node: number): Point | null => handle.current?.screenOf(node as NodeId) ?? null,
      figureOf: (player: string): Point | null => handle.current?.screenOfFigure(player as PlayerId) ?? null,
      setTiming: (next: Partial<typeof timing>) => Object.assign(timing, next),
    };
    (window as unknown as { __adventure?: typeof hooks }).__adventure = hooks;
  }, [source, controller, shown, busy, active, tracking]);

  const path = inFlight !== null ? inFlight.path : move.kind === 'previewing' ? move.preview : null;
  // A committed or walking route is the player on turn's; a route being
  // planned is its planner's, online perhaps someone waiting for their turn
  // ([Q56, 49]), so it starts at their figure.
  const pathFrom = inFlight !== null || planner === null ? active?.position : shown.players.find((player) => player.id === planner)?.position;
  const waypoint = inFlight !== null ? inFlight.waypoint : move.kind === 'idle' ? null : move.waypoint;
  const cue: FigureCue =
    shown.status !== 'in_progress' || busy
      ? 'none'
      : move.kind !== 'idle' && engaged && planner === active?.id
        ? 'selected'
        : 'blink';
  // [Q56, 49] Online, a figure picked up out of turn is highlighted as on its own turn.
  const plannerShown =
    shown.status === 'in_progress' && !busy && move.kind !== 'idle' && engaged && planner !== active?.id ? planner : null;

  return (
    <div className="game">
      <Players catalog={catalog} state={shown} away={away} />
      <TurnControls
        state={shown}
        move={move}
        waypointArmed={armed}
        busy={busy}
        awaiting={awaiting}
        thinkingMs={thinkingMsOf(source, active)}
        waiting={waitingOn?.(shown) ?? null}
        othersTurn={othersTurn}
        canPlan={canPlan}
        offline={offline}
        onMoveOn={onMoveOn}
        onPlan={plan}
        onCancel={() => cancel.current()}
        onArmWaypoint={(on) => controller.armWaypoint(on)}
        onClearWaypoint={() => controller.clearWaypoint()}
        onEndTurn={() => endTurn(false)}
        onRest={() => endTurn(true)}
        onFind={findActive}
      />
      <div className={`log-host${logOpen || board !== null ? ' open' : ''}`}>
        {board ?? <TurnLog entries={entries} map={source.map} diceSeed={source.diceSeed} onClose={onCloseLog} />}
      </div>
      <main className="stage">
        <MapView
          art={art}
          map={source.map}
          scene={scene}
          state={shown}
          path={path}
          pathFrom={pathFrom ?? null}
          waypoint={waypoint}
          walker={walker}
          cue={cue}
          planner={plannerShown}
          onTap={onTap}
          tracking={tracking}
          onTrack={shown.status === 'in_progress' ? pressTrack : undefined}
          onMoved={() => setTracking(false)}
          onReady={(ready) => {
            handle.current = ready;
            setMapReady(ready !== null);
          }}
        />
        {notice === null ? null : (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {result === null ? null : isUnguardedClaim(result.turn) ? (
          <ClaimNotice
            key={result.turn.after.turn.number}
            turn={result.turn}
            locate={locateFigure}
            stayMs={timing.claimMs}
            appearMs={timing.appearMs}
            fadeMs={timing.fadeMs}
          />
        ) : (
          <ResultCard catalog={catalog} turn={result.turn} rolling={result.rolling} onClose={() => setResult(null)} />
        )}
        {/* The winning turn's own card comes first; OK on it brings up the end. */}
        {shown.status === 'finished' && endOpen && inFlight === null && result === null ? (
          <EndCard catalog={catalog} state={shown} newGameLabel={newGameLabel} onNewGame={onNewGame} onClose={() => setEndOpen(false)} />
        ) : null}
      </main>
    </div>
  );
}

/** The turn log's entries for the turns played before the screen opened, newest first. */
function journalOf(history: readonly PlayedChange[]): JournalEntry[] {
  return history.flatMap(({ before, turn, movedOn = false }) => (turn === null ? [] : [journalEntry(turn, before, movedOn)])).reverse();
}

/** A route as the page compares routes: its steps and its waypoint. */
function routeKey(path: readonly NodeId[], waypoint: NodeId | null): string {
  return `${path.join(' ')}|${path.length === 0 ? '' : (waypoint ?? '')}`;
}

/** The route `player` has saved in `state`. */
function savedRouteKey(state: GameState, player: PlayerId): string {
  const saved = state.players.find((candidate) => candidate.id === player)?.plannedPath ?? null;
  return routeKey(saved?.path ?? [], saved?.waypoint ?? null);
}

/** How long the player on turn thinks, for a computer seat; `null` for a person. */
function thinkingMsOf(source: PlaySource, active: PlayerState | undefined): number | null {
  const seconds = active === undefined ? null : source.thinkingSecondsOf(active);
  return seconds === null ? null : seconds * 1000;
}

/** Walk a figure along `nodes` (world units), one road at a time. */
function walk(player: PlayerId, nodes: readonly Point[], show: (walker: Walker) => void): Promise<void> {
  const steps = nodes.length - 1;
  const total = steps * timing.stepMs;
  return new Promise((resolve) => {
    if (steps <= 0 || total <= 0) {
      resolve();
      return;
    }
    const start = performance.now();
    const frame = (now: number): void => {
      // A frame's timestamp can be a little earlier than `start`.
      const t = Math.min(1, Math.max(0, (now - start) / total));
      const along = t * steps;
      const index = Math.min(steps - 1, Math.floor(along));
      const a = nodes[index] as Point;
      const b = nodes[index + 1] as Point;
      const f = along - index;
      show({ player, at: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f } });
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

/** The computer's route as a person's End turn would show it: §7's colours for this turn. */
function routeOf(state: GameState, action: TurnAction): PathPreview | null {
  const player = state.players[state.turn.activeSeat - 1];
  if (action.kind !== 'move' || action.path.length === 0 || player === undefined) return null;
  return previewPath(state.map.graph, player.position, action.path, state.turn.allowance, player.stats.stamina, state.map.ruleset.config);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function find<T extends GameEvent['type']>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}
