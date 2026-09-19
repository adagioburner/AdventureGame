import type { Ruleset } from '@adventure/config';
import type { DiceSource, GameId, GameMap, GameState, PlayerId, Seed, UserId } from '@adventure/core';
import type { AiPlayer } from '@adventure/ai';
import type { BoardPost, ServerMessage } from '@adventure/protocol';

/**
 * The session layer's ports. Every one of these is an interface with no
 * implementation in this package.
 *
 * [OPEN §12.1] Hosting is undecided, so the rule here is absolute: this package
 * imports nothing runtime-specific — no WebSocket, no KV, no SQL, no Durable
 * Object, no `setTimeout`. If Cloudflare, Node, Deno or a plain in-memory test
 * harness each supply these six ports, the same session code runs on all of
 * them, and changing the answer to §12.1 is an adapter swap in `apps/server`.
 */

/** Persistence for one game's authoritative state. */
export interface GameStore {
  load(gameId: GameId): Promise<GameState | null>;
  save(state: GameState): Promise<void>;
}

/** Fan-out to everyone watching a game. */
export interface Broadcaster {
  broadcast(gameId: GameId, message: ServerMessage): Promise<void>;
  sendTo(userId: UserId, message: ServerMessage): Promise<void>;
}

/** Injected so nothing in the engine or session reads a global clock. */
export interface Clock {
  now(): number;
}

/**
 * [SOURCE §1.3] Map generation is deterministic in `(seed, ruleset)`, and it is
 * the single most CPU-expensive thing in the system apart from MCTS — a
 * rejected attempt reruns the whole pipeline, and step 7 runs
 * `REMOTENESS_SIMULATION_RUNS` full-map walks. Behind a port so it can be a
 * local call, a queued job or a separate service without touching this layer;
 * and because generation is reproducible, a store only ever has to keep the
 * seed.
 */
export interface MapService {
  generate(seed: Seed, ruleset: Ruleset): Promise<GameMap>;
}

/**
 * [SOURCE §5, chat] 10 seconds of CPU per AI move. Behind a port for the same
 * reason as `MapService`, and with more urgency — see `docs/STACK.md` on why
 * this is the component that most constrains the hosting choice.
 */
export interface AiService {
  playerFor(gameId: GameId, player: PlayerId): Promise<AiPlayer>;
}

/**
 * [SOURCE §2] The authoritative `GUARD_DIE` stream (§8), server-side.
 *
 * Kept separate from the public map seed: §1's no-hidden-information rule is
 * about the map, POIs and rewards, all of which the client receives in full. It
 * says nothing about letting a client precompute future dice, and a shared seed
 * would do exactly that.
 */
export interface DiceService {
  forGame(gameId: GameId): Promise<DiceSource>;
}

/**
 * [OPEN §12.3] Message board persistence and scope.
 *
 * The port exists so the feature can be built; the *policy* does not, because
 * nobody has chosen it. Note `scope` is not a parameter of any method here —
 * whether the store is per-game or cross-game is entirely the adapter's
 * business, and no caller can tell the difference.
 */
export interface MessageBoardStore {
  post(post: BoardPost): Promise<void>;
  recent(gameId: GameId, limit: number): Promise<readonly BoardPost[]>;
}

/**
 * [OPEN §12.4] "What happens if the game master disconnects or is otherwise
 * unavailable mid-game — the role cannot be transferred (§6.1), and no fallback
 * for GM absence is described."
 *
 * Routed around by naming the decision rather than making it. Every GM-only
 * path in `GameSession` consults this port when the game master is absent;
 * there is no implementation, so wiring one up is a deliberate act and the
 * default behaviour is a loud failure rather than a quiet invented rule.
 *
 * Note what the port does *not* offer: no `transferGameMaster`. §6.1 says the
 * role cannot be transferred in v1, so the obvious fix is not silently
 * available to whoever implements this.
 */
export interface GameMasterAbsencePolicy {
  readonly name: string;
  /** Called when a GM-only action is needed and the game master is not present. */
  onGameMasterUnavailable(gameId: GameId): Promise<GameMasterFallback>;
}

export type GameMasterFallback =
  | { readonly kind: 'reject' }
  | { readonly kind: 'wait' }
  /** Anything else is a design decision nobody has made. */
  | { readonly kind: 'unresolved'; readonly gdd: 'GDD.md §12.4' };

export interface SessionPorts {
  readonly games: GameStore;
  readonly broadcaster: Broadcaster;
  readonly clock: Clock;
  readonly maps: MapService;
  readonly ai: AiService;
  readonly dice: DiceService;
  readonly board: MessageBoardStore;
  readonly gmAbsence: GameMasterAbsencePolicy;
}
