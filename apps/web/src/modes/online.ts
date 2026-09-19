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
