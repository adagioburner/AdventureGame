import {
  previewPath,
  refreshAllowance,
  routeVia,
  type GameState,
  type NodeId,
  type PathPreview,
  type PlayerId,
  type PlayerState,
  type TurnAction,
} from '@adventure/core';
import type { UiModeConfig } from '../modes/hotseat.ts';

/**
 * [SOURCE §4] "Clicking the player's own highlighted character enters moving
 * mode; clicking a destination node highlights the shortest path (weighted
 * terrain cost, §5.1) with a thick dotted line and an isometric cross at the
 * destination. Shift-click sets an intermediate waypoint when more than one
 * path exists."
 *
 * A small explicit state machine rather than scattered flags, because the same
 * states behave differently in the two modes (§7.1 vs §7.2).
 */
export type MoveModeState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'selecting'; readonly waypoint: NodeId | null }
  | {
      readonly kind: 'previewing';
      readonly destination: NodeId;
      readonly waypoint: NodeId | null;
      /** The route, excluding the player's own node: what End Turn sends. */
      readonly path: readonly NodeId[];
      readonly preview: PathPreview;
    };

/** Why `enter()` said no, in words the page can show. */
export type EnterRefusal = 'not_your_turn' | 'not_local' | 'game_over';

export interface MoveModeController {
  readonly state: MoveModeState;
  /** The player whose route is being edited, or `null` when none is. */
  readonly planner: PlayerId | null;
  /**
   * Whether the planner has picked their figure up: entered moving mode, or
   * chosen a node, since the route was last brought back or put down. A
   * route brought back at the start of a turn is shown, but not picked up.
   */
  readonly engaged: boolean;
  /**
   * Touch screens have no shift key, so the waypoint can also be armed with a
   * button: while armed, the next node chosen becomes the waypoint.
   */
  readonly waypointArmed: boolean;
  /**
   * The game changed. Recomputes the preview from the new state, and at a
   * turn boundary starts the new turn from the player's saved plan (§4), since
   * colours "reflect only what's achievable this turn".
   */
  setGame(game: GameState): void;
  /**
   * Enter moving mode for `player`, whose character was clicked. Refused when
   * that player is not this client's to plan for, or — with
   * `allowOutOfTurnPlanning: false`, which is hotseat (§7.2) — when it is not
   * their turn.
   */
  enter(player: PlayerId): EnterRefusal | null;
  /** The planner's own figure was tapped while their route is up: it is picked up. */
  engage(): void;
  /** A node was clicked; `shift` for a shift-click. */
  choose(node: NodeId, shift: boolean): void;
  selectDestination(node: NodeId): void;
  /** Sets the waypoint, or clears it when `node` already is the waypoint. */
  setWaypoint(node: NodeId): void;
  clearWaypoint(): void;
  armWaypoint(armed: boolean): void;
  cancel(): void;
  /**
   * [SOURCE §4] "'End Turn' commits the last-shown path; the character walks to
   * the destination or as far as it gets this turn. [...] An unfinished path is
   * saved for the next turn and can still be changed."
   *
   * With nothing shown it commits an empty path: the player stays where they
   * are, which on a guarded POI is §8's "remain stationed on the node" and
   * another roll at the guard.
   */
  endTurn(): void;
  /** [SOURCE §2] Rest instead: no movement, no interaction. */
  rest(): void;
  subscribe(listener: () => void): () => void;
}

export interface MoveModeOptions {
  readonly mode: UiModeConfig;
  /**
   * The players this client plans for. Hotseat seats every player at one
   * screen, so it is all of them; online it is the one logged-in player.
   */
  readonly localPlayers: ReadonlySet<PlayerId>;
  /** Sends a committed turn: End Turn's move, or Rest. */
  readonly commit: (action: TurnAction) => void;
}

/**
 * The preview must come from `@adventure/core`'s `previewPath`, never from a
 * second implementation in the client.
 *
 * [SOURCE §4, chat] Colours reflect only what is achievable *this turn* and are
 * recalculated every turn as allowances refresh — so the controller recomputes
 * on every turn boundary, and grey is never cached or treated as "unreachable
 * forever" (resting always restores stamina).
 */
