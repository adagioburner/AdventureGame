import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { isClaimed, poiAt, poiRuntimeAt, type GameState } from '@adventure/core';
import type { MoveModeState } from '../interaction/moveMode.ts';

interface TurnControlsProps {
  readonly state: GameState;
  readonly move: MoveModeState;
  readonly waypointArmed: boolean;
  /** An End Turn is playing out: nothing can be pressed until it has. */
  readonly busy: boolean;
  /** Online, the turn this page committed is not played yet: the server has still to hear of it or answer. */
  readonly awaiting: boolean;
  /**
   * The computer's thinking time when the seat to move is a computer's, in
   * milliseconds; `null` for a person.
   */
  readonly thinkingMs: number | null;
  /**
   * [Q54, 31 and 33] Online, what the game waits on when the player on turn or
   * the game master is away: shown on the line above the buttons.
   */
  readonly waiting: string | null;
  /**
   * Online, the turn is someone else's (§7.1): this page can plan its own
   * next move but not end the turn ([Q56, 48]). Never on one device.
   */
  readonly othersTurn: boolean;
  /** Whether this page has a figure to plan for now. */
  readonly canPlan: boolean;
  /** [Q56, 71] The connection is down: Rest and End turn wait for it. */
  readonly offline: boolean;
  /** [Q56, 54] The game master's Move on for the person on turn; `null` when there is none to offer. */
  readonly onMoveOn: (() => void) | null;
  /** [Q85, 295 and 302] The game master's Resign for the person on turn, with Move on; `null` when there is none to offer. */
  readonly onResign: (() => void) | null;
  onPlan(): void;
  onCancel(): void;
  onArmWaypoint(armed: boolean): void;
  onClearWaypoint(): void;
  onEndTurn(): void;
  onRest(): void;
}

/**
 * §7.1's controls for the player whose turn it is: plan a route, End Turn,
 * Rest. Hotseat shows them to one player at a time (§7.2).
 *
 * The line above the buttons says what the next click does, and for a planned
 * route what it will cost — read off `previewPath`, never worked out here.
 */
export function TurnControls(props: TurnControlsProps) {
  const { state, move, waypointArmed, busy } = props;
  const player = state.players[state.turn.activeSeat - 1];
  if (state.status !== 'in_progress' || player === undefined) return null;

  const planning = move.kind !== 'idle';
  const rest = state.map.ruleset.config.movement.REST_STAMINA_GAIN;
  const here = poiAt(state.map, player.position);
  const runtime = poiRuntimeAt(state, player.position);
  const onGuard = here !== undefined && here.guard !== null && runtime !== undefined && !isClaimed(runtime);
  const planButtons = (
    <>
      {planning ? (
        <button className="btn" type="button" disabled={busy} onClick={props.onCancel}>
          Cancel
        </button>
      ) : (
        <button className="btn" type="button" disabled={busy} onClick={props.onPlan}>
          Plan a move
        </button>
      )}
      {planning ? (
        <button
          className="btn"
          type="button"
          disabled={busy}
          aria-pressed={waypointArmed}
          onClick={() => props.onArmWaypoint(!waypointArmed)}
        >
          Waypoint
        </button>
      ) : null}
      {planning && move.waypoint !== null ? (
        <button className="btn" type="button" disabled={busy} onClick={props.onClearWaypoint}>
          Clear waypoint
        </button>
      ) : null}
    </>
  );
  const bar =
    props.thinkingMs === null || busy || props.waiting !== null ? null : (
      <div className="thinking-bar" role="presentation">
        <i key={state.turn.number} style={{ animationDuration: `${props.thinkingMs}ms` }} />
      </div>
    );

  // [Q56, 48] Online, on someone else's turn: their name on the line, or the
  // computer thinking over its bar, as in hot seat; your own route can be
  // planned meanwhile ([Q56, 49]), and Rest and End turn wait for your turn.
  if (props.othersTurn) {
    // [Q58, 86] A computer's move this page thought of waits for the connection.
    const line = busy
      ? props.awaiting && props.offline && props.thinkingMs !== null
        ? 'Reconnecting to the server…'
        : `${player.name} is moving…`
      : (props.waiting ??
        (planning
          ? hint(move, waypointArmed, player.name, rest, onGuard, true)
          : props.thinkingMs !== null
            ? `${player.name} is thinking…`
            : props.offline
              ? 'Reconnecting to the server…'
              : props.canPlan
                ? `${player.name} is playing. You can plan your next move.`
                : `${player.name} is playing.`));
    return (
      <section className="controls" aria-label={`${player.name}’s turn`}>
        <div className="thinking">
          <p className="hint" aria-live="polite">
            {line}
          </p>
          {bar}
        </div>
        <div className="buttons">
          {props.canPlan ? planButtons : null}
          {props.onMoveOn === null && props.onResign === null ? null : (
            <PlayerMenu key={state.turn.number} name={player.name}>
              {props.onMoveOn === null ? null : (
                <button className="btn" type="button" disabled={busy || props.offline} onClick={props.onMoveOn}>
                  Move {player.name} on
                </button>
              )}
              {props.onResign === null ? null : (
                <button className="btn" type="button" disabled={busy || props.offline} onClick={props.onResign}>
                  Resign {player.name}
                </button>
              )}
            </PlayerMenu>
          )}
        </div>
      </section>
    );
  }

  // [Andrei, 2026-09-24] Q42: while a computer thinks, its name and a bar that
  // fills across its thinking time; Plan a move, Rest and End turn are hidden
  // until it has moved.
  if (props.thinkingMs !== null) {
    return (
      <section className="controls" aria-label={`${player.name}’s turn`}>
        <div className="thinking">
          <p className="hint" aria-live="polite">
            {busy ? `${player.name} is moving…` : (props.waiting ?? `${player.name} is thinking…`)}
          </p>
          {bar}
        </div>
        {/* [Q120, 475] Empty since Find went, and kept so the panel is as tall as before on a phone. */}
        <div className="buttons" />
      </section>
    );
  }

  // [Q56, 71] While the connection is down, a route can still be planned, and
  // Rest and End turn wait until it is back.
  return (
    <section className="controls" aria-label={`${player.name}’s turn`}>
      <p className="hint" aria-live="polite">
        {busy
          ? `${player.name} is moving…`
          : (props.waiting ?? (props.offline ? 'Reconnecting to the server…' : hint(move, waypointArmed, player.name, rest, onGuard, false)))}
      </p>
      <div className="buttons">
        {planButtons}
        <button className="btn" type="button" disabled={busy || props.offline} onClick={props.onRest}>
          Rest
        </button>
        <button className="btn primary" type="button" disabled={busy || props.offline} onClick={props.onEndTurn}>
          End turn
        </button>
      </div>
    </section>
  );
}

