import { useEffect, useRef, useState } from 'react';
import type { BoardPost, GameState } from '@adventure/core';
import { BOARD_POST_MAX } from '@adventure/protocol';
import type { ArtCatalog } from '../art/catalog.ts';
import { Portrait } from '../page/Sprites.tsx';
import { postedLabel } from './ends.ts';

interface MessageBoardProps {
  readonly catalog: ArtCatalog;
  readonly posts: readonly BoardPost[];
  /** Whose posts they are: their names and figures. */
  readonly players: GameState['players'];
  readonly now: number;
  /** Sends a post, returning `false` if it could not be sent; `null` for someone holding no seat, who only reads. */
  readonly onPost: ((body: string) => boolean) | null;
  onClose(): void;
}

/**
 * [SOURCE §7.1] "Human players can post messages on a message board visible to
 * all players." [Q56, 58 and 59] It opens where the turn log does. Each post
 * shows its writer's figure, name and time, oldest at the top, with a box and
 * Send at the bottom for anyone holding a seat, up to 500 characters, after
 * the game has ended too. Posts cannot be edited or deleted.
 */
export function MessageBoard({ catalog, posts, players, now, onPost, onClose }: MessageBoardProps) {
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLOListElement | null>(null);
  // The newest post is at the bottom, so the board keeps it in view.
  useEffect(() => {
    const element = list.current;
    element?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [posts.length]);

  const send = (): void => {
    const body = draft.trim();
    if (onPost === null || body.length === 0) return;
    if (onPost(body)) setDraft('');
  };

  return (
    <section className="log board" aria-label="Messages">
      <header>
        <h2>Messages</h2>
        <button className="btn close" type="button" onClick={onClose} aria-label="Close the messages">
          ×
        </button>
      </header>
      {posts.length === 0 ? <p className="muted">No messages yet.</p> : null}
      <ol className="posts" ref={list}>
        {posts.map((post) => {
          const author = players.find((player) => player.id === post.author);
          return (
            <li key={post.id} className="post">
              {author === undefined ? null : <Portrait catalog={catalog} avatarId={author.avatarId} size={32} label="" />}
              <div>
                <p className="by">
                  <b>{author?.name ?? 'Someone'}</b> · {postedLabel(post.postedAt, now)}
                </p>
                <p className="body">{post.body}</p>
              </div>
            </li>
          );
        })}
      </ol>
      {onPost === null ? null : (
        <form
          className="compose"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <textarea
            value={draft}
            rows={3}
            maxLength={BOARD_POST_MAX}
            aria-label="Your message"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className="btn primary" type="submit" disabled={draft.trim().length === 0}>
            Send
          </button>
        </form>
      )}
    </section>
  );
}
