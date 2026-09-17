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
