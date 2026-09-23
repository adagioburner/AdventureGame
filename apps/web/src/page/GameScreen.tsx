import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameEvent, GameState, NodeId, PathPreview, PlayerId, Point, TurnAction } from '@adventure/core';
import { createMoveModeController, type EnterRefusal, type MoveModeState } from '../interaction/moveMode.ts';
import type { Pick } from '../interaction/picking.ts';
import { HOTSEAT_MODE, type HotseatGame, type PlayedTurn } from '../modes/hotseat.ts';
import { position } from '../render/geometry.ts';
import type { LoadedArt } from '../render/pixi/textures.ts';
import type { MapScene, Walker } from '../render/sceneModel.ts';
import { EndCard, ResultCard } from './Cards.tsx';
import { journalEntry, type JournalEntry } from './journal.ts';
import { MapView, type MapHandle } from './MapView.tsx';
import { Players } from './Players.tsx';
import { TurnControls } from './TurnControls.tsx';
import { TurnLog } from './TurnLog.tsx';

/** How long End Turn's walk takes per step, the die tumbles, and a notice stays up. */
export const timing = { stepMs: 220, tumbleMs: 1100, noticeMs: 2200 };

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
  const handle = useRef<MapHandle | null>(null);
  const busy = inFlight !== null;

  const say = useCallback((text: string) => setNotice(text), []);
  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), timing.noticeMs);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const commit = useRef<(action: TurnAction) => void>(() => undefined);
  const controller = useMemo(
    () =>
      createMoveModeController({
        mode: HOTSEAT_MODE,
        localPlayers: new Set(game.state.players.map((player) => player.id)),
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
    const before = game.state;
    // The route End Turn committed stays drawn while the figure walks it.
    const planned =
      action.kind === 'move' && move.kind === 'previewing' ? { path: move.preview, waypoint: move.waypoint } : { path: null, waypoint: null };
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
        if (target.node !== null) say('Tap your figure, or Plan a move, before choosing where to go.');
        return;
      }
      const refused = controller.enter(clicked);
      if (refused !== null) refuse(refused);
      else setResult(null);
      return;
    }
    const node = target.node;
    if (node !== null) controller.choose(node, shift);
  };

  const plan = (): void => {
    if (active === undefined) return;
    const refused = controller.enter(active.id);
    if (refused !== null) refuse(refused);
    else setResult(null);
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
      screenOf: (node: number): Point | null => handle.current?.screenOf(node as NodeId) ?? null,
      setTiming: (next: Partial<typeof timing>) => Object.assign(timing, next),
    };
    (window as unknown as { __adventure?: typeof hooks }).__adventure = hooks;
  }, [game, shown, busy]);

  const path = inFlight !== null ? inFlight.path : move.kind === 'previewing' ? move.preview : null;
  const waypoint = inFlight !== null ? inFlight.waypoint : move.kind === 'idle' ? null : move.waypoint;

  return (
    <div className="game">
      <Players catalog={catalog} state={shown} />
      <TurnControls
        state={shown}
        move={move}
        waypointArmed={armed}
        busy={busy}
        onPlan={plan}
        onCancel={() => controller.cancel()}
        onArmWaypoint={(on) => controller.armWaypoint(on)}
        onClearWaypoint={() => controller.clearWaypoint()}
        onEndTurn={() => controller.endTurn()}
        onRest={() => controller.rest()}
        onFind={findActive}
      />
      <div className={`log-host${logOpen ? ' open' : ''}`}>
        <TurnLog entries={entries} mapSeed={game.setup.map.seed} diceSeed={game.setup.diceSeed} onClose={onCloseLog} />
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
          onTap={onTap}
          onReady={(ready) => {
            handle.current = ready;
          }}
        />
        {notice === null ? null : (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {result === null ? null : (
          <ResultCard catalog={catalog} turn={result.turn} rolling={result.rolling} onClose={() => setResult(null)} />
        )}
        {shown.status === 'finished' && endOpen && inFlight === null ? (
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function find<T extends GameEvent['type']>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}
