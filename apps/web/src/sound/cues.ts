import type { BoardPost, GameEvent, NodeId, PlayerId } from '@adventure/core';
import type { SoundName } from '../art/manifest.ts';

/**
 * [Q63, 134 to 137] The sound a played turn ends on, from what the engine says
 * happened on arrival: a reward taken from an unguarded POI, or a guard beaten
 * or not. A battle won plays only its own sound, not the pickup as well
 * (135), and combat and magic guards share the battle sounds (137). `null`
 * when the turn ended on no reward.
 */
export function endingSound(events: readonly GameEvent[]): Extract<SoundName, 'pickup' | 'battle_won' | 'battle_lost'> | null {
  const interacted = events.find((event): event is Extract<GameEvent, { type: 'interacted' }> => event.type === 'interacted');
  if (interacted === undefined || interacted.resolution.reward === null) return null;
  const { roll, claimed } = interacted.resolution;
  if (roll === null) return claimed ? 'pickup' : null;
  return claimed ? 'battle_won' : 'battle_lost';
}

/**
 * [Q135, 539 and 540] The sites a played turn brought a speed or skill back
 * to, in the order the engine drew them. Each is heard with the respawn sound
 * as its icons come back.
 */
export function returnedSites(events: readonly GameEvent[]): NodeId[] {
  return events.flatMap((event) => (event.type === 'reward_returned' ? [event.node] : []));
}

/**
 * [Q63, 142] Whether a played turn was a rest, which is heard as it is shown.
 * Staying put on a node is a move, not a rest, and makes no rest sound.
 */
export function isRest(events: readonly GameEvent[]): boolean {
  return events.some((event) => event.type === 'rested');
}

/**
 * [Q63, 144] Whether posts that just arrived make the message sound: one
 * sound for any number of them, and none when all of them are `me`'s own.
 * `known` is how many posts were on the board before they came.
 */
export function newPostsHeard(posts: readonly BoardPost[], known: number, me: PlayerId | null): boolean {
  return posts.slice(known).some((post) => post.author !== me);
}
