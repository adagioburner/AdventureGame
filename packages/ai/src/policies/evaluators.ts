import { SKILL_KINDS } from '@adventure/config';
import {
  playerById,
  totalGoldUnits,
  totalSkillUnits,
  type GameState,
  type PlayerId,
} from '@adventure/core';
import type { RolloutCursor } from '@adventure/sim';
import type { NodeEvaluator } from '../types.ts';

/**
 * [SOURCE §9, review] There are **three** kinds of node evaluation, and
 * the hybrid is built from the other two rather than being a formula of its
 * own:
 *
 *  - **simulated** — play random moves until the gold is exhausted, and read
 *    the subject's gold. `simulatedRolloutEvaluator()`.
 *  - **estimated** — the subject's *current* gold and skills, weighted by Q18's
 *    formula. Looks at the node only; no rollout.
 *    `estimatedGoldAndSkillsEvaluator()`.
 *  - **hybrid** — the average of those two.
 *    `hybridGoldAndSkillsEvaluator()`.
 *
 * All three land in [0, 1], which is what Q14 needs for `√2` to be the right
 * `MCTS_EXPLORATION_CONSTANT`: the first two by construction, and the average
 * of two such values trivially.
 *
 * [SOURCE §9, review] **v1 uses the simulated one.** It is §9's specified
 * default and the only one the first release is expected to run; the estimated
 * and hybrid evaluators exist to be experimented with afterwards, which is why
 * `SearchOptions.evaluator` is injected rather than defaulted.
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
 * The subject's summed skill levels, plus its stamina in skill points, over
 * the skill units the map holds.
 *
 * [SOURCE §9, chat] Q11 decides the skill numerator: "the sum of all skill
 * levels", so fighting 3 and magic 1 contribute 4, not 2. Andrei, 2026-09-30,
 * adds stamina to it: "(total skill points + stamina / 5)", the 5 being
 * `STAMINA_PER_SKILL_POINT`, and the whole "/ total_skills_in_the_game".
 */
function normalisedSkills(state: GameState, subject: PlayerId): number {
  const total = totalSkillUnits(state.map);
  if (total === 0) return 0;
  const player = playerById(state, subject);
  const skills = SKILL_KINDS.reduce((sum, kind) => sum + player.stats[kind], 0);
  const stamina = player.stats.stamina / state.map.ruleset.config.ai.STAMINA_PER_SKILL_POINT;
  // "Between 0 and 1" (Andrei, 2026-09-30): stamina can in principle lift the
  // sum past every skill unit on the map, so the term stops at 1. On a real
  // map that takes holding nearly all 75 skill points.
  return Math.min(1, (skills + stamina) / total);
}

/**
 * How far the game has run: the skill and gold units anyone has claimed, over
 * all the skill and gold units on the map. 0 at the opening, 1 once every one
 * of them is taken.
 *
 * [SOURCE §9, chat] Andrei, 2026-09-30: "p defined as (skills and gold
 * claimed) / (total skills and gold) so we have continuous progress from the
 * start". It was gold alone (Q18), which stood at 0 until the first gold was
 * taken however many skill sites had gone. Stamina rewards are not counted, and
 * a v1 map has none. A map with none of either reads as 1.
 */
function claimedProgress(state: GameState, measure: ProgressMeasure): number {
  let gold = 0;
  let goldClaimed = 0;
  let skills = 0;
  let skillsClaimed = 0;
  for (let index = 0; index < state.map.pois.length; index++) {
    const reward = state.map.pois[index]?.reward;
    if (reward === undefined) continue;
    const claimed = state.poiRuntime[index]?.claimedBy !== null;
    if (reward.kind === 'gold') {
      gold += reward.units;
      if (claimed) goldClaimed += reward.units;
    } else if (SKILL_KINDS.some((kind) => kind === reward.kind)) {
      skills += reward.units;
      if (claimed) skillsClaimed += reward.units;
    }
  }
  if (measure === 'larger-share') {
    // A kind the map does not hold has nothing left to claim, so reads as 1.
    return Math.max(gold === 0 ? 1 : goldClaimed / gold, skills === 0 ? 1 : skillsClaimed / skills);
  }
  return gold + skills === 0 ? 1 : (goldClaimed + skillsClaimed) / (gold + skills);
}

/**
 * Which `progress` the estimate uses.
 *
 *  - `units-claimed` (Q111): skill and gold units claimed over all of them.
 *  - `larger-share`: Andrei, 2026-09-30, to try as well: "p =
 *    max(gold_claimed/total_gold, skills_claimed/total_skills)".
 */
export type ProgressMeasure = 'units-claimed' | 'larger-share';

/**
 * **Simulated.** [SOURCE §5, chat] §9's specified default: "the simulated
 * player's gold amount after rollout", normalised per Q14.
 */
