import { isClaimed, poiAt, poiRuntimeAt, type GameState } from '@adventure/core';
import type { MoveModeState } from '../interaction/moveMode.ts';

interface TurnControlsProps {
  readonly state: GameState;
  readonly move: MoveModeState;
  readonly waypointArmed: boolean;
  /** An End Turn is playing out: nothing can be pressed until it has. */
  readonly busy: boolean;
  onPlan(): void;
  onCancel(): void;
  onArmWaypoint(armed: boolean): void;
  onClearWaypoint(): void;
  onEndTurn(): void;
  onRest(): void;
  onFind(): void;
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

  return (
    <section className="controls" aria-label={`${player.name}’s turn`}>
      <p className="hint" aria-live="polite">
        {busy ? `${player.name} is moving…` : hint(move, waypointArmed, player.name, rest, onGuard)}
      </p>
      <div className="buttons">
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
        <button className="btn" type="button" disabled={busy} onClick={props.onRest}>
          Rest
        </button>
        <button className="btn primary" type="button" disabled={busy} onClick={props.onEndTurn}>
          End turn
        </button>
        <button className="btn ghost" type="button" onClick={props.onFind} aria-label={`Show ${player.name} on the map`}>
          Find {player.name}
        </button>
      </div>
    </section>
  );
}

function hint(move: MoveModeState, armed: boolean, name: string, rest: number, onGuard: boolean): string {
  const stay = onGuard ? 'End turn with no route stays here and fights the guard again' : 'End turn with no route stays put';
  switch (move.kind) {
    case 'idle':
      return `${name}: tap your figure (or Plan a move), then where to go. ${stay}. Rest gains ${rest} stamina.`;
    case 'selecting':
      return armed
        ? 'Tap the node to route through.'
        : 'Tap where to go. Shift-click, or Waypoint then a tap, routes through a node on the way.';
    case 'previewing': {
      if (armed) return 'Tap the node to route through.';
      const { preview } = move;
      const steps = preview.steps.length;
      if (steps === 0) return `Staying here this turn. ${stay}.`;
      if (preview.reachableStepCount === 0) {
        const route = steps === 1 ? 'this step' : `the first of these ${steps} steps`;
        return `Not even ${route} is affordable this turn. Rest gains ${rest} stamina; End turn walks nothing and keeps the route for next turn.`;
      }
      const cost = preview.totalStaminaCost === 0 ? 'no stamina' : `${preview.totalStaminaCost} stamina`;
      const reach = preview.destinationReachable
        ? `All ${steps} step${steps === 1 ? '' : 's'} this turn, for ${cost}.`
        : `${preview.reachableStepCount} of ${steps} steps this turn, for ${cost}; the rest waits for next turn.`;
      return `${reach} Green is free, yellow costs stamina, grey is out of reach this turn.`;
    }
  }
}
