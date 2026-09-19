import { NotImplementedError } from '@adventure/core';
import type { NodeEvaluator } from '../types.ts';

/**
 * [SOURCE §5, chat] The default: "the simulated player's gold amount after
 * rollout". Reads `subject`'s gold stat from the rolled-out state; nothing else.
 */
export function goldAfterSimulationEvaluator(): NodeEvaluator {
  return {
    name: 'gold-after-simulation',
    evaluate() {
      throw new NotImplementedError('goldAfterSimulationEvaluator.evaluate', 'GDD.md §9');
    },
  };
}

/**
 * [SOURCE §5, chat] The designer's planned experiment: `average(gold after
 * simulation, gold now + (number of skills) × balancing_constant, at the node
 * being evaluated)`.
 *
 * Present as a named seam so the swap is a one-line change later, but *not*
 * filled in: two things in that sentence still need the designer.
 *
 *  - "number of skills" — the sum of the five skill levels, or a count of how
 *    many are above zero? Those diverge sharply once a player stacks one skill.
 *  - `balancing_constant` has no value and is not in §11's table.
 *
 * See OPEN_QUESTIONS Q11. Deliberately takes the constant as an argument rather
 * than inventing a config row for it.
 */
export function hybridGoldAndSkillsEvaluator(_balancingConstant: number): NodeEvaluator {
  return {
    name: 'hybrid-gold-and-skills',
    evaluate() {
      throw new NotImplementedError(
        'hybridGoldAndSkillsEvaluator.evaluate — "number of skills" and balancing_constant undefined',
        'GDD.md §9 / docs/OPEN_QUESTIONS.md Q11',
      );
    },
  };
}
