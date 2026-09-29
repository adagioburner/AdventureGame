/**
 * [Q86, 330 and 331] When the map fails to start, or the device takes its
 * drawing surface away, the page builds the map again; after three such
 * troubles within half a minute it stops and says the map could not be drawn.
 */
export const MAP_TROUBLE_LIMIT = 3;
export const MAP_TROUBLE_WINDOW_MS = 30_000;

/** How long after a failed start the map is built again. */
export const MAP_RETRY_MS = 1_000;
/**
 * How long the page waits for a lost drawing surface to come back before it
 * builds the map on a new one. It builds anew either way, since what comes
 * back after a loss can be missing pictures.
 */
export const MAP_RESTORE_WAIT_MS = 2_000;

/**
 * One more trouble at `now`, after those at `times`: the times still within
 * the window, `now` included, and whether to build the map again.
 */
export function noteMapTrouble(times: readonly number[], now: number): { readonly times: readonly number[]; readonly rebuild: boolean } {
  const recent = [...times.filter((at) => now - at < MAP_TROUBLE_WINDOW_MS), now];
  return { times: recent, rebuild: recent.length < MAP_TROUBLE_LIMIT };
}
