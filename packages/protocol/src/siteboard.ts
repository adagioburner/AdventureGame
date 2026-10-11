import type { UserId } from '@adventure/core';

/**
 * [Q300] The site's message board, on the game list page beside or below the
 * lists (1). Unlike a game's board (`messageboard.ts`), it belongs to no game:
 * the lobby object keeps it, and it travels on the game list's socket.
 *
 * Only logged-in players read and post (2). Every post is checked on
 * Cloudflare before anyone sees it, by Llama Guard and for slurs and insults:
 * one either flags is refused and its writer told so (3, 5 B), and while a
 * check cannot run every post is refused with "try again later" (4). An
 * account with the moderator flag (6) deletes posts, which keep their place,
 * and stops accounts from posting (7). Each post goes 14 days after it was
 * put on the board (13).
 */
export interface SitePost {
  readonly id: string;
  readonly author: UserId;
  /** The writer's username, as it was when they posted. */
  readonly authorName: string;
  /** The words; empty once the post is deleted. */
  readonly body: string;
  readonly postedAt: number;
  /** [Q300, 6] A moderator deleted the post: it keeps its place, writer and time, and its words are gone. */
  readonly deleted?: true;
}

/** [Q300, 3 and 4] Why a post was not put on the board; the words stay in the writer's box. */
export type SitePostRefusal =
  /** Llama Guard flagged it (3), or the check for slurs and insults did (5 B). */
  | 'offensive'
  /** The check could not run: the day's free allowance is used up, or Cloudflare did not answer (4). */
  | 'unchecked';

/**
 * [Q300, 13] How long a post stays on the site's board, from when it was put
 * there, deleted or not. Andrei: "please also make messages expire in 14 days.
 * The purpose of this board is to coordinate games, so 14 days should be
 * enough".
 */
export const SITE_POST_KEPT_DAYS = 14;

export const SITE_POST_KEPT_MS = SITE_POST_KEPT_DAYS * 24 * 60 * 60 * 1000;

/** [Q300, 13] Whether a post is still on the board at `now`. */
export function sitePostKept(post: Pick<SitePost, 'postedAt'>, now: number): boolean {
  return now - post.postedAt <= SITE_POST_KEPT_MS;
}
