import type { RewardKind } from '@adventure/config';
import { playerById, totalGoldUnits, type GameState, type PlayerId } from '@adventure/core';
import type { RolloutCursor } from '@adventure/sim';
import type { MctsNode, NodeEvaluator } from '../types.ts';

/**
 * [SOURCE §6] The five skills — the movement skills plus fighting and magic.
 * Gold is the objective and stamina is a resource, so neither is a skill.
 */
const SKILL_STATS: readonly RewardKind[] = [
  'plains_move',
  'forest_move',
  'mountain_move',
  'fighting',
  'magic',
];

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
 * [SOURCE §5, chat] The designer's planned experiment: `average(gold after
 * simulation, gold now + (number of skills) × balancing_constant, at the node
 * being evaluated)`.
 *
 * [SOURCE §9, chat] "Number of skills" is **the sum of all skill levels** — so
 * a player with fighting 3 and magic 1 contributes 4, not 2.
 *
 * Both halves are normalised by total map gold, so the average is taken over
 * two quantities on the same scale and the result stays in the [0, 1] range
 * UCB1 wants. That puts `balancingConstant` in units of *gold per skill level*,
 * which is a natural thing to tune: "one skill level is worth this much gold".
 *
 * Note the signature takes the node as well as the rollout result — "gold now
 * ... at the node being evaluated" is unavailable to an evaluator that only
 * sees where the rollout ended, which is why the seam was shaped this way
 * before there was anything to put in it.
 */
export function hybridGoldAndSkillsEvaluator(balancingConstant: number): NodeEvaluator {
  return {
    name: 'hybrid-gold-and-skills',
    evaluate(node: MctsNode, rolledOut: RolloutCursor, subject: PlayerId): number {
      const afterSimulation = normalisedGold(rolledOut.state, playerById(rolledOut.state, subject).stats.gold);

      const atNode = playerById(node.state, subject);
      const skillSum = SKILL_STATS.reduce((sum, stat) => sum + atNode.stats[stat], 0);
      const now = normalisedGold(node.state, atNode.stats.gold + skillSum * balancingConstant);

      return (afterSimulation + now) / 2;
    },
  };
}
