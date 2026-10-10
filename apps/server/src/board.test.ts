import { describe, expect, it } from 'vitest';

import { asUserId, type UserId } from '@adventure/core';
import { BOARD_POST_MAX, SITE_POST_KEPT_MS, type SitePost } from '@adventure/protocol';
import type { AccountFlags, AccountFlagStore } from './adapters/durable-object.ts';
import type { PostVerdict } from './adapters/post-check.ts';
import { SiteBoard, type SiteBoardStore } from './board.ts';

const andrei = { userId: asUserId('andrei'), displayName: 'Andrei' };
const bea = { userId: asUserId('bea'), displayName: 'Bea' };
const cal = { userId: asUserId('cal'), displayName: 'Cal' };

function memoryBoard(): SiteBoardStore {
  let posts: SitePost[] = [];
  return {
    all: () => [...posts],
    add: (post) => {
      posts.push(post);
    },
    erase: (postId) => {
      posts = posts.map((post) => (post.id === postId ? { ...post, body: '', deleted: true } : post));
    },
    removePostedBefore: (time) => {
      posts = posts.filter((post) => post.postedAt >= time);
    },
  };
}

function memoryFlags(accounts: readonly UserId[], moderators: readonly UserId[]): AccountFlagStore {
  const flags = new Map<UserId, AccountFlags>(accounts.map((id) => [id, { moderator: moderators.includes(id), postingBlocked: false }]));
  return {
    flagsOf: (userId) => flags.get(userId) ?? { moderator: false, postingBlocked: false },
    grantModerator: () => undefined,
    setPostingBlocked: (userId, blocked) => {
      const now = flags.get(userId);
      if (now === undefined) return false;
      flags.set(userId, { ...now, postingBlocked: blocked });
      return true;
    },
    blockedAccounts: () => [...flags.entries()].filter(([, f]) => f.postingBlocked).map(([id]) => id),
  };
}

function setup(verdict: PostVerdict | ((body: string) => PostVerdict) = 'safe') {
  const checked: string[] = [];
  let ids = 0;
  const board = new SiteBoard(
    memoryBoard(),
    memoryFlags([andrei.userId, bea.userId, cal.userId], [andrei.userId]),
    async (body) => {
      checked.push(body);
      return typeof verdict === 'function' ? verdict(body) : verdict;
    },
    { now: () => 1_000 + ids },
    () => `p${++ids}`,
  );
  return { board, checked };
}

