import type { GuardType, RewardKind, Terrain } from '@adventure/config';
import {
  poiAt,
  previewPath,
  terrainStepCost,
  unclaimedGoldUnits,
  type GameEvent,
  type GameMap,
  type GameState,
  type InteractionResolution,
  type MovementResolution,
  type NodeId,
  type PlayerStats,
} from '@adventure/core';
import type { PlayedTurn } from '../modes/hotseat.ts';

/**
 * A played turn in words, for the turn log beside the map.
 *
 * Written so that every turn can be checked by eye against the rules and the
 * stats panel without the code: which terrain each step entered and whether a
 * terrain's speed or stamina paid for it, why a walk stopped short, what a guard
 * roll added up to and what it had to beat, and the player's whole stat block
 * after. A turn whose reason is not on screen reads as a possible engine bug.
 *
 * Nothing here computes a rule. Which steps were free is `previewPath`'s answer
 * over the steps the engine walked, with the allowance and stamina the turn
 * began with; the roll, the claim and the win come from the engine's events.
 */
export interface JournalEntry {
  readonly number: number;
  readonly seat: number;
  readonly name: string;
  readonly headline: string;
  readonly details: readonly string[];
  readonly tone: 'plain' | 'took' | 'missed' | 'won';
  /** The acting player's stats once the turn resolved. */
  readonly statsAfter: PlayerStats;
}

/**
 * Stat names as a player reads them, in the order the panel shows them. The
 * moving skills read as speeds and fighting as combat throughout the page
 * (Andrei's review, 2026-09-23); the engine's names are unchanged.
 */
export const STAT_ORDER: readonly RewardKind[] = [
  'stamina',
  'gold',
  'plains_move',
  'forest_move',
  'mountain_move',
  'fighting',
  'magic',
];

export const STAT_LABEL: Readonly<Record<RewardKind, string>> = {
  stamina: 'stamina',
  gold: 'gold',
  plains_move: 'plains speed',
  forest_move: 'forest speed',
  mountain_move: 'mountains speed',
  fighting: 'combat',
  magic: 'magic',
};

/** A guard is named for the stat that beats it. */
export const GUARD_LABEL: Readonly<Record<GuardType, string>> = {
  fighting: STAT_LABEL.fighting,
  magic: STAT_LABEL.magic,
};

const TERRAIN_SKILL: Readonly<Record<Terrain, RewardKind>> = {
  plains: 'plains_move',
  forest: 'forest_move',
  mountain: 'mountain_move',
};

export function journalEntry(turn: PlayedTurn, before: GameState): JournalEntry {
  const map = before.map;
  const mover = turn.after.players.find((player) => player.id === turn.player);
  if (mover === undefined) throw new RangeError(`no player ${turn.player}`);
  const base = { number: turn.number, seat: turn.seat, name: turn.name, statsAfter: mover.stats };

  const moved = find(turn.events, 'moved');
  const rested = find(turn.events, 'rested');
  const interacted = find(turn.events, 'interacted');
  const won = find(turn.events, 'game_won');

  const details: string[] = [];
  let headline: string;
  let tone: JournalEntry['tone'] = 'plain';

  if (rested !== undefined) {
    headline = `Rested: +${rested.staminaGained} stamina`;
    details.push(`Stamina ${turn.statsBefore.stamina} → ${mover.stats.stamina}. No move, and no POI is touched while resting.`);
  } else if (moved !== undefined) {
    const walk = describeWalk(moved.resolution, turn, before);
    headline = walk.headline;
    details.push(...walk.details);
  } else {
    headline = 'Took a turn';
  }

  if (interacted !== undefined) {
    const poi = describeInteraction(interacted.resolution, turn, map);
    if (poi !== null) {
      headline += poi.headline;
      details.push(poi.detail);
      tone = interacted.resolution.claimed ? 'took' : 'missed';
    }
  }

  if (won !== undefined) {
    tone = 'won';
    details.push(victoryLine(won.winners.length, turn.after));
  }

  return { ...base, headline, details, tone };
}

// --- a walk ------------------------------------------------------------------

function describeWalk(
  resolution: MovementResolution,
  turn: PlayedTurn,
  before: GameState,
): { headline: string; details: string[] } {
  const map = before.map;
  const planned = resolution.walked.length + resolution.remainder.length;
  if (planned === 0) {
    return { headline: 'Stayed put', details: [] };
  }
  const destination = resolution.remainder[resolution.remainder.length - 1] ?? resolution.to;
  const heading = `Heading for ${describeNode(before, destination)}.`;
  if (resolution.walked.length === 0) {
    return {
      headline: 'Could not afford the first step',
      details: [heading, stoppedLine(resolution.from, resolution.remainder, turn, map, turn.allowanceBefore, turn.statsBefore.stamina)],
    };
  }

  const config = map.ruleset.config;
  const preview = previewPath(map.graph, resolution.from, resolution.walked, turn.allowanceBefore, turn.statsBefore.stamina, config);
  const steps = preview.steps.map((step) => {
    const terrain = terrainOf(map, step.node);
    return step.color === 'free' ? `${terrain} free` : `${terrain} ${step.staminaCost} stamina`;
  });
  const details = [heading, `Steps: ${runs(steps).join(' · ')}.`];
  details.push(
    preview.totalStaminaCost === 0
      ? `Every step was free (a terrain's speed makes that many steps onto it free each turn). Stamina stays ${turn.statsBefore.stamina}.`
      : `Stamina ${turn.statsBefore.stamina} → ${turn.statsBefore.stamina - preview.totalStaminaCost}.`,
  );

  const complete = resolution.remainder.length === 0;
  if (!complete) {
    const left: Record<Terrain, number> = { ...turn.allowanceBefore };
    for (const step of preview.steps) {
      if (step.color === 'free') left[terrainOf(map, step.node)]--;
    }
    details.push(stoppedLine(resolution.to, resolution.remainder, turn, map, left, turn.statsBefore.stamina - preview.totalStaminaCost));
  }

  const walked = resolution.walked.length;
  return { headline: complete ? `Walked ${walked} step${walked === 1 ? '' : 's'}` : `Walked ${walked} of ${planned} steps`, details };
}