export function simulatedRolloutEvaluator(): NodeEvaluator {
  return {
    name: 'simulated-rollout',
    readsRollout: true,
    evaluate(_atNode: RolloutCursor, rolledOut: RolloutCursor, subject: PlayerId): number {
      const player = playerById(rolledOut.state, subject);
      return normalisedGold(rolledOut.state, player.stats.gold);
    },
  };
}

/**
 * How the gold lead at a rollout's end becomes a score in [0, 1].
 *
 *  - `margin`: (lead / total gold + 1) / 2, so level is 0.5 and every gold
 *    of lead or deficit counts the same.
 *  - `win`: 1 ahead, 0.5 level, 0 behind, whatever the margin.
 *  - `win-and-margin`: the average of the two.
 */
export type LeadScore = 'margin' | 'win' | 'win-and-margin';

/**
 * **Simulated, scored by the lead.** Andrei, 2026-09-30 (detail 417): an
 * imagined game "is scored by the gold lead over the best opponent instead of
 * the computer's own gold". The lead is the subject's gold minus the richest
 * other player's, read at the rollout's end like the simulated evaluation.
 */
export function simulatedLeadEvaluator(form: LeadScore = 'margin'): NodeEvaluator {
  return {
    name: `simulated-lead-${form}`,
    readsRollout: true,
    evaluate(_atNode: RolloutCursor, rolledOut: RolloutCursor, subject: PlayerId): number {
      const state = rolledOut.state;
      const own = playerById(state, subject).stats.gold;
      let best = Number.NEGATIVE_INFINITY;
      for (const player of state.players) {
        if (player.id !== subject && player.stats.gold > best) best = player.stats.gold;
      }
      const lead = best === Number.NEGATIVE_INFINITY ? own : own - best;
      const total = totalGoldUnits(state.map);
      const margin = total === 0 ? 0.5 : Math.min(1, Math.max(0, (lead / total + 1) / 2));
      const win = lead > 0 ? 1 : lead < 0 ? 0 : 0.5;
      if (form === 'win') return win;
      if (form === 'win-and-margin') return (win + margin) / 2;
      return margin;
    },
  };
}

/**
 * **Estimated.** [SOURCE §9, review] Q18's formula: what the subject
 * holds *right now*, with gold and skills weighted by how far the game has run.
 *
 *   value = gold/total_gold × progress
 *         + (skills + stamina/STAMINA_PER_SKILL_POINT)/total_skills × (1 − progress)
 *           progress = skill and gold units claimed by all players
 *                    / (total_skills + total_gold)
 *
 * "Skills are important at the beginning of the game, and are worthless at the
 * end", which is what the weighting does: at the opening `progress` ≈ 0 and the
 * skill term carries the value; by the end `progress` ≈ 1 and only gold counts.
 *
 * Every quantity is read from **the node being evaluated** — this is the
 * estimate of a position, so the rollout is not consulted at all. That is also
 * why `progress` is meaningful here: it moves across the tree, whereas at a
 * rollout's end there is by definition no unclaimed gold left (Q6), and
 * usually few skills.
 *
 * This is where the `balancingConstant` of the earlier design went: what it
 * tuned by hand is now `progress`, which the state supplies.
 */
export function estimatedGoldAndSkillsEvaluator(measure: ProgressMeasure = 'units-claimed'): NodeEvaluator {
  return {
    name: 'estimated-gold-and-skills',
    readsRollout: false,
    evaluate(atNode: RolloutCursor, _rolledOut: RolloutCursor, subject: PlayerId): number {
      const progress = claimedProgress(atNode.state, measure);
      const gold = normalisedGold(atNode.state, playerById(atNode.state, subject).stats.gold);
      const skills = normalisedSkills(atNode.state, subject);
      return gold * progress + skills * (1 - progress);
    },
  };
}

/**
 * **Hybrid.** [SOURCE §9, review] "The average of the two" — the
 * simulated evaluation and the estimated one, in equal measure, as
 * `(afterSimulation + now) / 2` always did.
 *
 * Composed from the other two evaluators rather than reimplementing either, so
 * a change to one cannot leave the hybrid computing something else.
 */
export function hybridGoldAndSkillsEvaluator(measure: ProgressMeasure = 'units-claimed'): NodeEvaluator {
  const simulated = simulatedRolloutEvaluator();
  const estimated = estimatedGoldAndSkillsEvaluator(measure);

  return {
    name: 'hybrid-gold-and-skills',
    readsRollout: true,
    evaluate(atNode: RolloutCursor, rolledOut: RolloutCursor, subject: PlayerId): number {
      return (
        (simulated.evaluate(atNode, rolledOut, subject) + estimated.evaluate(atNode, rolledOut, subject)) / 2
      );
    },
  };
}
