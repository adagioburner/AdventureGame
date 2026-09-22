import type { DieSpec, GuardType } from '@adventure/config';
import { RuleViolationError } from '../errors.ts';
import type { DieRoll, InteractionResolution } from '../action.ts';
import { poiAt } from '../gamemap.ts';
import type { NodeId } from '../ids.ts';
import type { PlayerStats } from '../player.ts';
import { isClaimed } from '../poi.ts';
import type { Guard } from '../reward.ts';
import { poiRuntimeAt, type GameState } from '../state.ts';

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
 * The die a caller supplies must be the die the ruleset specifies (§11
 * `GUARD_DIE`, 1d6). Checked rather than assumed because the roll arrives from
 * outside the engine — a server stream, a hotseat client, an MCTS stream — and
 * a source wired to the wrong die would otherwise silently change §8's odds.
 */
function assertRollMatches(spec: DieSpec, roll: DieRoll): void {
  if (roll.sides !== spec.sides) {
    throw new RuleViolationError(`guard roll has ${roll.sides} sides, ruleset specifies ${spec.sides}`);
  }
  if (roll.value < spec.count || roll.value > spec.count * spec.sides) {
    throw new RuleViolationError(`guard roll ${roll.value} is outside ${spec.count}d${spec.sides}`);
  }
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
 * MCTS supplies its own rolls from its own stream. It is `null` for a node with
 * nothing to take and for an unguarded POI, and required for a guarded one —
 * `applyAction` only draws from the `DiceSource` when a guard is actually
 * faced, so that a die stream advances once per guard attempt and no more.
 *
 * This function reads state and never writes it: the caller (`applyAction`, the
 * one writer) applies `claimed` to `poiRuntime` and the reward to the player's
 * stats.
 */
export function resolveInteraction(
  state: GameState,
  node: NodeId,
  stats: PlayerStats,
  roll: DieRoll | null,
): InteractionResolution {
  const nothingToTake: InteractionResolution = {
    node,
    reward: null,
    roll: null,
    skillUsed: null,
    claimed: false,
  };

  const poi = poiAt(state.map, node);
  const runtime = poiRuntimeAt(state, node);
  // §4.5: a claimed POI's node "behaves like an ordinary node of its terrain".
  if (poi === undefined || runtime === undefined || isClaimed(runtime)) return nothingToTake;

  if (poi.guard === null) {
    return { node, reward: poi.reward, roll: null, skillUsed: null, claimed: true };
  }

  if (roll === null) {
    throw new RuleViolationError(`node ${node} is guarded; resolving it needs a GUARD_DIE roll`);
  }
  assertRollMatches(state.map.ruleset.config.combat.GUARD_DIE, roll);

  const skillUsed = guardSkillStat(poi.guard);
  return {
    node,
    reward: poi.reward,
    roll,
    skillUsed,
    // §8: strictly greater than, so a roll that only ties the guard fails.
    claimed: roll.value + stats[skillUsed] > poi.guard.strength,
  };
}
