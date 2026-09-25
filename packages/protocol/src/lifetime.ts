/**
 * [Q55] How long a stored game stays on the site. Andrei, 2026-09-25: "I'd
 * make the lifetime explicit when a game is created, with probably a shorter
 * default (few people want a game to last more than 3 days), and a
 * possibility to extend the lifetime to 14 days."
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** [Q55, 43] The "Game lasts" choices on the new game screen, in days from creation. */
export const LIFETIME_DAYS: readonly number[] = [1, 3, 7, 14];

/** [Q55, 43] What "Game lasts" starts at. */
export const DEFAULT_LIFETIME_DAYS = 3;

/** [Q55, 44] The game master extends a day at a time, up to this many days from creation. */
export const LONGEST_LIFETIME_DAYS = 14;

/** [Q55, 36 and 37] A finished or cancelled game is kept this long, then deleted. */
export const KEPT_AFTER_END_DAYS = 7;
