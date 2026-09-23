import { assertNever, RuleViolationError } from '../errors.ts';
import type { DieRoll, GameAction, GameEvent, TurnAction } from '../action.ts';
import { poiAt } from '../gamemap.ts';
import type { NodeId, PlayerId, Seat } from '../ids.ts';
import type { BoardPost } from '../messageboard.ts';
import type { ControlMode, PlannedPath, PlayerState, PlayerStats } from '../player.ts';
import { isClaimed, type PoiRuntimeState } from '../poi.ts';
import { activePlayer, playerById, playerBySeat, poiRuntimeAt, type GameState } from '../state.ts';
import { refreshAllowance, resolveMovement } from './movement.ts';
import { resolveInteraction } from './interaction.ts';
import { checkVictory } from './victory.ts';

/**
 * Supplies `GUARD_DIE` rolls. The engine never owns randomness: the session
 * layer injects a server-side stream (kept separate from the public map seed so
 * clients cannot precompute rolls — no hidden information applies to the map
 * and rewards, §1, not to future dice), and MCTS injects its own.
 */
export interface DiceSource {
  roll(): DieRoll;
}

export interface ActionOutcome {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * The single entry point for changing a game: pure, deterministic given
 * `dice`, and the only writer of `GameState`.
 *
 * Everything else — the session layer, the AI, the balancing harness, replays —
 * drives the game exclusively through this function, which is what lets MCTS
 * (§9) search real game states rather than an approximation of them.
 *
 * Sequence for a turn action (§7, §8): resolve movement → if the turn ends on
 * an unclaimed POI, interact automatically → if a gold reward was claimed,
 * re-evaluate the win condition (§1) → end the turn and advance to the next
 * seat, refreshing that player's allowance (§7).
 *
 * The input state is never mutated. `map` is carried across by reference — it
 * never changes during play — so a new state copies only the small mutable
 * part, which is what makes cloning cheap enough for MCTS to do in a loop.
 *
 * Every action but `post_message` requires a game in progress; posting is not a
 * game move and stays available once a game has finished.
 */
export function applyAction(state: GameState, action: GameAction, dice: DiceSource): ActionOutcome {
  switch (action.kind) {
    case 'move':
    case 'rest':
      return applyTurnAction(state, action, dice);
    case 'force_turn':
      return applyTurnAction(state, plannedTurnActionFor(state, action.player), dice);
    case 'set_control':
      return applySetControl(state, action.player, action.control);
    case 'resign':
      return applyResignation(state, action.player);
    case 'post_message': {
      const post: BoardPost = {
        id: action.id,
        gameId: state.id,
        author: action.player,
        body: action.body,
        postedAt: action.postedAt,
      };
      return {
        state: { ...state, messageBoard: [...state.messageBoard, post] },
        events: [{ type: 'message_posted', post }],
      };
    }
    default:
      return assertNever(action, 'GameAction');
  }
}

/**
 * [SOURCE §2, chat] Turn order is fixed at game start and never changes, so
 * this is a plain cycle through seats. Resigned players are not skipped — an AI
 * takes over and keeps playing their seat (§7.3).
 */
export function nextSeat(state: GameState): Seat {
  const count = state.players.length;
  if (count === 0) throw new RuleViolationError('a game with no players has no next seat');
  return (state.turn.activeSeat % count) + 1;
}

/* -------------------------------------------------------------------------- */
/*  A turn                                                                     */
/* -------------------------------------------------------------------------- */

function applyTurnAction(state: GameState, action: TurnAction, dice: DiceSource): ActionOutcome {
  const player = requireActivePlayer(state, action.player);
  const events: GameEvent[] = [];

  let next =
    action.kind === 'move'
      ? applyMove(state, player, action.path, action.waypoint, events)
      : applyRest(state, player, events);

  // §7/§8: the interaction is a property of where the *turn* ends, so a POI
  // walked over on the way is not interacted with, and resting on one is not
  // either — [SOURCE §7, chat] rest is "no movement/interaction".
  if (action.kind === 'move') next = applyArrival(next, player.id, dice, events);

  return { state: endTurn(next, player.id, events), events };
}

function applyMove(
  state: GameState,
  player: PlayerState,
  path: readonly NodeId[],
  plannedWaypoint: NodeId | null | undefined,
  events: GameEvent[],
): GameState {
  const resolution = resolveMovement(
    state.map.graph,
    player.position,
    path,
    state.turn.allowance,
    player.stats.stamina,
    state.map.ruleset.config,
  );

  // [SOURCE §4] "An unfinished path is saved for the next turn and can still be
  // changed." The waypoint survives only while it is still ahead of the player:
  // the one this move was planned through, or else the one already saved.
  const remainder = resolution.remainder;
  const waypoint = plannedWaypoint !== undefined ? plannedWaypoint : (player.plannedPath?.waypoint ?? null);
  const plannedPath: PlannedPath | null =
    remainder.length === 0
      ? null
      : {
          path: remainder,
          waypoint: waypoint !== null && remainder.includes(waypoint) ? waypoint : null,
        };

  events.push({ type: 'moved', player: player.id, resolution });

  return withPlayer(state, player.id, (current) => ({
    ...current,
    position: resolution.to,
    stats: { ...current.stats, stamina: current.stats.stamina - resolution.staminaSpent },
    plannedPath,
  }));
}

function applyRest(state: GameState, player: PlayerState, events: GameEvent[]): GameState {
  const gain = state.map.ruleset.config.movement.REST_STAMINA_GAIN;
  events.push({ type: 'rested', player: player.id, staminaGained: gain });
  return withPlayer(state, player.id, (current) => ({
    ...current,
    stats: { ...current.stats, stamina: current.stats.stamina + gain },
  }));
}

/**
 * §8's automatic interaction, and the win check §1 hangs off it.
 *
 * The die is drawn only when a guard is actually faced, so a `DiceSource`
 * advances once per guard attempt and not once per turn — which is what lets a
 * replay of a game reproduce its rolls from the stream alone.
 */
function applyArrival(state: GameState, playerId: PlayerId, dice: DiceSource, events: GameEvent[]): GameState {
  const player = playerById(state, playerId);
  const node = player.position;
  const poi = poiAt(state.map, node);
  const runtime = poiRuntimeAt(state, node);
  if (poi === undefined || runtime === undefined || isClaimed(runtime)) return state;

  const resolution = resolveInteraction(state, node, player.stats, poi.guard === null ? null : dice.roll());
  events.push({ type: 'interacted', player: playerId, resolution });
  if (!resolution.claimed || resolution.reward === null) return state;

  const reward = resolution.reward;
  const claimed = withPoiRuntime(
    withPlayer(state, playerId, (current) => ({
      ...current,
      // §6/§4.1: the seven stats are the seven reward kinds, so claiming a
      // reward is one addition, whatever the kind.
      stats: addToStat(current.stats, reward.kind, reward.units),
    })),
    node,
    { claimedBy: playerId, claimedOnTurn: state.turn.number },
  );

  // [SOURCE §2, chat] The win condition is evaluated "each time a POI with gold
  // is claimed" — nothing else can move a lead or the unclaimed total.
  if (reward.kind !== 'gold') return claimed;

  const winners = checkVictory(claimed);
  if (winners.length === 0) return claimed;

  events.push({ type: 'game_won', winners });
  return { ...claimed, status: 'finished', winners };
}

/**
 * End the turn and hand over (§7). A finished game hands over to nobody, so
 * `game_won` is the last event of the game and no `turn_ended` follows it.
 */
function endTurn(state: GameState, playerId: PlayerId, events: GameEvent[]): GameState {
  if (state.status === 'finished') return state;

  const seat = nextSeat(state);
  events.push({ type: 'turn_ended', player: playerId, nextSeat: seat });
  return {
    ...state,
    turn: {
      number: state.turn.number + 1,
      activeSeat: seat,
      allowance: refreshAllowance(playerBySeat(state, seat).stats),
    },
  };
}

/**
 * [SOURCE §4] "the game master can force their currently-planned move (or force
 * a rest, if none was planned)". Which of the two it is, is decided here rather
 * than by the caller, so the GM's control and a player's own End Turn go down
 * the identical path and can never resolve differently.
 */
function plannedTurnActionFor(state: GameState, playerId: PlayerId): TurnAction {
  const planned = playerById(state, playerId).plannedPath;
  if (planned === null || planned.path.length === 0) return { kind: 'rest', player: playerId };
  return { kind: 'move', player: playerId, path: planned.path };
}

/* -------------------------------------------------------------------------- */
/*  Out-of-turn actions                                                        */
/* -------------------------------------------------------------------------- */

function applySetControl(state: GameState, playerId: PlayerId, control: ControlMode): ActionOutcome {
  requireInProgress(state);
  return {
    state: withPlayer(state, playerId, (current) => ({ ...current, control })),
    events: [{ type: 'control_changed', player: playerId, control }],
  };
}

/**
 * [SOURCE §4] "A human player may resign at any time; an AI takes over so play
 * continues." So resigning both records the resignation and flips control, and
 * [SOURCE §4, chat] only a game master may hand it back — which is a
 * `set_control` and not anything this action can undo.
 *
 * The seat keeps its place in turn order; `nextSeat` skips nobody.
 */
function applyResignation(state: GameState, playerId: PlayerId): ActionOutcome {
  requireInProgress(state);
  return {
    state: withPlayer(state, playerId, (current) => ({ ...current, resigned: true, control: 'ai' })),
    events: [{ type: 'resigned', player: playerId }],
  };
}

/* -------------------------------------------------------------------------- */
/*  State helpers — the only places a new `GameState` is built                 */
/* -------------------------------------------------------------------------- */

function requireInProgress(state: GameState): void {
  if (state.status !== 'in_progress') {
    throw new RuleViolationError(`game ${state.id} is ${state.status}, not in progress`);
  }
}

/**
 * The engine checks *whose turn it is* — a rule — and never *who is allowed to
 * ask*, which is the session layer's job (§7.3 game-master authority).
 */
function requireActivePlayer(state: GameState, playerId: PlayerId): PlayerState {
  requireInProgress(state);
  const player = activePlayer(state);
  if (player.id !== playerId) {
    throw new RuleViolationError(`it is seat ${state.turn.activeSeat}'s turn, not ${playerId}'s`);
  }
  return player;
}

function withPlayer(
  state: GameState,
  playerId: PlayerId,
  change: (player: PlayerState) => PlayerState,
): GameState {
  let found = false;
  const players = state.players.map((player) => {
    if (player.id !== playerId) return player;
    found = true;
    return change(player);
  });
  if (!found) throw new RuleViolationError(`no such player ${playerId}`);
  return { ...state, players };
}

function withPoiRuntime(state: GameState, node: NodeId, runtime: PoiRuntimeState): GameState {
  const index = state.map.poiByNode.get(node);
  if (index === undefined) throw new RuleViolationError(`node ${node} holds no POI`);
  const poiRuntime = state.poiRuntime.map((current, at) => (at === index ? runtime : current));
  return { ...state, poiRuntime };
}

function addToStat(stats: PlayerStats, kind: keyof PlayerStats, units: number): PlayerStats {
  return { ...stats, [kind]: stats[kind] + units };
}
