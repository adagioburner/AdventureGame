import { asUserId, type UserId } from '@adventure/core';
import {
  BOARD_POST_MAX,
  SITE_POST_KEPT_MS,
  type ProtocolErrorCode,
  type ServerMessage,
  type SitePost,
  type SitePostRefusal,
} from '@adventure/protocol';
import type { Clock } from '@adventure/session';
import type { AccountFlagStore, SqlLike } from './adapters/durable-object.ts';
import type { PostCheck } from './adapters/post-check.ts';

/**
 * [Q300] The site's message board, kept by the lobby object: who may post,
 * delete and stop others from posting, and the check every post passes
 * before anyone sees it. The lobby carries it over the game list's sockets.
 */

export type BoardView = Extract<ServerMessage, { type: 'lobby.board' }>;

export type BoardOutcome =
  /** The board changed; every page is sent it again. */
  | { readonly kind: 'changed' }
  /** [Q300, 3 and 4] The post was not put on the board. */
  | { readonly kind: 'refused'; readonly reason: SitePostRefusal }
  | { readonly kind: 'error'; readonly code: ProtocolErrorCode; readonly message: string };

export interface Author {
  readonly userId: UserId;
  readonly displayName: string;
}

export class SiteBoard {
  constructor(
    private readonly posts: SiteBoardStore,
    private readonly flags: AccountFlagStore,
    private readonly check: PostCheck,
    private readonly clock: Clock,
    private readonly newPostId: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * The board as one user sees it. [Q300, 13] Posts are removed from storage
   * here once their 14 days are up; a page that stays open hides them itself
   * as the time passes.
   */
  viewFor(userId: UserId): BoardView {
    this.posts.removePostedBefore(this.clock.now() - SITE_POST_KEPT_MS);
    const mine = this.flags.flagsOf(userId);
    return {
      type: 'lobby.board',
      posts: this.posts.all(),
      canPost: !mine.postingBlocked,
      moderator: mine.moderator,
      blocked: mine.moderator ? this.flags.blockedAccounts() : [],
    };
  }

  /**
   * [Q300, 1 to 4] Up to `BOARD_POST_MAX` characters, as on a game's board.
   * Llama Guard and the check for slurs and insults see the words first: a
   * post either flags is refused (3, 5 B), and so is every post while one of
   * them cannot be asked (4).
   */
  async post(author: Author, body: unknown): Promise<BoardOutcome> {
    if (typeof body !== 'string') return error('invalid_action', 'a post needs some words');
    const words = body.trim();
    if (words.length === 0) return error('invalid_action', 'a post needs some words');
    if ([...words].length > BOARD_POST_MAX) return error('invalid_action', `a post is at most ${BOARD_POST_MAX} characters`);
    if (this.flags.flagsOf(author.userId).postingBlocked) return error('invalid_action', 'you can’t post on the board');

    const verdict = await this.check(words);
    if (verdict === 'flagged') return { kind: 'refused', reason: 'offensive' };
    if (verdict === 'unchecked') return { kind: 'refused', reason: 'unchecked' };
    // A moderator may have stopped them while the check ran.
    if (this.flags.flagsOf(author.userId).postingBlocked) return error('invalid_action', 'you can’t post on the board');

    this.posts.add({
      id: this.newPostId(),
      author: author.userId,
      authorName: author.displayName,
      body: words,
      postedAt: this.clock.now(),
    });
    return { kind: 'changed' };
  }

  /** [Q300, 6] A moderator's delete: the post keeps its place, writer and time, and its words are erased. */
  deletePost(by: UserId, postId: unknown): BoardOutcome {
    if (!this.flags.flagsOf(by).moderator) return error('not_moderator', 'only a moderator can delete a post');
    if (typeof postId !== 'string') return error('invalid_action', 'there is no such post');
    const post = this.posts.all().find((candidate) => candidate.id === postId);
    if (post === undefined) return error('invalid_action', 'there is no such post');
    if (post.deleted === true) return error('invalid_action', 'that post is already deleted');
    this.posts.erase(postId);
    return { kind: 'changed' };
  }

  /** [Q300, 7] A moderator stops an account from posting, or lets it post again. Not their own. */
  blockPoster(by: UserId, target: unknown, blocked: unknown): BoardOutcome {
    if (!this.flags.flagsOf(by).moderator) return error('not_moderator', 'only a moderator can stop someone from posting');
    if (typeof target !== 'string' || typeof blocked !== 'boolean') return error('invalid_action', 'there is no such account');
    if (target === by) return error('invalid_action', 'you can’t stop yourself from posting');
    if (!this.flags.setPostingBlocked(asUserId(target), blocked)) return error('invalid_action', 'there is no such account');
    return { kind: 'changed' };
  }
}

function error(code: ProtocolErrorCode, message: string): BoardOutcome {
  return { kind: 'error', code, message };
}

export interface SiteBoardStore {
  /** Oldest first. */
  all(): SitePost[];
  add(post: SitePost): void;
  /** Marks the post deleted and erases its words. */
  erase(postId: string): void;
  /** [Q300, 13] Removes every post put on the board before `time`, deleted or not. */
  removePostedBefore(time: number): void;
}

/**
 * The posts in the lobby object's SQLite for their 14 days, a deleted post's
 * row too. `seq`, the row's own number, keeps them in the order they were
 * put on the board.
 */
export function createSqlSiteBoardStore(sql: SqlLike): SiteBoardStore {
  sql.exec(`CREATE TABLE IF NOT EXISTS board_posts (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    author TEXT NOT NULL,
    author_name TEXT NOT NULL,
    body TEXT NOT NULL,
    posted_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`);
  return {
    all: () =>
      sql
        .exec('SELECT id, author, author_name, body, posted_at, deleted FROM board_posts ORDER BY seq')
        .toArray()
        .map((row) => ({
          id: String(row['id']),
          author: asUserId(String(row['author'])),
          authorName: String(row['author_name']),
          body: String(row['body']),
          postedAt: Number(row['posted_at']),
          ...(Number(row['deleted']) === 1 ? { deleted: true as const } : {}),
        })),
    add: (post) => {
      sql.exec(
        'INSERT INTO board_posts (id, author, author_name, body, posted_at) VALUES (?, ?, ?, ?, ?)',
        post.id,
        post.author,
        post.authorName,
        post.body,
        post.postedAt,
      );
    },
    erase: (postId) => {
      sql.exec("UPDATE board_posts SET deleted = 1, body = '' WHERE id = ?", postId);
    },
    removePostedBefore: (time) => {
      sql.exec('DELETE FROM board_posts WHERE posted_at < ?', time);
    },
  };
}
