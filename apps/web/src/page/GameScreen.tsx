import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { previewPath, type GameEvent, type GameState, type NodeId, type PathPreview, type PlayerId, type Point, type TurnAction } from '@adventure/core';
import { createMoveModeController, type EnterRefusal, type MoveModeState } from '../interaction/moveMode.ts';
import type { Pick } from '../interaction/picking.ts';
import { hotseatComputer } from '../modes/computer.ts';
import { HOTSEAT_MODE, type HotseatGame, type PlayedTurn } from '../modes/hotseat.ts';
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
const PHONE = '(max-width: 899px)';

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
  readonly game: HotseatGame;
  readonly logOpen: boolean;
  onCloseLog(): void;
  onNewGame(): void;
}

/**
 * One hotseat game (§7.2): the §7.1 UI with no out-of-turn planning.
 *
 * End Turn plays out in three beats — the figure walks the steps the engine
 * says it walked, the die tumbles if a guard was faced, then the new state is
 * shown and the next seat's controls come up. The engine has resolved the
 * whole turn before the first beat; the beats only reveal it.
 */
export function GameScreen({ art, scene, game, logOpen, onCloseLog, onNewGame }: GameScreenProps) {
  const catalog = art.catalog;
  const [shown, setShown] = useState<GameState>(game.state);
  const [move, setMove] = useState<MoveModeState>({ kind: 'idle' });
  const [armed, setArmed] = useState(false);
  const [walker, setWalker] = useState<Walker | null>(null);
  const [inFlight, setInFlight] = useState<{ path: PathPreview | null; waypoint: NodeId | null } | null>(null);
  const [result, setResult] = useState<{ turn: PlayedTurn; rolling: boolean } | null>(null);
  const [entries, setEntries] = useState<readonly JournalEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [endOpen, setEndOpen] = useState(true);
  // The turn in which the current player picked their figure up; until they
  // do, it blinks, even over a route saved from their last turn.
  const [engagedTurn, setEngagedTurn] = useState<number | null>(null);
  const handle = useRef<MapHandle | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const busy = inFlight !== null;
  const computer = useMemo(() => hotseatComputer(game), [game]);

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
  // OK is not necessary". OK still closes it sooner.
  useEffect(() => {
    if (result === null || result.rolling || isUnguardedClaim(result.turn)) return;
    if (result.turn.after.players.find((player) => player.id === result.turn.player)?.control !== 'ai') return;
    const timer = window.setTimeout(() => setResult(null), timing.computerCardMs);
    return () => window.clearTimeout(timer);
  }, [result]);
  const locateFigure = useCallback((player: PlayerId) => handle.current?.screenOfFigure(player) ?? null, []);

  const commit = useRef<(action: TurnAction) => void>(() => undefined);
  /** Play a turn, then show it: the walk along `planned`, the die, the new state. */
  const play = useRef<(action: TurnAction, planned: { path: PathPreview | null; waypoint: NodeId | null }) => void>(() => undefined);
  const controller = useMemo(
    () =>
      createMoveModeController({
        mode: HOTSEAT_MODE,
        // A computer seat is not this screen's to plan for: its saved route
        // is never brought back as a preview, and its figure cannot be picked up.
        localPlayers: new Set(game.state.players.filter((player) => player.control === 'human').map((player) => player.id)),
        commit: (action) => commit.current(action),
      }),
    [game],
  );
  useEffect(() => {
    const sync = (): void => {
      setMove(controller.state);
      setArmed(controller.waypointArmed);
    };
    const unsubscribe = controller.subscribe(sync);
    controller.setGame(game.state);
    sync();
    return unsubscribe;
  }, [controller, game]);

  commit.current = (action) => {
    // The route End Turn committed stays drawn while the figure walks it.
    const planned =
      action.kind === 'move' && move.kind === 'previewing' ? { path: move.preview, waypoint: move.waypoint } : { path: null, waypoint: null };
    play.current(action, planned);
  };
  play.current = (action, planned) => {
    const before = game.state;
    let turn: PlayedTurn;
    try {
      turn = game.play(action);
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
      controller.setGame(game.state);
      return;
    }
    setResult(null);
    setInFlight(planned);
    // Whatever happens while it plays out, the turn has been played: the
    // page must end up showing it, never stuck part-way.
    void playOut(turn, before)
      .catch(() => undefined)
      .then(() => {
        setWalker(null);
        setShown(turn.after);
        setEntries((current) => [journalEntry(turn, before), ...current]);
        setInFlight(null);
        controller.setGame(turn.after);
        if (turn.after.status === 'finished') {
          setEndOpen(true);
          return;
        }
        const next = turn.after.players[turn.after.turn.activeSeat - 1];
        if (next !== undefined) say(`${next.name}’s turn`);
      });
  };

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
    if (busy || shown !== game.state || shown.status !== 'in_progress') return;
    const player = shown.players[shown.turn.activeSeat - 1];
    if (player === undefined || player.control !== 'ai') return;
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
  }, [computer, game, shown, busy, say]);

  // [Andrei, 2026-09-24] "we need to center the map on the current player's
  // figure at the beginning of each turn, both human and AI" (Q46): the map
  // glides there at the zoom it already has, from the first turn on. After an
  // unguarded claim it waits until the claim's notice has faded, since the
  // notice rides on the figure that made the claim.
  const centeredTurn = useRef<number | null>(null);
  useEffect(() => {
    if (!mapReady || busy || shown.status !== 'in_progress') return;
    if (result !== null && isUnguardedClaim(result.turn)) return;
    if (centeredTurn.current === shown.turn.number) return;
    const player = shown.players[shown.turn.activeSeat - 1];
    if (player === undefined) return;
    centeredTurn.current = shown.turn.number;
    handle.current?.glideTo(player.position);
  }, [mapReady, busy, shown, result]);

  const refuse = (why: EnterRefusal): void => {
    const active = shown.players[shown.turn.activeSeat - 1];
    if (why === 'not_your_turn' && active !== undefined) say(`It is ${active.name}’s turn. In hot seat nobody plans out of turn.`);
  };

  const active = shown.players[shown.turn.activeSeat - 1];
  const onTap = (target: Pick, shift: boolean): void => {
    if (busy || shown.status !== 'in_progress') return;
    if (controller.state.kind === 'idle') {
      const clicked = target.players.find((player) => player === active?.id) ?? target.players[0];
      if (clicked === undefined) {
        if (target.node !== null && active?.control !== 'ai') say('Tap your figure, or Plan a move, before choosing where to go.');
        return;
      }
      const refused = controller.enter(clicked);
      if (refused !== null) return refuse(refused);
      setResult(null);
      setEngagedTurn(shown.turn.number);
      return;
    }
    // Tapping your own figure while a route is up picks it up; it does not
    // make its own node the destination.
    if (active !== undefined && target.players.includes(active.id)) {
      setEngagedTurn(shown.turn.number);
      return;
    }
    const node = target.node;
    if (node === null) return;
    setEngagedTurn(shown.turn.number);
    controller.choose(node, shift);
  };

  const plan = (): void => {
    if (active === undefined) return;
    const refused = controller.enter(active.id);
    if (refused !== null) return refuse(refused);
    setResult(null);
    setEngagedTurn(shown.turn.number);
    // A phone shows the whole map too small to find a figure or tap a node,
    // so planning from the button there starts close in on the player.
    if (window.matchMedia(PHONE).matches) findActive();
  };
  const findActive = (): void => {
    if (active !== undefined) handle.current?.centerOn(active.position);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') controller.cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  // A read-only window for the screenshot scripts and browser checks: where a
  // node is on screen, and the game as the engine holds it.
  useEffect(() => {
    const hooks = {
      state: () => game.state,
      shown: () => shown,
      diceSeed: game.setup.diceSeed,
      busy: () => busy,
      thinking: () => !busy && shown === game.state && shown.status === 'in_progress' && active?.control === 'ai',
      screenOf: (node: number): Point | null => handle.current?.screenOf(node as NodeId) ?? null,
      figureOf: (player: string): Point | null => handle.current?.screenOfFigure(player as PlayerId) ?? null,
      setTiming: (next: Partial<typeof timing>) => Object.assign(timing, next),
    };
    (window as unknown as { __adventure?: typeof hooks }).__adventure = hooks;
  }, [game, shown, busy, active]);

  const path = inFlight !== null ? inFlight.path : move.kind === 'previewing' ? move.preview : null;
  const waypoint = inFlight !== null ? inFlight.waypoint : move.kind === 'idle' ? null : move.waypoint;
  const cue: FigureCue =
    shown.status !== 'in_progress' || busy
      ? 'none'
      : move.kind !== 'idle' && engagedTurn === shown.turn.number
        ? 'selected'
        : 'blink';

  return (
    <div className="game">
      <Players catalog={catalog} state={shown} />
      <TurnControls
        state={shown}
        move={move}
        waypointArmed={armed}
        busy={busy}
        thinkingMs={active?.control === 'ai' ? (game.setup.seats[active.seat - 1]?.thinkingSeconds ?? 0) * 1000 : null}
        onPlan={plan}
        onCancel={() => controller.cancel()}
        onArmWaypoint={(on) => controller.armWaypoint(on)}
        onClearWaypoint={() => controller.clearWaypoint()}
        onEndTurn={() => controller.endTurn()}
        onRest={() => controller.rest()}
        onFind={findActive}
      />
      <div className={`log-host${logOpen ? ' open' : ''}`}>
        <TurnLog entries={entries} map={game.setup.map} diceSeed={game.setup.diceSeed} onClose={onCloseLog} />
      </div>
      <main className="stage">
        <MapView
          art={art}
          map={game.setup.map}
          scene={scene}
          state={shown}
          path={path}
          waypoint={waypoint}
          walker={walker}
          cue={cue}
          onTap={onTap}
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
          <EndCard catalog={catalog} state={shown} onNewGame={onNewGame} onClose={() => setEndOpen(false)} />
        ) : null}
      </main>
    </div>
  );
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
