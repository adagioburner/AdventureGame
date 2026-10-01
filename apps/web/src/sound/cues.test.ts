import { describe, expect, it } from 'vitest';
import { asGameId, asNodeId, asPlayerId, type BoardPost, type GameEvent, type InteractionResolution } from '@adventure/core';
import { endingSound, isRest, newPostsHeard, returnedSites } from './cues.ts';

const player = asPlayerId('p1');

function arrival(resolution: Partial<InteractionResolution>): GameEvent[] {
  return [
    {
      type: 'interacted',
      player,
      resolution: { node: asNodeId(4), reward: { kind: 'gold', units: 3 }, roll: null, skillUsed: null, claimed: true, ...resolution },
    },
  ];
}

describe('the sound a turn ends on (Q63)', () => {
  it('picks up a reward from an unguarded POI', () => {
    expect(endingSound(arrival({}))).toBe('pickup');
  });

  it('plays only the battle-won sound when a guard is beaten (135), for combat and magic alike (137)', () => {
    expect(endingSound(arrival({ roll: { value: 5, sides: 6 }, skillUsed: 'fighting', claimed: true }))).toBe('battle_won');
    expect(endingSound(arrival({ roll: { value: 5, sides: 6 }, skillUsed: 'magic', claimed: true }))).toBe('battle_won');
  });

  it('plays the battle-lost sound when the guard holds', () => {
    expect(endingSound(arrival({ roll: { value: 1, sides: 6 }, skillUsed: 'magic', claimed: false }))).toBe('battle_lost');
  });

  it('is silent on a node with nothing to take, and on a turn with no arrival', () => {
    expect(endingSound(arrival({ reward: null }))).toBeNull();
    expect(endingSound([{ type: 'rested', player, staminaGained: 5 }])).toBeNull();
    expect(endingSound([])).toBeNull();
  });
});

describe('the rest sound (Q63, 142)', () => {
  it('plays for a rest, and not for staying put, which is a move', () => {
    expect(isRest([{ type: 'rested', player, staminaGained: 5 }])).toBe(true);
    expect(isRest(arrival({ reward: null }))).toBe(false);
    expect(isRest([])).toBe(false);
  });
});

describe('the respawn sound (Q135, 539 and 540)', () => {
  it('is heard at each site a speed or skill came back to, in the order they were drawn', () => {
    const events: GameEvent[] = [
      ...arrival({ reward: { kind: 'fighting', units: 1 } }),
      { type: 'reward_returned', node: asNodeId(9), reward: { kind: 'plains_move', units: 2 } },
      { type: 'reward_returned', node: asNodeId(7), reward: { kind: 'fighting', units: 2 } },
    ];
    expect(returnedSites(events)).toEqual([asNodeId(9), asNodeId(7)]);
  });

  it('is silent on a turn that brought nothing back', () => {
    expect(returnedSites(arrival({}))).toEqual([]);
    expect(returnedSites([{ type: 'rested', player, staminaGained: 5 }])).toEqual([]);
  });
});

describe('the message sound (Q63, 144)', () => {
  const other = asPlayerId('p2');
  const post = (author: typeof player, n: number): BoardPost => ({ id: `m${n}`, gameId: asGameId('g'), author, body: 'hi', postedAt: n });

  it('plays once for posts someone else made, however many arrive together', () => {
    const board = [post(player, 1), post(other, 2), post(other, 3), post(player, 4)];
    expect(newPostsHeard(board, 1, player)).toBe(true);
  });

  it('is silent for one’s own posts and for posts already known', () => {
    const board = [post(other, 1), post(player, 2)];
    expect(newPostsHeard(board, 1, player)).toBe(false);
    expect(newPostsHeard(board, 2, player)).toBe(false);
  });

  it('hears every post for someone who holds no seat', () => {
    expect(newPostsHeard([post(player, 1)], 0, null)).toBe(true);
  });
});
