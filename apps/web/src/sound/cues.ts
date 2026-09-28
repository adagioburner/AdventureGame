import type { GameEvent } from '@adventure/core';
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
