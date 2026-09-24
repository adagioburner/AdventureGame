import {
  applyAction,
  asGameId,
  asPlayerId,
  chooseStartingNode,
  createDiceSource,
  createGameState,
  createRng,
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
 * [Q22] Hotseat seats exactly two players. `PLAYER_COUNT` (2–5) stays as it
 * is: this is a constraint of the mode while §6.1's setup flow does not exist,
 * not a change to the game's range.
 */
export const HOTSEAT_SEATS = 2;

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
  private current: GameState;
  private readonly dice: DiceSource;
  private readonly played: PlayedTurn[] = [];

  constructor(setup: HotseatSetup) {
    if (setup.seats.length !== HOTSEAT_SEATS) {
      throw new RangeError(`hotseat seats ${HOTSEAT_SEATS} players, got ${setup.seats.length}`);
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
    this.dice = createDiceSource(createRng(setup.diceSeed), setup.map.ruleset.config);
  }

  get state(): GameState {
    return this.current;
  }

  get turns(): readonly PlayedTurn[] {
    return this.played;
  }

  /** Play the active seat's turn. Throws `RuleViolationError` for anyone else's. */
  play(action: TurnAction): PlayedTurn {
    const before = this.current;
    const player = before.players[before.turn.activeSeat - 1];
    if (player === undefined) throw new RangeError(`no player in seat ${before.turn.activeSeat}`);
    const outcome = applyAction(before, action, this.dice);
    this.current = outcome.state;
    const turn: PlayedTurn = {
      number: before.turn.number,
      seat: player.seat,
      player: player.id,
      name: player.name,
      action,
      events: outcome.events,
      positionBefore: player.position,
      allowanceBefore: before.turn.allowance,
      statsBefore: player.stats,
      after: outcome.state,
    };
    this.played.push(turn);
    return turn;
  }
}

/**
 * [SOURCE §6, chat] "the players start at a random spot of the plains that is
 * not a POI. All players start from the same spot." Drawn from a stream forked
 * off the map's own seed, so the start replays with the map.
 */
export function hotseatStartingNode(map: GameMap): NodeId {
  return chooseStartingNode(map, createRng(map.seed).fork('starting-node'));
}

/** A fresh die seed, not derivable from the map's. */
export function newDiceSeed(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
