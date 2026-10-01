import { assertNever, RuleViolationError } from '../errors.ts';
import type {
  DieRoll,
  ForceTurnAction,
  GameAction,
  GameEndReason,
  GameEvent,
  MoveAction,
  PlanAction,
  RestAction,
  TurnAction,
} from '../action.ts';
import { poiAt } from '../gamemap.ts';
import type { NodeId, PlayerId, Seat } from '../ids.ts';
import type { BoardPost } from '../messageboard.ts';
import type { ControlMode, PlannedPath, PlayerState, PlayerStats } from '../player.ts';
import { isClaimed, type PoiRuntimeState } from '../poi.ts';
import { activePlayer, playerById, playerBySeat, poiRuntimeAt, type GameState } from '../state.ts';
import { assertWalkable, refreshAllowance, resolveMovement } from './movement.ts';
import { resolveInteraction } from './interaction.ts';
import { respawnShortRewards } from './respawn.ts';
import { checkVictory, mostGold } from './victory.ts';

/**
 * Supplies `GUARD_DIE` rolls. The engine never owns randomness: the session
 * layer injects a server-side stream (kept separate from the public map seed so
 * clients cannot precompute rolls — no hidden information applies to the map
 * and rewards, §1, not to future dice), and MCTS injects its own.
 */
