import type { GuardType } from '@adventure/config';
import { NotImplementedError } from '../errors.ts';
import type { DieRoll, InteractionResolution } from '../action.ts';
import type { NodeId } from '../ids.ts';
import type { PlayerStats } from '../player.ts';
import type { Guard } from '../reward.ts';
import type { GameState } from '../state.ts';

/**
 * [SOURCE §2] The roll is compared against "the relevant skill (fighting or
 * magic, matching the guard's colour)". `GuardType` and the two combat stat
 * names coincide, so this is the identity — written out anyway so the coupling
 * is explicit and survives either list changing.
 */
export function guardSkillStat(guard: Guard): Extract<keyof PlayerStats, 'fighting' | 'magic'> {
  const mapping: Record<GuardType, 'fighting' | 'magic'> = { fighting: 'fighting', magic: 'magic' };
  return mapping[guard.type];
}

/**
 * [SOURCE §2] "On arrival at a POI, interaction is automatic. If unguarded, the
 * reward is simply taken. If guarded: roll 1d6; if `roll + relevant skill >
 * guard_strength`, the reward is taken; otherwise the reward stays on the node
 * and the roll has no other cost. Either outcome ends the turn."
 *
 * [SOURCE §2, chat] Any player may attempt a guarded POI on their turn, not
 * only the one who first failed; a player may leave and return, or stay put;
 * several players may occupy one node with no restriction. So there is no
 * per-player attempt history and no occupancy check anywhere in the engine.
 *
 * `roll` is passed in rather than drawn here: the engine stays pure, the
 * session layer supplies the authoritative server-side roll (`DiceSource`), and
 * MCTS supplies its own rolls from its own stream.
 */
export function resolveInteraction(
  _state: GameState,
  _node: NodeId,
  _stats: PlayerStats,
  _roll: DieRoll | null,
): InteractionResolution {
  throw new NotImplementedError('resolveInteraction', 'GDD.md §8');
}