export interface PreviewSource {
  previewFor(destination: NodeId, waypoint: NodeId | null): PlannedRoute | null;
}

export interface PlannedRoute {
  readonly path: readonly NodeId[];
  readonly preview: PathPreview;
}

/**
 * Routes and colours for `player` in `game`: `routeVia`'s cheapest path
 * (through the waypoint, if any) and `previewPath`'s colours for it.
 *
 * The allowance is the turn's own for the player whose turn it is. A player
 * planning out of turn (§7.1, online only) will start their next turn with a
 * fresh allowance, `refreshAllowance` of their skills, so that is what their
 * preview is coloured against.
 */
export function gamePreviewSource(game: GameState, player: PlayerId): PreviewSource {
  const planner = playerIn(game, player);
  const config = game.map.ruleset.config;
  return {
    previewFor(destination, waypoint) {
      const path = routeVia(game.map.graph, planner.position, waypoint, destination, config);
      if (path === null) return null;
      return { path, preview: previewFor(game, planner, path) };
    },
  };
}

function previewFor(game: GameState, planner: PlayerState, path: readonly NodeId[]): PathPreview {
  const active = planner.seat === game.turn.activeSeat;
  const allowance = active ? game.turn.allowance : refreshAllowance(planner.stats);
  return previewPath(game.map.graph, planner.position, path, allowance, planner.stats.stamina, game.map.ruleset.config);
}

function playerIn(game: GameState, id: PlayerId): PlayerState {
  const found = game.players.find((player) => player.id === id);
  if (found === undefined) throw new RangeError(`no such player ${id}`);
  return found;
}

const IDLE: MoveModeState = { kind: 'idle' };