export interface DiceSource {
  roll(): DieRoll;
  /**
   * [Q135] A uniform whole number from 0 to `count - 1`: which of the far
   * empty sites a short skill comes back to. Drawn from the same stream as the
   * die, so it is as unpredictable online and replays with it on one device.
   */
  pick(count: number): number;
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
 * re-evaluate the win condition (§1) → bring back any speed or skill that has
 * run short (Q135) → end the turn and advance to the next seat, refreshing
 * that player's allowance (§7).
 *
 * The input state is never mutated. `map` is carried across by reference — it
 * never changes during play — so a new state copies only the small mutable
 * part, which is what makes cloning cheap enough for MCTS to do in a loop.
 *
 * Every action but `post_message` and `delete_message` requires a game in
 * progress; the board is not a game move and stays open once a game has
 * finished.
 */
export function applyAction(state: GameState, action: GameAction, dice: DiceSource): ActionOutcome {
  switch (action.kind) {
    case 'move':
    case 'rest':
      return applyTurnAction(state, action, dice);
    case 'force_turn':
      return applyTurnAction(state, forcedTurnAction(state, action), dice);
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
    case 'delete_message':
      return applyDeleteMessage(state, action.id);
    case 'plan':
      return applyPlan(state, action);
    case 'end_game':
      return applyEndGame(state, action.reason);
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
      : applyRest(state, player, action, events);

  // §7/§8: the interaction is a property of where the *turn* ends, so a POI
  // walked over on the way is not interacted with, and resting on one is not
  // either — [SOURCE §7, chat] rest is "no movement/interaction".
  if (action.kind === 'move') next = applyArrival(next, player.id, dice, events);
  // [Q135] Once the turn's claim is made, and only while the game goes on.
  if (next.status === 'in_progress') next = respawnShortRewards(next, dice, events);

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

function applyRest(state: GameState, player: PlayerState, action: RestAction, events: GameEvent[]): GameState {
  const gain = state.map.ruleset.config.movement.REST_STAMINA_GAIN;
  // [490] End turn's rest saves the route it could not start on.
  const plan = action.plan === undefined ? player.plannedPath : checkedPlan(state, player, action.plan.path, action.plan.waypoint);
  events.push({ type: 'rested', player: player.id, staminaGained: gain });
  return withPlayer(state, player.id, (current) => ({
    ...current,
    stats: { ...current.stats, stamina: current.stats.stamina + gain },
    plannedPath: plan,
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
  return { ...claimed, status: 'finished', winners, ending: 'won' };
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
export function plannedTurnActionFor(state: GameState, playerId: PlayerId): TurnAction {
  const planned = playerById(state, playerId).plannedPath;
  if (planned === null || planned.path.length === 0) return { kind: 'rest', player: playerId };
  return { kind: 'move', player: playerId, path: planned.path };
}

/** The turn a Move on plays: a rest when [491] it carries `rest`, else `plannedTurnActionFor`'s. */
export function forcedTurnAction(state: GameState, action: ForceTurnAction): TurnAction {
  return action.rest === true ? { kind: 'rest', player: action.player } : plannedTurnActionFor(state, action.player);
}

/**
 * [Andrei, 2026-09-30, 491] The game master's Move on plays what the player's
 * own End turn would with their saved route (`endTurnActionFor`), so a route
 * whose first step cannot be paid, away from a guard, rests.
 */
export function moveOnActionFor(state: GameState, playerId: PlayerId): ForceTurnAction {
  const planned = plannedTurnActionFor(state, playerId);
  const rests = planned.kind === 'move' && endTurnActionFor(state, playerId, planned.path).kind === 'rest';
  return rests ? { kind: 'force_turn', player: playerId, rest: true } : { kind: 'force_turn', player: playerId };
}

/**
 * [SOURCE §8] Whether an unclaimed site with a guard stands on `node`: a turn
 * ending there fights it.
 */
export function guardToFightAt(state: GameState, node: NodeId): boolean {
  const poi = poiAt(state.map, node);
  const runtime = poiRuntimeAt(state, node);
  return poi !== undefined && poi.guard !== null && runtime !== undefined && !isClaimed(runtime);
}

/**
 * What End turn plays for `playerId` with the route `path` drawn through
 * `waypoint`: the route, walked as far as this turn affords (§7).
 *
 * [Andrei, 2026-09-30, 490] "Clicking End turn with no guard to fight makes no
 * sense. Let us make it rest automatically in this case." A turn that would
 * walk nothing, with no route or with a route whose first step cannot be paid,
 * is a rest unless a guard stands on the player's space; the route is saved
 * for next turn. On a guard it stays the empty walk, and §8 fights it again.
 *
 * Decided here, before `applyAction`, and never inside it: a `move` stays what
 * it always was, so games kept on one device and the records of games online,
 * which are replayed, replay as they were played. The page's End turn, the
 * server's `turn.end` and the game master's Move on (`moveOnActionFor`) all
 * ask this. A route that is no walk from the player's space, or a player not
 * on turn, is handed back as the move, for `applyAction` to refuse.
 */
export function endTurnActionFor(
  state: GameState,
  playerId: PlayerId,
  path: readonly NodeId[],
  waypoint?: NodeId | null,
): TurnAction {
  const move: MoveAction = waypoint === undefined ? { kind: 'move', player: playerId, path } : { kind: 'move', player: playerId, path, waypoint };
  if (state.status !== 'in_progress' || activePlayer(state).id !== playerId) return move;
  const player = playerById(state, playerId);
  if (guardToFightAt(state, player.position)) return move;

  let walked: number;
  try {
    walked = resolveMovement(state.map.graph, player.position, path, state.turn.allowance, player.stats.stamina, state.map.ruleset.config).walked.length;
  } catch (error) {
    if (error instanceof RuleViolationError) return move;
    throw error;
  }
  if (walked > 0) return move;
  if (path.length === 0) return { kind: 'rest', player: playerId };
  const kept = waypoint !== undefined && waypoint !== null && path.includes(waypoint) ? waypoint : null;
  return { kind: 'rest', player: playerId, plan: { path, waypoint: kept } };
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

/**
 * [SOURCE §4] A saved route, changed by its player at any time during play.
 * The route has to be one the player could walk from where they stand, and a
 * waypoint has to lie on it, since End Turn and a forced move walk exactly
 * this; whether this turn affords it is for the walk to find out.
 */
function applyPlan(state: GameState, action: PlanAction): ActionOutcome {
  requireInProgress(state);
  const player = playerById(state, action.player);
  const plan = checkedPlan(state, player, action.path, action.waypoint);
  return {
    state: withPlayer(state, player.id, (current) => ({ ...current, plannedPath: plan })),
    events: [{ type: 'planned', player: player.id, plan }],
  };
}

/** A route to save for `player`, checked as `applyPlan` checks one; an empty route is none. */
function checkedPlan(state: GameState, player: PlayerState, path: readonly NodeId[], waypoint: NodeId | null): PlannedPath | null {
  assertWalkable(state.map.graph, player.position, path);
  if (waypoint !== null && !path.includes(waypoint)) {
    throw new RuleViolationError(`waypoint ${waypoint} is not on the route`);
  }
  return path.length === 0 ? null : { path, waypoint };
}

/**
 * [Q55, 45] Ends a game in progress before anyone has won: the most gold wins
 * and a tie is shared, whether time ran out or, [Q85, 291], the game master
 * ended it.
 */
function applyEndGame(state: GameState, reason: GameEndReason): ActionOutcome {
  requireInProgress(state);
  const winners = mostGold(state);
  return {
    state: { ...state, status: 'finished', winners, ending: reason },
    events: [{ type: 'game_ended', reason, winners }],
  };
}

/**
 * [Q85, 299] A deleted post keeps its place, author and time, and loses its
 * words. One already deleted, or one that is not on the board, is refused.
 */
function applyDeleteMessage(state: GameState, id: string): ActionOutcome {
  const post = state.messageBoard.find((candidate) => candidate.id === id);
  if (post === undefined) throw new RuleViolationError(`there is no post ${id}`);
  if (post.deleted === true) throw new RuleViolationError(`post ${id} is already deleted`);
  return {
    state: {
      ...state,
      messageBoard: state.messageBoard.map((candidate) => (candidate.id === id ? { ...candidate, body: '', deleted: true } : candidate)),
    },
    events: [{ type: 'message_deleted', id }],
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
