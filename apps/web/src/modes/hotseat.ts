import {
  applyAction,
  asGameId,
  asPlayerId,
  createDiceSource,
  createGameState,
  createRng,
  startingNodeFor,
  type BuyAction,
  type ControlMode,
  type DiceSource,
  type GameEvent,
  type GameMap,
  type GameState,
  type MovementAllowance,
  type NodeId,
  type PlayerId,
  type PlayerStats,
  type TurnAction,
} from '@adventure/core';
import type { RewardKind } from '@adventure/config';
import type { OnlineModeConfig } from './online.ts';

/**
 * [SOURCE §intro, chat] Hotseat: "The same computer sequentially shows the game
 * controls for all hotseat participants in turn order. The current player's
 * name and avatar are prominently displayed, and their character is highlighted
 * on the map. Unlike online play, there is **no out-of-turn planning** in
 * hotseat mode — the §7.1 'plan your move while others play' feature does not
 * apply."
 *
 * Modelled as a flag on the same UI rather than a second UI: every other §7.1
 * behaviour (pan, zoom, move mode, path colouring, End Turn) is identical, and
 * duplicating the client to remove one feature would guarantee drift.
 *
 * With `allowOutOfTurnPlanning: false` the move-mode controller refuses `enter()`
 * for any seat that is not the active one, which is the whole difference.
 */
export interface HotseatModeConfig {
  readonly kind: 'hotseat';
  readonly allowOutOfTurnPlanning: false;
}

export type UiModeConfig = HotseatModeConfig | OnlineModeConfig;

export const HOTSEAT_MODE: HotseatModeConfig = { kind: 'hotseat', allowOutOfTurnPlanning: false };

/**
 * What the setup screen settles for one seat (§6.1): a name, a figurine, and
 * who plays it.
 *
 * [Andrei, 2026-09-24] Q41: either seat or both can be the computer, and each
 * computer seat has its own thinking time, in whole seconds from
 * `THINKING_TIME_SECONDS`, starting at 10.
 */
export interface HotseatSeat {
  readonly name: string;
  /** A sprite id on the figurine sheet `Art/manifest.json` names. */
  readonly avatarId: string;
  /** `'ai'` is a computer seat (§9). */
  readonly control: ControlMode;
  /** How long a computer seat thinks about each move. Kept for a person too, so switching back and forth keeps it. */
  readonly thinkingSeconds: number;
}

export interface HotseatSetup {
  readonly map: GameMap;
  /** In seat order: the first moves first. */
  readonly seats: readonly HotseatSeat[];
  /**
   * The die stream's seed. Hotseat has no server, so its rolls are drawn on
   * this device; the seed is still kept apart from the map's, as the server's
   * stream is (§8), and recorded so a game can be replayed.
   */
  readonly diceSeed: string;
}

/**
 * One turn as it was played, with what a reader needs to check it by hand:
 * where the player stood, the allowance §7 had refreshed for them, their stats
 * before, and every player's stats after.
 */
export interface PlayedTurn {
  readonly number: number;
  readonly seat: number;
  readonly player: PlayerId;
  readonly name: string;
  readonly action: TurnAction;
  readonly events: readonly GameEvent[];
  readonly positionBefore: NodeId;
  readonly allowanceBefore: MovementAllowance;
  readonly statsBefore: PlayerStats;
  /** The state the turn left, which is also the next turn's `before`. */
  readonly after: GameState;
  /**
   * [Q190] What the player bought earlier in this turn, before the move or
   * rest: one per Done in the buy panel (769), or the computer's for the
   * turn. `allowanceBefore` and `statsBefore` count it.
   */
  readonly bought: readonly Purchase[];
}

/** [Q190] A purchase as the page shows and logs it: who bought what, on which turn, for how much gold. */
export interface Purchase {
  readonly number: number;
  readonly seat: number;
  readonly player: PlayerId;
  readonly name: string;
  readonly skills: readonly RewardKind[];
  readonly gold: number;
  /** `bought`, and `game_won` when the spending put another player's lead past the gold left (756). */
  readonly events: readonly GameEvent[];
  readonly after: GameState;
  /** The purchases made earlier in the same turn, for a log entry of its own when this one ends the game. */
  readonly earlier: readonly Purchase[];
}

/**
 * A hotseat game: the state, the local die, and the turns so far.
 *
 * Every change goes through `applyAction`, the engine's one writer. The only
 * thing this adds is the local `DiceSource`, which is why it lives here and
 * nowhere near the online path — rolls in online play come from the server's
 * own stream, and a client-side die leaking into it would be a real bug.
 */
export class HotseatGame {
  readonly setup: HotseatSetup;
  /** The game as it started, before the first turn. */
  readonly opening: GameState;
  private current: GameState;
  private readonly dice: DiceSource;
  private readonly played: PlayedTurn[] = [];
  private readonly taken: (TurnAction | BuyAction)[] = [];
  /** [Q190] Purchases made this turn, for the turn's own entry once it is played. */
  private pending: Purchase[] = [];
  private last: Purchase | null = null;

