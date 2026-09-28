import { describe, expect, it } from 'vitest';
import { asNodeId, asPlayerId, type GameEvent, type InteractionResolution } from '@adventure/core';
import { endingSound } from './cues.ts';

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
