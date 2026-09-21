import { SKILL_KINDS } from '@adventure/config';
import {
  playerById,
  totalGoldUnits,
  totalSkillUnits,
  unclaimedGoldUnits,
  type GameState,
  type PlayerId,
} from '@adventure/core';
import type { RolloutCursor } from '@adventure/sim';
import type { MctsNode, NodeEvaluator } from '../types.ts';

/**
 * [SOURCE §9, chat] "We can normalize by dividing over total gold on the map."
 *
 * Every evaluator returns a value in [0, 1] as a result, which is what makes
 * `MCTS_EXPLORATION_CONSTANT` = √2 the right constant — UCB1's derivation
 * assumes that range. Change one and the other needs revisiting.
 *
 * The divisor is the gold *placed* on the map, which is fixed for the whole
 * game, so values stay comparable between nodes and across a search.
 */
function normalisedGold(state: GameState, gold: number): number {
  const total = totalGoldUnits(state.map);
  return total === 0 ? 0 : gold / total;
}

/**
 * [SOURCE §5, chat] The default: "the simulated player's gold amount after
 * rollout", normalised per Q14.
 */
export function goldAfterSimulationEvaluator(): NodeEvaluator {
  return {
    name: 'gold-after-simulation',
    evaluate(_node: MctsNode, rolledOut: RolloutCursor, subject: PlayerId): number {
      const player = playerById(rolledOut.state, subject);
      return normalisedGold(rolledOut.state, player.stats.gold);
    },
  };
}

/**
 * How far the game has run, as a fraction of the gold on the map: 0 at the
 * opening, 1 once nothing is left to claim.
 *
 * [SOURCE §9, PR #5 review] Q18's weight between the two halves. A map with no
 * gold on it has nothing left to claim by definition, so it reads as 1 — the
 * same answer `unclaimedGoldUnits` of 0 gives everywhere else.
 */
function goldProgress(state: GameState): number {
  const total = totalGoldUnits(state.map);
  if (total === 0) return 1;
  return (total - unclaimedGoldUnits(state)) / total;
}

/**
 * [SOURCE §9, PR #5 review] Q18's hybrid: a weighted average of the player's
 * gold and the player's skills, where the weight moves with the game rather
 * than being tuned.
 *
 *   value = gold/total_gold × progress + skills/total_skills × (1 − progress)
 *           progress = gold claimed by all players / total_gold
 *
 * "Skills are important at the beginning of the game, and are worthless at the
 * end", which is what the weighting does: at the opening `progress` ≈ 0 and the
 * skill term carries the value; by the end `progress` ≈ 1 and only gold counts.
 *
 * [SOURCE §9, chat] Q11 still decides the numerator of the skill term: "the sum
 * of all skill levels", so fighting 3 and magic 1 contribute 4, not 2.
 *
 * This **supersedes** the earlier `average(gold after simulation, gold now +
 * (number of skills) × balancing_constant)`. The `balancingConstant` parameter
 * is gone: what it tuned is `progress`, which the state supplies. Q14's [0, 1]
 * requirement now falls out of the shape — both terms are in [0, 1] and the
 * weights sum to 1 — rather than out of a shared divisor.
 *
 * **Which state each quantity is read from**, since the formula is written for
 * one position and an evaluator sees two:
 *
 *  - **gold: the rolled-out state.** This is the term the simulation exists to
 *    produce, exactly as in `goldAfterSimulationEvaluator`.
 *  - **skills: the node being evaluated.** The decision point's own position,
 *    which is what the hybrid was shaped to be able to see; skills accumulated
 *    by random rollout play would be noise.
 *  - **progress: the node being evaluated.** It cannot come from the rollout:
 *    rollouts end when no unclaimed gold remains (Q6), so `progress` there is
 *    always 1, the skill term would always vanish, and the hybrid would be
 *    `goldAfterSimulationEvaluator` under another name.
 */
export function hybridGoldAndSkillsEvaluator(): NodeEvaluator {
  return {
    name: 'hybrid-gold-and-skills',
    evaluate(node: MctsNode, rolledOut: RolloutCursor, subject: PlayerId): number {
      const progress = goldProgress(node.state);

      const goldTerm = normalisedGold(rolledOut.state, playerById(rolledOut.state, subject).stats.gold);

      const atNode = playerById(node.state, subject);
      const skillSum = SKILL_KINDS.reduce((sum, kind) => sum + atNode.stats[kind], 0);
      const totalSkills = totalSkillUnits(node.state.map);
      const skillTerm = totalSkills === 0 ? 0 : skillSum / totalSkills;

      return goldTerm * progress + skillTerm * (1 - progress);
    },
  };
}