  constructor(setup: HotseatSetup) {
    // [Q51, 21] Any player count the game takes, 2 to 5, as online; Q22's two
    // seats were the mode's limit before the setup screens became one.
    const count = setup.map.ruleset.config.players.PLAYER_COUNT;
    if (setup.seats.length < count.min || setup.seats.length > count.max) {
      throw new RangeError(`a game takes ${count.min} to ${count.max} players, got ${setup.seats.length}`);
    }
    const range = setup.map.ruleset.config.ai.THINKING_TIME_SECONDS;
    for (const seat of setup.seats) {
      if (!Number.isInteger(seat.thinkingSeconds) || seat.thinkingSeconds < range.min || seat.thinkingSeconds > range.max) {
        throw new RangeError(`thinking time is whole seconds from ${range.min} to ${range.max}, got ${seat.thinkingSeconds}`);
      }
    }
    this.setup = setup;
    this.current = createGameState({
      id: asGameId(`hotseat-${setup.map.seed}`),
      map: setup.map,
      players: setup.seats.map((seat, index) => ({
        id: asPlayerId(`seat-${index + 1}`),
        name: seat.name,
        avatarId: seat.avatarId,
        control: seat.control,
      })),
      startingNode: hotseatStartingNode(setup.map),
    });
    this.opening = this.current;
    this.dice = createDiceSource(createRng(setup.diceSeed), setup.map.ruleset.config);
  }

  get state(): GameState {
    return this.current;
  }

  get turns(): readonly PlayedTurn[] {
    return this.played;
  }

  /** Every action played so far, turns and purchases, oldest first: what replays the game. */
  get actions(): readonly (TurnAction | BuyAction)[] {
    return this.taken;
  }

  /** [Q190] The purchase that ended the game (756), if one did. */
  get endingPurchase(): Purchase | null {
    return this.current.status === 'finished' && this.last !== null && this.last.after === this.current ? this.last : null;
  }

  /** Play the active seat's turn. Throws `RuleViolationError` for anyone else's. */
  play(action: TurnAction): PlayedTurn {
    const before = this.current;
    const outcome = applyAction(before, action, this.dice);
    this.current = outcome.state;
    const turn = playedTurnOf(before, action, outcome.events, outcome.state, this.pending);
    this.pending = [];
    this.played.push(turn);
    this.taken.push(action);
    return turn;
  }

  /** [Q190] Buy for the active seat; its turn goes on. Throws `RuleViolationError` if the rules refuse it. */
  buy(action: BuyAction): Purchase {
    const before = this.current;
    const outcome = applyAction(before, action, this.dice);
    this.current = outcome.state;
    const purchase = purchaseOf(before, action, outcome.events, outcome.state, this.pending);
    this.pending = [...this.pending, purchase];
    this.last = purchase;
    this.taken.push(action);
    return purchase;
  }
}

/** The turn the active seat played in `before`, as the page shows and logs it, after `bought` earlier in it. */
export function playedTurnOf(
  before: GameState,
  action: TurnAction,
  events: readonly GameEvent[],
  after: GameState,
  bought: readonly Purchase[] = [],
): PlayedTurn {
  const player = before.players[before.turn.activeSeat - 1];
  if (player === undefined) throw new RangeError(`no player in seat ${before.turn.activeSeat}`);
  return {
    number: before.turn.number,
    seat: player.seat,
    player: player.id,
    name: player.name,
    action,
    events,
    positionBefore: player.position,
    allowanceBefore: before.turn.allowance,
    statsBefore: player.stats,
    after,
    bought,
  };
}

/** [Q190] A purchase the active seat made in `before`, as the page shows and logs it. */
export function purchaseOf(
  before: GameState,
  action: BuyAction,
  events: readonly GameEvent[],
  after: GameState,
  earlier: readonly Purchase[] = [],
): Purchase {
  const player = before.players[before.turn.activeSeat - 1];
  if (player === undefined) throw new RangeError(`no player in seat ${before.turn.activeSeat}`);
  const bought = events.find((event) => event.type === 'bought');
  return {
    number: before.turn.number,
    seat: player.seat,
    player: player.id,
    name: player.name,
    skills: action.skills,
    gold: bought?.type === 'bought' ? bought.gold : 0,
    events,
    after,
    earlier,
  };
}

/**
 * [SOURCE §6, chat] "the players start at a random spot of the plains that is
 * not a POI. All players start from the same spot." Drawn from a stream forked
 * off the map's own seed, so the start replays with the map.
 */
export function hotseatStartingNode(map: GameMap): NodeId {
  return startingNodeFor(map);
}

/** A fresh die seed, not derivable from the map's. */
export function newDiceSeed(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