/** The one reason a walk ends early (§7): the next step is not free and costs more stamina than is left. */
function stoppedLine(
  at: NodeId,
  remainder: readonly NodeId[],
  turn: PlayedTurn,
  map: GameMap,
  allowanceLeft: Readonly<Record<Terrain, number>>,
  staminaLeft: number,
): string {
  const next = remainder[0];
  if (next === undefined) return '';
  const terrain = terrainOf(map, next);
  const skill = TERRAIN_SKILL[terrain];
  const level = turn.statsBefore[skill];
  const cost = terrainStepCost(terrain, map.ruleset.config);
  const why =
    level === 0
      ? `${STAT_LABEL[skill]} is 0`
      : allowanceLeft[terrain] === 0
        ? `${STAT_LABEL[skill]} ${level}, all ${level} free step${level === 1 ? '' : 's'} used`
        : `${STAT_LABEL[skill]} ${level}`;
  const saved = remainder.length === 1 ? 'That last step is' : `Those ${remainder.length} steps are`;
  return (
    `Stopped: the next step, into ${terrain}, costs ${cost} stamina and ${staminaLeft} ${staminaLeft === 1 ? 'is' : 'are'} left (${why}). ` +
    `${saved} saved for next turn.`
  );
}

// --- a POI -------------------------------------------------------------------

function describeInteraction(
  resolution: InteractionResolution,
  turn: PlayedTurn,
  map: GameMap,
): { headline: string; detail: string } | null {
  const reward = resolution.reward;
  if (reward === null) return null;
  const prize = `${reward.units} ${STAT_LABEL[reward.kind]}`;
  const guard = poiAt(map, resolution.node)?.guard ?? null;

  if (resolution.roll === null || resolution.skillUsed === null || guard === null) {
    return { headline: `, took ${prize}`, detail: `Took ${prize}: the POI was unguarded.` };
  }

  const skill = turn.statsBefore[resolution.skillUsed];
  const total = resolution.roll.value + skill;
  const sum = `rolled ${resolution.roll.value} + ${STAT_LABEL[resolution.skillUsed]} ${skill} = ${total}`;
  const name = GUARD_LABEL[guard.type];
  const kind = `${name.charAt(0).toUpperCase()}${name.slice(1)} guard ${guard.strength}`;
  return resolution.claimed
    ? { headline: `, beat the guard and took ${prize}`, detail: `${kind}: ${sum}, more than ${guard.strength}. Took ${prize}.` }
    : {
        headline: `, lost to the guard`,
        detail: `${kind}: ${sum}, not more than ${guard.strength}. The ${STAT_LABEL[reward.kind]} stays; losing costs nothing else.`,
      };
}

function victoryLine(winners: number, after: GameState): string {
  const left = unclaimedGoldUnits(after);
  const ranked = [...after.players].sort((a, b) => b.stats.gold - a.stats.gold);
  const [first, second] = ranked;
  if (first === undefined) return 'The game is over.';
  if (winners > 1) {
    return `Shared victory: ${ranked.filter((player) => player.stats.gold === first.stats.gold).map((player) => player.name).join(' and ')} have ${first.stats.gold} gold each, and no gold is left on the map.`;
  }
  const lead = first.stats.gold - (second?.stats.gold ?? 0);
  return `${first.name} wins: ${first.stats.gold} gold, ${lead} ahead of ${second?.name ?? 'nobody'}, with ${left} gold left on the map — a lead nobody can catch.`;
}

// --- words for things on the map ---------------------------------------------

/**
 * A node as a player sees it: its terrain, and the POI on it if its reward is
 * still there (§4.5: a claimed POI's node is an ordinary node).
 */
export function describeNode(state: GameState, node: NodeId): string {
  const map = state.map;
  const terrain = terrainOf(map, node);
  const poi = poiAt(map, node);
  const index = map.poiByNode.get(node);
  const taken = index !== undefined && state.poiRuntime[index]?.claimedBy !== null;
  if (poi === undefined || taken) return `a ${terrain} node`;
  const what = `${poi.reward.units} ${STAT_LABEL[poi.reward.kind]}`;
  if (poi.guard === null) return `the ${what} POI (${terrain})`;
  return `the ${what} POI (${terrain}, ${GUARD_LABEL[poi.guard.type]} guard ${poi.guard.strength})`;
}

export function statLine(stats: PlayerStats): string {
  return STAT_ORDER.map((kind) => `${STAT_LABEL[kind]} ${stats[kind]}`).join(' · ');
}

function terrainOf(map: GameMap, node: NodeId): Terrain {
  const found = map.graph.nodes[node];
  if (found === undefined) throw new RangeError(`unknown node ${node}`);
  return found.terrain;
}

/** "plains free, plains free, forest free" as "plains free ×2 · forest free". */
function runs(items: readonly string[]): string[] {
  const out: string[] = [];
  let count = 0;
  items.forEach((item, index) => {
    count++;
    if (items[index + 1] !== item) {
      out.push(count === 1 ? item : `${item} ×${count}`);
      count = 0;
    }
  });
  return out;
}

function find<T extends GameEvent['type']>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}
