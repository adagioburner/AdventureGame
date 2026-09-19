import type { NodeId, PathPreview } from '@adventure/core';

/**
 * [SOURCE §4] "Clicking the player's own highlighted character enters moving
 * mode; clicking a destination node highlights the shortest path (weighted
 * terrain cost, §5.1) with a thick dotted line and an isometric cross at the
 * destination. Shift-click sets an intermediate waypoint when more than one
 * path exists."
 *
 * A small explicit state machine rather than scattered flags, because the same
 * states behave differently in the two modes (§7.1 vs §7.2).
 */
export type MoveModeState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'selecting'; readonly waypoint: NodeId | null }
  | { readonly kind: 'previewing'; readonly destination: NodeId; readonly waypoint: NodeId | null; readonly preview: PathPreview };

export interface MoveModeController {
  readonly state: MoveModeState;
  /** Enter moving mode. Rejected when it is not this client's turn to plan. */
  enter(): void;
  selectDestination(node: NodeId): void;
  setWaypoint(node: NodeId): void;
  cancel(): void;
  /**
   * [SOURCE §4] "'End Turn' commits the last-shown path; the character walks to
   * the destination or as far as it gets this turn. [...] An unfinished path is
   * saved for the next turn and can still be changed."
   */
  endTurn(): void;
  /** [SOURCE §2] Rest instead: no movement, no interaction. */
  rest(): void;
}

/**
 * The preview must come from `@adventure/core`'s `previewPath`, never from a
 * second implementation in the client.
 *
 * [SOURCE §4, chat] Colours reflect only what is achievable *this turn* and are
 * recalculated every turn as allowances refresh — so the controller recomputes
 * on every turn boundary, and grey is never cached or treated as "unreachable
 * forever" (resting always restores stamina).
 */
export interface PreviewSource {
  previewFor(destination: NodeId, waypoint: NodeId | null): PathPreview | null;
}