export function createMoveModeController(options: MoveModeOptions): MoveModeController {
  let game: GameState | null = null;
  let state: MoveModeState = IDLE;
  let planner: PlayerId | null = null;
  let armed = false;
  let engaged = false;
  /** Which turn `state` was planned in, so a new turn starts over. */
  let turnOf: number | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const set = (next: MoveModeState): void => {
    state = next;
    notify();
  };

  /** The route to `destination` through `waypoint`, as the rules colour it now. */
  const plan = (destination: NodeId, waypoint: NodeId | null): MoveModeState => {
    if (game === null || planner === null) return IDLE;
    const route = gamePreviewSource(game, planner).previewFor(destination, waypoint);
    if (route === null) return { kind: 'selecting', waypoint };
    return { kind: 'previewing', destination, waypoint, path: route.path, preview: route.preview };
  };

  /**
   * [SOURCE §4] "An unfinished path is saved for the next turn and can still be
   * changed": a turn opens on the saved plan, recoloured for this turn, so End
   * Turn carries on with it in one click.
   */
  const resume = (current: GameState): MoveModeState => {
    if (planner === null) return IDLE;
    const saved = playerIn(current, planner).plannedPath;
    if (saved === null || saved.path.length === 0) return IDLE;
    const destination = saved.path[saved.path.length - 1] as NodeId;
    return {
      kind: 'previewing',
      destination,
      waypoint: saved.waypoint,
      path: saved.path,
      preview: previewFor(current, playerIn(current, planner), saved.path),
    };
  };

  /** Who this client plans for when nobody has clicked a character yet. */
  const defaultPlanner = (current: GameState): PlayerId | null => {
    if (current.status !== 'in_progress') return null;
    const active = current.players[current.turn.activeSeat - 1];
    if (active !== undefined && options.localPlayers.has(active.id)) return active.id;
    if (!options.mode.allowOutOfTurnPlanning) return null;
    return current.players.find((player) => options.localPlayers.has(player.id))?.id ?? null;
  };

  const controller: MoveModeController = {
    get state() {
      return state;
    },
    get planner() {
      return planner;
    },
    get waypointArmed() {
      return armed;
    },
    get engaged() {
      return engaged;
    },

    setGame(next) {
      const before = game;
      const newTurn = turnOf !== next.turn.number;
      game = next;
      turnOf = next.turn.number;
      if (next.status !== 'in_progress') {
        planner = null;
        armed = false;
        engaged = false;
        return set(IDLE);
      }
      // [Q56, 51] Online, a route someone is planning out of turn carries on
      // through other players' turns; only the planner's own turn ending
      // (End Turn, Rest, or the game master moving them on) puts it down.
      const carried =
        newTurn &&
        options.mode.allowOutOfTurnPlanning &&
        engaged &&
        planner !== null &&
        state.kind !== 'idle' &&
        before !== null &&
        before.players[before.turn.activeSeat - 1]?.id !== planner &&
        playerIn(next, planner).control === 'human';
      if (newTurn && !carried) {
        planner = defaultPlanner(next);
        armed = false;
        engaged = false;
        return set(resume(next));
      }
      // [Q56, 53] A route not picked up is the saved one, which another of
      // this player's devices, or a Cancel from this one, may have changed.
      if (!engaged && planner !== null) return set(resume(next));
      // Same turn, new state (another player's move arriving, online), or a
      // route carried into a new turn: the route stands, its colours are
      // recomputed.
      if (state.kind === 'previewing') {
        const planned = playerIn(next, planner as PlayerId);
        return set({ ...state, preview: previewFor(next, planned, state.path) });
      }
      notify();
    },

    enter(player) {
      if (game === null || game.status !== 'in_progress') return 'game_over';
      if (!options.localPlayers.has(player)) return 'not_local';
      const seat = playerIn(game, player).seat;
      if (!options.mode.allowOutOfTurnPlanning && seat !== game.turn.activeSeat) return 'not_your_turn';
      if (planner !== player) {
        planner = player;
        state = resume(game);
      }
      engaged = true;
      if (state.kind === 'idle') set({ kind: 'selecting', waypoint: null });
      else notify();
      return null;
    },

    engage() {
      if (state.kind === 'idle' || engaged) return;
      engaged = true;
      notify();
    },

    choose(node, shift) {
      if (state.kind === 'idle') return;
      engaged = true;
      if (shift || armed) {
        armed = false;
        controller.setWaypoint(node);
      } else {
        controller.selectDestination(node);
      }
    },

    selectDestination(node) {
      if (state.kind === 'idle') return;
      set(plan(node, state.waypoint));
    },

    setWaypoint(node) {
      if (state.kind === 'idle') return;
      const waypoint = state.waypoint === node ? null : node;
      if (state.kind === 'selecting') return set({ kind: 'selecting', waypoint });
      set(plan(state.destination, waypoint));
    },

    clearWaypoint() {
      if (state.kind === 'idle' || state.waypoint === null) return;
      if (state.kind === 'selecting') return set({ kind: 'selecting', waypoint: null });
      set(plan(state.destination, null));
    },

    armWaypoint(on) {
      armed = on && state.kind !== 'idle';
      notify();
    },

    cancel() {
      armed = false;
      engaged = false;
      set(IDLE);
    },

    endTurn() {
      const who = activePlanner();
      if (who === null) return;
      const path = state.kind === 'previewing' ? state.path : [];
      const waypoint = state.kind === 'idle' ? null : state.waypoint;
      armed = false;
      engaged = false;
      state = IDLE;
      options.commit({ kind: 'move', player: who, path, waypoint: path.length === 0 ? null : waypoint });
    },

    rest() {
      const who = activePlanner();
      if (who === null) return;
      armed = false;
      engaged = false;
      state = IDLE;
      options.commit({ kind: 'rest', player: who });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  /** Only the player whose turn it is can commit one, in either mode. */
  function activePlanner(): PlayerId | null {
    if (game === null || game.status !== 'in_progress') return null;
    const active = game.players[game.turn.activeSeat - 1];
    if (active === undefined || !options.localPlayers.has(active.id)) return null;
    if (planner !== null && planner !== active.id) return null;
    return active.id;
  }

  return controller;
}
