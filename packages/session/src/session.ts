import { NotImplementedError, type GameId, type UserId } from '@adventure/core';
import type { ClientMessage } from '@adventure/protocol';
import { GAME_MASTER_ABSENCE_BEHAVIOUR, type SessionPorts } from './ports.ts';

/**
 * One live game. Single-writer by construction: every message for a game is
 * handled here, in order, so the authoritative state never needs locking.
 *
 * That single-writer shape is the main thing the hosting choice has to provide.
 * A Cloudflare Durable Object gives it for free (one object per `gameId`); a
 * Node process gives it with an in-process queue keyed by `gameId`. Either way
 * this class is unchanged — see `docs/STACK.md`.
 *
 * Responsibilities, and only these:
 *   - authority: is this user the game master (§7.3), is it this player's turn;
 *   - sequencing: apply one action at a time through `applyAction`;
 *   - driving AI turns via `AiService` when the active seat is AI-controlled;
 *   - persistence and broadcast through the ports.
 *
 * It contains no game rules. Movement, interaction, victory and turn order all
 * live in `@adventure/core`, so the server, the client's preview and MCTS all
 * agree by construction rather than by review.
 */
export class GameSession {
  constructor(
    readonly gameId: GameId,
    private readonly ports: SessionPorts,
  ) {}

  /**
   * Handle one client message. Returns once the resulting state is persisted
   * and broadcast.
   *
   * [SOURCE §4] GM-only messages (`gm.*`, `setup.*`) are authorised here and
   * nowhere else — the engine deliberately does not know who the GM is.
   * [SOURCE §3, chat] The GM is the game's creator and the role cannot be
   * transferred, so this check is against a value fixed at creation.
   */
  handle(_from: UserId, _message: ClientMessage): Promise<void> {
    throw new NotImplementedError('GameSession.handle', 'GDD.md §6.1, §7, §7.3');
  }

  /**
   * [SOURCE §4] Runs an AI seat's turn. Called when a turn starts on an
   * AI-controlled seat, including a seat an AI took over after a resignation.
   *
   * Awaits `AiService` rather than computing anything, so the 10-second search
   * never blocks message handling for the other players.
   */
  runAiTurn(): Promise<void> {
    throw new NotImplementedError('GameSession.runAiTurn', 'GDD.md §9, §7.3');
  }

  /**
   * [SOURCE §4] "A human player may resign at any time; an AI takes over so
   * play continues."
   * [SOURCE §4, chat] "Only the game master can hand control back to a human
   * after a resignation — not self-service by the player." So resignation flips
   * `control` to `'ai'` and sets `resigned`, and the *only* route back is a
   * `gm.setControl` message, which this method does not provide.
   */
  resign(_player: UserId): Promise<void> {
    throw new NotImplementedError('GameSession.resign', 'GDD.md §7.3');
  }

  /**
   * [SOURCE §12.4, chat] A GM-only request with no game master connected is
   * rejected with `game_master_unavailable` and the game waits. There is no
   * timeout, no fallback and no transfer — §6.1 rules transfer out for v1.
   *
   * [SOURCE §12.1, chat] The same applies to AI turns and map generation, which
   * run on the game master's machine: `runAiTurn` cannot proceed either.
   */
  protected requiresGameMaster(): typeof GAME_MASTER_ABSENCE_BEHAVIOUR {
    return GAME_MASTER_ABSENCE_BEHAVIOUR;
  }
}
