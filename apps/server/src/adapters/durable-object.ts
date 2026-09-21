/**
 * Cloudflare Durable Objects adapter — **placeholder, not a commitment.**
 *
 * [OPEN §12.1] Hosting is undecided. This file exists to record how the mapping
 * would work and to keep the shape honest, not to select a host. It imports
 * nothing Cloudflare-specific, so the repo builds with no Workers toolchain
 * installed.
 *
 * The mapping, if this route is taken:
 *
 *   - one Durable Object instance per `gameId`, which gives `GameSession` the
 *     single-writer guarantee it already assumes, with no locking and no
 *     external coordination;
 *   - `GameStore`   → the DO's own transactional storage;
 *   - `Broadcaster` → the DO's hibernatable WebSocket set;
 *   - `Clock`       → `Date.now()` inside the DO;
 *   - `MessageBoardStore` → DO storage for a per-game board (§12.3 undecided),
 *     or a shared D1/KV binding for a cross-game one — the port hides which;
 *   - `MapService` and `AiService` → **not** the DO. See `docs/STACK.md`: map
 *     generation and a 10-second MCTS search are the two CPU-bound components,
 *     and an edge runtime billed and limited by CPU time is the wrong place for
 *     them. Both are already behind ports for exactly this reason.
 *
 * Whoever implements this should read `docs/STACK.md` first — it argues the
 * session layer is a good fit and the compute is not, and says what to check
 * before committing either way.
 */
export const DURABLE_OBJECT_ADAPTER_STATUS = 'placeholder — hosting undecided, see GDD.md §12.1' as const;