describe('SiteBoard (Q300)', () => {
  it('puts a checked post on the board, oldest first, with its writer’s name and time', async () => {
    const { board, checked } = setup();
    expect(await board.post(bea, '  Hello, everyone  ')).toEqual({ kind: 'changed' });
    expect(await board.post(cal, 'Hi Bea')).toEqual({ kind: 'changed' });
    expect(checked).toEqual(['Hello, everyone', 'Hi Bea']);
    expect(board.viewFor(bea.userId)).toEqual({
      type: 'lobby.board',
      posts: [
        { id: 'p1', author: bea.userId, authorName: 'Bea', body: 'Hello, everyone', postedAt: 1_001 },
        { id: 'p2', author: cal.userId, authorName: 'Cal', body: 'Hi Bea', postedAt: 1_002 },
      ],
      canPost: true,
      moderator: false,
      blocked: [],
    });
  });

  it('refuses a post Llama Guard flags, and every post while the check cannot run (3 A, 4 A)', async () => {
    const flagged = setup('flagged');
    expect(await flagged.board.post(bea, 'something nasty')).toEqual({ kind: 'refused', reason: 'offensive' });
    expect(flagged.board.viewFor(bea.userId).posts).toEqual([]);

    const down = setup('unchecked');
    expect(await down.board.post(bea, 'Hello')).toEqual({ kind: 'refused', reason: 'unchecked' });
    expect(down.board.viewFor(bea.userId).posts).toEqual([]);
  });

  it('refuses an empty post and one over the game board’s length, without checking either', async () => {
    const { board, checked } = setup();
    expect(await board.post(bea, '   ')).toMatchObject({ kind: 'error', code: 'invalid_action' });
    expect(await board.post(bea, 'x'.repeat(BOARD_POST_MAX + 1))).toMatchObject({ kind: 'error', code: 'invalid_action' });
    expect(await board.post(bea, 42)).toMatchObject({ kind: 'error', code: 'invalid_action' });
    expect(await board.post(bea, '😀'.repeat(BOARD_POST_MAX))).toEqual({ kind: 'changed' });
    expect(checked).toHaveLength(1);
  });

  it('lets the moderator delete a post, which keeps its place, writer and time (6 A)', async () => {
    const { board } = setup();
    await board.post(bea, 'first');
    await board.post(cal, 'second');
    expect(board.deletePost(bea.userId, 'p1')).toMatchObject({ kind: 'error', code: 'not_moderator' });
    expect(board.deletePost(andrei.userId, 'p1')).toEqual({ kind: 'changed' });
    expect(board.viewFor(cal.userId).posts).toEqual([
      { id: 'p1', author: bea.userId, authorName: 'Bea', body: '', postedAt: 1_001, deleted: true },
      { id: 'p2', author: cal.userId, authorName: 'Cal', body: 'second', postedAt: 1_002 },
    ]);
    expect(board.deletePost(andrei.userId, 'p1')).toMatchObject({ kind: 'error', message: 'that post is already deleted' });
    expect(board.deletePost(andrei.userId, 'nope')).toMatchObject({ kind: 'error', message: 'there is no such post' });
  });

  it('lets the moderator stop an account from posting and let it post again (7)', async () => {
    const { board, checked } = setup();
    expect(board.blockPoster(bea.userId, cal.userId, true)).toMatchObject({ kind: 'error', code: 'not_moderator' });
    expect(board.blockPoster(andrei.userId, andrei.userId, true)).toMatchObject({ kind: 'error', code: 'invalid_action' });
    expect(board.blockPoster(andrei.userId, 'nobody', true)).toMatchObject({ kind: 'error', message: 'there is no such account' });

    expect(board.blockPoster(andrei.userId, bea.userId, true)).toEqual({ kind: 'changed' });
    expect(board.viewFor(bea.userId)).toMatchObject({ canPost: false, blocked: [] });
    expect(board.viewFor(andrei.userId)).toMatchObject({ canPost: true, moderator: true, blocked: [bea.userId] });
    expect(await board.post(bea, 'let me in')).toMatchObject({ kind: 'error', message: 'you can’t post on the board' });
    expect(checked).toEqual([]);

    expect(board.blockPoster(andrei.userId, bea.userId, false)).toEqual({ kind: 'changed' });
    expect(board.viewFor(bea.userId).canPost).toBe(true);
    expect(await board.post(bea, 'back')).toEqual({ kind: 'changed' });
  });

  it('removes a post, deleted or not, 14 days after it was put on the board (13)', async () => {
    let now = 0;
    const store = memoryBoard();
    const board = new SiteBoard(store, memoryFlags([andrei.userId, bea.userId], [andrei.userId]), async () => 'safe', { now: () => now });
    await board.post(bea, 'old');
    now = 1_000;
    await board.post(bea, 'deleted');
    board.deletePost(andrei.userId, board.viewFor(bea.userId).posts[1]?.id);
    now = 5_000;
    await board.post(bea, 'new');

    now = SITE_POST_KEPT_MS;
    expect(board.viewFor(bea.userId).posts.map((post) => post.body)).toEqual(['old', '', 'new']);
    now = SITE_POST_KEPT_MS + 1;
    expect(board.viewFor(bea.userId).posts.map((post) => post.body)).toEqual(['', 'new']);
    now = SITE_POST_KEPT_MS + 1_001;
    expect(board.viewFor(bea.userId).posts.map((post) => post.body)).toEqual(['new']);
    expect(store.all()).toHaveLength(1);
  });

  it('does not post for someone stopped while their post was being checked', async () => {
    let release: (verdict: PostVerdict) => void = () => undefined;
    const flags = memoryFlags([andrei.userId, bea.userId], [andrei.userId]);
    const board = new SiteBoard(memoryBoard(), flags, () => new Promise((resolve) => (release = resolve)), { now: () => 1 });
    const posting = board.post(bea, 'quick, before the ban');
    board.blockPoster(andrei.userId, bea.userId, true);
    release('safe');
    expect(await posting).toMatchObject({ kind: 'error', message: 'you can’t post on the board' });
    expect(board.viewFor(andrei.userId).posts).toEqual([]);
  });
});