/**
 * [Q85, 302 and 304-307] The game master's actions on another person's turn
 * (Move on and Resign; Find left the list with the Find button, [Q120, 475])
 * in one "Bea ▾" button, so they never take a second row: its list opens
 * above it, and closes on a choice, a press elsewhere or when the turn passes
 * (keyed by the turn), as the Menu list does ([Q58, 84]).
 */
function PlayerMenu({ name, children }: { readonly name: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || menu.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  // The list starts at the button's left edge, moved left as far as it needs to stay on the screen.
  useLayoutEffect(() => {
    const box = list.current;
    if (!open || box === null) return;
    const { left, right } = box.getBoundingClientRect();
    box.style.left = `${Math.max(Math.min(0, window.innerWidth - 8 - right), 8 - left)}px`;
  }, [open]);

  return (
    <div className={`player-menu${open ? ' open' : ''}`} ref={menu}>
      <button className="btn" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {name} ▾
      </button>
      {open ? (
        <div className="player-actions" ref={list} onClick={() => setOpen(false)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The line above the buttons while a route is planned. `later` for a route
 * planned out of turn online ([Q56, 49]), which is coloured for the player's
 * next turn and says so.
 */
function hint(move: MoveModeState, armed: boolean, name: string, rest: number, onGuard: boolean, later: boolean): string {
  const stay = onGuard ? 'End turn with no route stays here and fights the guard again' : 'End turn with no route stays put';
  const when = later ? 'on your next turn' : 'this turn';
  switch (move.kind) {
    case 'idle':
      return `${name}: tap your figure (or Plan a move), then where to go. ${stay}. Rest gains ${rest} stamina.`;
    case 'selecting':
      return armed
        ? 'Tap the space to route through.'
        : 'Tap where to go. Shift-click, or Waypoint then a tap, routes through a space on the way.';
    case 'previewing': {
      if (armed) return 'Tap the space to route through.';
      const { preview } = move;
      const steps = preview.steps.length;
      if (steps === 0) return later ? 'No route: you stay where you are.' : `Staying here this turn. ${stay}.`;
      if (preview.reachableStepCount === 0) {
        const route = steps === 1 ? 'this step' : `the first of these ${steps} steps`;
        return later
          ? `Not even ${route} is affordable on your next turn. Rest gains ${rest} stamina.`
          : `Not even ${route} is affordable this turn. Rest gains ${rest} stamina; End turn walks nothing and keeps the route for next turn.`;
      }
      const cost = preview.totalStaminaCost === 0 ? 'no stamina' : `${preview.totalStaminaCost} stamina`;
      const reach = preview.destinationReachable
        ? `All ${steps} step${steps === 1 ? '' : 's'} ${when}, for ${cost}.`
        : `${preview.reachableStepCount} of ${steps} steps ${when}, for ${cost}; the rest waits for ${later ? 'the turn after' : 'next turn'}.`;
      return `${reach} Green is free, yellow costs stamina, grey is out of reach ${when}.`;
    }
  }
}
