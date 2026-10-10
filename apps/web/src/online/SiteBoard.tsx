import { useEffect, useRef } from 'react';
import type { UserId } from '@adventure/core';
import { BOARD_POST_MAX, sitePostKept, type ServerMessage, type SitePost } from '@adventure/protocol';
import { postedLabel } from './ends.ts';
import { TrashBin } from './TrashBin.tsx';

export type BoardView = Extract<ServerMessage, { type: 'lobby.board' }>;

interface SiteBoardProps {
  readonly me: UserId;
  /** `null` until the server has sent it. */
  readonly board: BoardView | null;
  readonly now: number;
  readonly draft: string;
  onDraft(text: string): void;
  /** A post is on its way to the check; Send waits for it. */
  readonly sending: boolean;
  /** Whether the socket is open to send on. */
  readonly connected: boolean;
  /** [Q300, 9 and 10] Why the last post was not put on the board, over the box. */
  readonly notice: string | null;
  onSend(): void;
  onDelete(post: SitePost): void;
  onBlock(post: SitePost, blocked: boolean): void;
}

/**
 * [Q300] The site's board, on the game list page: beside the lists on a
 * window 980 or more wide, below them on a narrower one (1, 8). It works like
 * a game's board: oldest post at the top, newest at the bottom with the box
 * and Send under it, up to 500 characters, no editing; each post shows its
 * writer's name and time, and no figure, since accounts have none (12).
 *
 * The words stay in the box until the post is on the board, so a post the
 * check refuses can be changed and sent again (9, 10). A moderator has the
 * trash bin at the end of each post's name line, as the game master does in a
 * game (6), and beside it on other people's posts the button that stops their
 * writer from posting, or lets them post again (7). Someone stopped reads
 * "You can’t post on the board." where the box was. A post goes 14 days after
 * it was put on the board (13).
 */
export function SiteBoard({ me, board, now, draft, onDraft, sending, connected, notice, onSend, onDelete, onBlock }: SiteBoardProps) {
  const list = useRef<HTMLOListElement | null>(null);
  // [Q300, 13] A post goes 14 days after it was put on the board; an open page hides it itself.
  const posts = (board?.posts ?? []).filter((post) => sitePostKept(post, now));
  // The newest post is at the bottom, so the list keeps it in view. Only the
  // list scrolls: below the game list, the page stays where it is.
  useEffect(() => {
    const element = list.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [posts.length]);

  return (
    <section className="card site-card site-board" aria-label="Messages">
      <h2>Messages</h2>
      {board === null ? (
        <p className="muted" role="status">
          Loading the messages…
        </p>
      ) : posts.length === 0 ? (
        <p className="muted">No messages yet.</p>
      ) : null}
      <ol className="posts" ref={list}>
        {posts.map((post) => {
          const blocked = board?.blocked.includes(post.author) === true;
          return (
            <li key={post.id} className="post">
              <div>
                <p className="by">
                  <span>
                    <b>{post.authorName}</b> · {postedLabel(post.postedAt, now)}
                  </span>
                  {board?.moderator === true && post.deleted !== true ? (
                    <button
                      className="btn ghost delete-post"
                      type="button"
                      aria-label={`Delete ${post.authorName}’s message`}
                      title="Delete"
                      disabled={!connected}
                      onClick={() => onDelete(post)}
                    >
                      <TrashBin />
                    </button>
                  ) : null}
                  {board?.moderator === true && post.author !== me ? (
                    <button
                      className={`btn ghost delete-post block-poster${blocked ? ' on' : ''}`}
                      type="button"
                      aria-label={blocked ? `Let ${post.authorName} post again` : `Stop ${post.authorName} from posting`}
                      aria-pressed={blocked}
                      title={blocked ? 'Let them post again' : 'Stop them posting'}
                      disabled={!connected}
                      onClick={() => onBlock(post, !blocked)}
                    >
                      <NoEntry />
                    </button>
                  ) : null}
                </p>
                {post.deleted === true ? <p className="body deleted">Deleted by the moderator.</p> : <p className="body">{post.body}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {board === null ? null : board.canPost ? (
        <form
          className="compose"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim().length > 0 && !sending) onSend();
          }}
        >
          {notice === null ? null : (
            <p className="problem" role="alert">
              {notice}
            </p>
          )}
          <textarea value={draft} rows={3} maxLength={BOARD_POST_MAX} aria-label="Your message" onChange={(event) => onDraft(event.target.value)} />
          <button className="btn primary" type="submit" disabled={draft.trim().length === 0 || sending || !connected}>
            Send
          </button>
        </form>
      ) : (
        <p className="muted">You can’t post on the board.</p>
      )}
    </section>
  );
}

/**
 * [Q300, 11] The moderator's stop: a circle with a line through it, in the
 * trash bin's line style, red while its writer is stopped.
 */
function NoEntry() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 18L18 6" />
    </svg>
  );
}
