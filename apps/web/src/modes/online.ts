import { forcedTurnAction, type GameState, type TurnAction } from '@adventure/core';
import { openingStateOf, replayRecord, type GameRecord, type SetupState } from '@adventure/protocol';
import { playedTurnOf, purchaseOf, type PlayedTurn, type Purchase } from './hotseat.ts';

/**
 * [SOURCE §4] Online play: the §7.1 UI in full.
 *
 * The one behaviour unique to this mode is out-of-turn planning — "Players may
 * plan their next move out of turn while others play; clicking 'End Turn' then
 * executes it in one click." So the client sends `turn.plan` whenever the local
 * player edits their route, whether or not it is their turn, and `turn.end`
 * commits it.
 */
export interface OnlineModeConfig {
  readonly kind: 'online';
  /** Planning is allowed at any time, not only on the local player's turn. */
  readonly allowOutOfTurnPlanning: true;
}

export const ONLINE_MODE: OnlineModeConfig = { kind: 'online', allowOutOfTurnPlanning: true };

/** One change the page has applied: the record, and the turn it played if it was one. */
export interface AppliedRecord {
  readonly record: GameRecord;
  readonly before: GameState;
  readonly after: GameState;
  /** The turn it played, for the walk, the die and the log; `null` for a saved route, a post or the end. */
  readonly turn: PlayedTurn | null;
  /** [Q190] The purchase it made; `null` for anything else. */
  readonly purchase: Purchase | null;
}

/** A record that does not follow the last one: a message was missed, and the page must load the game again. */
export class MissedRecords extends Error {
  override readonly name = 'MissedRecords';
}

/**
 * The page's copy of a stored game in play (§12.1): the server's state, kept
 * current by applying each record the server sends with the same engine the
 * server ran (`replayRecord`), so the two agree by construction.
 *
 * [Q54, 32] Opening a game mid-way, the page replays every record from the
 * state the game started in, which gives it every turn for the log, the turns
 * played while its player was away included, without replaying any walk.
 */
export class OnlineGame {
  private current: GameState;
  private seq: number;
  /** [Q190] Purchases made in the turn under way, for its entry once it is played. */
  private pending: Purchase[];

  private constructor(state: GameState, seq: number, pending: Purchase[]) {
    this.current = state;
    this.seq = seq;
    this.pending = pending;
  }

  /**
   * The game as the server sent it on connect, and every change so far,
   * oldest first. The replay has to arrive where the server's state is; if it
   * does not, the server's state is kept and the log is what could be replayed.
   */
  static open(setup: SetupState, state: GameState, records: readonly GameRecord[]): { game: OnlineGame; applied: AppliedRecord[] } {
    const applied: AppliedRecord[] = [];
    let replayed = openingStateOf(setup, state.map);
    let pending: Purchase[] = [];
    try {
      for (const record of records) {
        const step = apply(replayed, record, pending);
        pending = step.purchase !== null ? [...pending, step.purchase] : step.turn !== null ? [] : pending;
        applied.push(step);
        replayed = step.after;
      }
    } catch (error) {
      console.error('the game’s records do not replay', error);
    }
    const last = records[records.length - 1]?.seq ?? 0;
    if (!sameGame(replayed, state)) console.error('the replayed game differs from the server’s');
    return { game: new OnlineGame(state, last, pending), applied };
  }

  get state(): GameState {
    return this.current;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Applies the next record the server sent. Throws `MissedRecords` if one is missing. */
  apply(record: GameRecord): AppliedRecord {
    if (record.seq <= this.seq) throw new MissedRecords(`record ${record.seq} again, after ${this.seq}`);
    if (record.seq !== this.seq + 1) throw new MissedRecords(`record ${record.seq} after ${this.seq}`);
    const step = apply(this.current, record, this.pending);
    if (step.purchase !== null) this.pending = [...this.pending, step.purchase];
    else if (step.turn !== null) this.pending = [];
    this.current = step.after;
    this.seq = record.seq;
    return step;
  }
}

/** `record` applied to `before`, a turn carrying `bought`, the purchases made earlier in it. */
function apply(before: GameState, record: GameRecord, bought: readonly Purchase[]): AppliedRecord {
  const outcome = replayRecord(before, record);
  const action = turnActionOf(before, record);
  return {
    record,
    before,
    after: outcome.state,
    turn: action === null ? null : playedTurnOf(before, action, outcome.events, outcome.state, bought),
    purchase: record.action.kind === 'buy' ? purchaseOf(before, record.action, outcome.events, outcome.state, bought) : null,
  };
}

/** The move or rest a record played, a forced turn resolved as the engine resolves it; `null` for anything else. */
function turnActionOf(before: GameState, record: GameRecord): TurnAction | null {
  const action = record.action;
  if (action.kind === 'move' || action.kind === 'rest') return action;
  if (action.kind === 'force_turn') return forcedTurnAction(before, action);
  return null;
}

/** The parts of two states that play changes: everything but the map, which never does. */
function sameGame(a: GameState, b: GameState): boolean {
  const { map: _a, ...restA } = a;
  const { map: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}
