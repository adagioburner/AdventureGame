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
 * [SOURCE §9, PR #5 review] There are **three** kinds of node evaluation, and
 * the hybrid is built from the other two rather than being a formula of its
 * own:
 *
 *  - **simulated** — play random moves until the gold is exhausted, and read
 *    the subject's gold. `goldAfterSimulationEvaluator()`.
 *  - **estimated** — the subject's *current* gold and skills, weighted by Q18's
 *    formula. Looks at the node only; no rollout.
 *    `estimatedGoldAndSkillsEvaluator()`.
 *  - **hybrid** — the average of those two.
 *    `hybridGoldAndSkillsEvaluator()`.
 *
 * All three land in [0, 1], which is what Q14 needs for `√2` to be the right
 * `MCTS_EXPLORATION_CONSTANT`: the first two by construction, and the average
 * of two such values trivially.
 */

/**
 * [SOURCE §9, chat] "We can normalize by dividing over total gold on the map."
 *
 * The divisor is the gold *placed* on the map, which is fixed for the whole
 * game, so values stay comparable between nodes and across a search.
 */
function normalisedGold(state: GameState, gold: number): number {
  const total = totalGoldUnits(state.map);
  return total === 0 ? 0 : gold / total;
}

/**
 * The subject's summed skill levels over the skill units the map holds.
 *
 * [SOURCE §9, chat] Q11 decides the numerator: "the sum of all skill levels",
 * so fighting 3 and magic 1 contribute 4, not 2.
 */
function normalisedSkills(state: GameState, subject: PlayerId): number {
  const total = totalSkillUnits(state.map);
  if (total === 0) return 0;
  const player = playerById(state, subject);
  return SKILL_KINDS.reduce((sum, kind) => sum + player.stats[kind], 0) / total;
}

/**
 * How far the game has run, as a fraction of the gold on the map: 0 at the
 * opening, 1 once nothing is left to claim.
 *
 * [SOURCE §9, PR #5 review] Q18's weight between gold and skills. A map with no
 * gold on it has nothing left to claim by definition, so it reads as 1 — the
 * same answer `unclaimedGoldUnits` of 0 gives everywhere else.
 */
function goldProgress(state: GameState): number {
  const total = totalGoldUnits(state.map);
  if (total === 0) return 1;
  return (total - unclaimedGoldUnits(state)) / total;
}

/**
 * **Simulated.** [SOURCE §5, chat] §9's specified default: "the simulated
 * player's gold amount after rollout", normalised per Q14.
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
 * **Estimated.** [SOURCE §9, PR #5 review] Q18's formula: what the subject
 * holds *right now*, with gold and skills weighted by how far the game has run.
 *
 *   value = gold/total_gold × progress + skills/total_skills × (1 − progress)
 *           progress = gold claimed by all players / total_gold
 *
 * "Skills are important at the beginning of the game, and are worthless at the
 * end", which is what the weighting does: at the opening `progress` ≈ 0 and the
 * skill term carries the value; by the end `progress` ≈ 1 and only gold counts.
 *
 * Every quantity is read from **the node being evaluated** — this is the
 * estimate of a position, so the rollout is not consulted at all. That is also
 * why `progress` is meaningful here: it moves across the tree, whereas at a
 * rollout's end there is by definition no unclaimed gold left (Q6).
 *
 * This is where the `balancingConstant` of the earlier design went: what it
 * tuned by hand is now `progress`, which the state supplies.
 */
export function estimatedGoldAndSkillsEvaluator(): NodeEvaluator {
  return {
    name: 'estimated-gold-and-skills',
    evaluate(node: MctsNode, _rolledOut: RolloutCursor, subject: PlayerId): number {
      const progress = goldProgress(node.state);
      const gold = normalisedGold(node.state, playerById(node.state, subject).stats.gold);
      const skills = normalisedSkills(node.state, subject);
      return gold * progress + skills * (1 - progress);
    },
  };
}

/**
 * **Hybrid.** [SOURCE §9, PR #5 review] "The average of the two" — the
 * simulated evaluation and the estimated one, in equal measure, as
 * `(afterSimulation + now) / 2` always did.
 *
 * Composed from the other two evaluators rather than reimplementing either, so
 * a change to one cannot leave the hybrid computing something else.
 */
export function hybridGoldAndSkillsEvaluator(): NodeEvaluator {
  const simulated = goldAfterSimulationEvaluator();
  const estimated = estimatedGoldAndSkillsEvaluator();

  return {
    name: 'hybrid-gold-and-skills',
    evaluate(node: MctsNode, rolledOut: RolloutCursor, subject: PlayerId): number {
      return (
        (simulated.evaluate(node, rolledOut, subject) + estimated.evaluate(node, rolledOut, subject)) / 2
      );
    },
  };
}
