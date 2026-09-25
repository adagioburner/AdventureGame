import { describe, expect, it } from 'vitest';
import { startingStaminaForSeat } from '@adventure/config';
import { dijkstra, poiAt, type GameState, type NodeId, type PlayerId } from '@adventure/core';
import { createMoveModeController } from '../interaction/moveMode.ts';
import { isUnguardedClaim, journalEntry, statLine } from '../page/journal.ts';
import { mapFor } from '../page/seed.ts';
import { HotseatGame, HOTSEAT_MODE, hotseatStartingNode, newDiceSeed } from './hotseat.ts';

const map = mapFor('adventure');
const seats = [
  { name: 'Ada', avatarId: 'player_avatars_03', control: 'human' as const, thinkingSeconds: 10 },
  { name: 'Bram', avatarId: 'player_avatars_05', control: 'human' as const, thinkingSeconds: 10 },
];

describe('hotseat setup (§6, Q51)', () => {
  const game = new HotseatGame({ map, seats, diceSeed: 'setup-test' });
  const more = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      name: `P${index + 1}`,
      avatarId: `player_avatars_0${index + 1}`,
      control: 'human' as const,
      thinkingSeconds: 10,
    }));

  it('seats its players in the order given, with their names and figurines', () => {
    expect(game.state.players.map((player) => [player.seat, player.name, player.avatarId, player.control])).toEqual([
      [1, 'Ada', 'player_avatars_03', 'human'],
      [2, 'Bram', 'player_avatars_05', 'human'],
    ]);
  });

  it('takes 2 to 5 players, as an online game does (Q51, 21)', () => {
    const five = new HotseatGame({ map, seats: more(5), diceSeed: 'x' });
    expect(five.state.players.map((player) => player.stats.stamina)).toEqual([30, 40, 50, 60, 70]);
    expect(() => new HotseatGame({ map, seats: more(1), diceSeed: 'x' })).toThrow(/2 to 5 players/);
    expect(() => new HotseatGame({ map, seats: more(6), diceSeed: 'x' })).toThrow(/2 to 5 players/);
  });

  it('hands a seat to the computer, with a thinking time of whole seconds from 1 to 60 (Q41)', () => {
    const computer = new HotseatGame({ map, seats: [seats[0]!, { ...seats[1]!, control: 'ai', thinkingSeconds: 60 }], diceSeed: 'x' });
    expect(computer.state.players.map((player) => player.control)).toEqual(['human', 'ai']);
    for (const thinkingSeconds of [0, 61, 2.5, Number.NaN]) {
      expect(() => new HotseatGame({ map, seats: [seats[0]!, { ...seats[1]!, control: 'ai', thinkingSeconds }], diceSeed: 'x' })).toThrow(RangeError);
    }
  });

  it('starts each seat with STARTING_STAMINA_BASE + (seat − 1) × STARTING_STAMINA_INCREMENT', () => {
    expect(game.state.players.map((player) => player.stats.stamina)).toEqual([
      startingStaminaForSeat(1, map.ruleset),
      startingStaminaForSeat(2, map.ruleset),
    ]);
  });

  it('puts everyone on one plains node with no POI, drawn from the map’s own seed', () => {
    const start = hotseatStartingNode(map);
    expect(game.state.players.map((player) => player.position)).toEqual([start, start]);
    expect(map.graph.nodes[start]?.terrain).toBe('plains');
    expect(poiAt(map, start)).toBeUndefined();
    expect(new HotseatGame({ map, seats, diceSeed: 'another' }).state.players[0]?.position).toBe(start);
  });

  it('draws dice from their own seed, not the map’s', () => {
    expect(newDiceSeed()).toMatch(/^[0-9a-f]{12}$/);
    expect(newDiceSeed()).not.toBe(newDiceSeed());
  });
});

/**
 * The dumbest defensible player, as in `tools/balance`'s playthrough: head for
 * the nearest unclaimed POI it could take on the die's best face, and rest
 * when not even the first step is affordable.
 */
function nearestTakeable(state: GameState, player: PlayerId): NodeId | null {
  const me = state.players.find((candidate) => candidate.id === player);
  if (me === undefined) return null;
  const { costs } = dijkstra(state.map.graph, me.position, state.map.ruleset.config);
  const die = state.map.ruleset.config.combat.GUARD_DIE;
  let best: { node: NodeId; cost: number } | null = null;
  for (const [index, poi] of state.map.pois.entries()) {
    if (state.poiRuntime[index]?.claimedBy !== null) continue;
    if (poi.guard !== null && die.count * die.sides + me.stats[poi.guard.type] <= poi.guard.strength) continue;
    const cost = costs[poi.node] ?? Number.POSITIVE_INFINITY;
    if (best === null || cost < best.cost) best = { node: poi.node, cost };
  }
  return best?.node ?? null;
}

describe('a whole hotseat game, played through the move-mode controller', () => {
  const game = new HotseatGame({ map, seats, diceSeed: 'whole-game' });
  const controller = createMoveModeController({
    mode: HOTSEAT_MODE,
    localPlayers: new Set(game.state.players.map((player) => player.id)),
    commit: (action) => {
      game.play(action);
      controller.setGame(game.state);
    },
  });
  controller.setGame(game.state);

  const befores: GameState[] = [];
  const refusals: (string | null)[] = [];
  const entered: (string | null)[] = [];
  while (game.state.status === 'in_progress' && game.turns.length < 1000) {
    const state = game.state;
    befores.push(state);
    const player = state.players[state.turn.activeSeat - 1];
    if (player === undefined) throw new Error('no active player');
    // Hotseat: the controller refuses the other seat, whatever the page does.
    const other = state.players.find((candidate) => candidate.id !== player.id);
    if (other !== undefined) refusals.push(controller.enter(other.id));

    const target = nearestTakeable(state, player.id);
    if (target === null) {
      controller.rest();
      continue;
    }
    entered.push(controller.enter(player.id));
    controller.selectDestination(target);
    const shown = controller.state;
    if (shown.kind === 'previewing' && shown.path.length > 0 && shown.preview.reachableStepCount === 0) controller.rest();
    else controller.endTurn();
  }

  it('ends with a winner, decided by the engine', () => {
    expect(game.state.status).toBe('finished');
    expect(game.state.winners.length).toBeGreaterThan(0);
    expect(game.turns.at(-1)?.events.at(-1)).toEqual({ type: 'game_won', winners: game.state.winners });
  });

  it('alternates the two seats every turn, and the controller follows', () => {
    game.turns.forEach((turn, index) => expect(turn.seat).toBe((index % 2) + 1));
    // §7.2: the seat whose turn it is may plan; the other never can.
    expect(new Set(entered)).toEqual(new Set([null]));
    expect(new Set(refusals)).toEqual(new Set(['not_your_turn']));
    expect(controller.state.kind).toBe('idle');
    expect(controller.planner).toBeNull();
  });

  it('writes every turn up in words whose stats are the engine’s', () => {
    game.turns.forEach((turn, index) => {
      const before = befores[index];
      if (before === undefined) throw new Error(`no state before turn ${turn.number}`);
      const entry = journalEntry(turn, before);
      const mover = turn.after.players.find((player) => player.id === turn.player);
      expect(entry.number).toBe(turn.number);
      expect(statLine(entry.statsAfter)).toBe(statLine(mover?.stats ?? turn.statsBefore));
      expect(entry.headline.length).toBeGreaterThan(0);
    });
    expect(game.turns.some((turn) => journalEntry(turn, befores[turn.number - 1] as GameState).tone === 'won')).toBe(true);
  });

  it('lets only an unguarded claim’s card close by itself; a guard fight waits for OK (Andrei, 2026-09-24)', () => {
    const kinds = game.turns.flatMap((turn) => {
      const interacted = turn.events.find((event) => event.type === 'interacted');
      if (interacted === undefined || interacted.type !== 'interacted' || interacted.resolution.reward === null) return [];
      const guarded = poiAt(map, interacted.resolution.node)?.guard != null;
      expect(isUnguardedClaim(turn)).toBe(!guarded);
      return [guarded];
    });
    expect(kinds).toContain(true);
    expect(kinds).toContain(false);
    expect(game.turns.filter((turn) => turn.events.every((event) => event.type !== 'interacted')).some(isUnguardedClaim)).toBe(false);
  });

  it('names the stats as the page does, never by the engine’s words (Q33)', () => {
    const text = game.turns
      .flatMap((turn) => {
        const entry = journalEntry(turn, befores[turn.number - 1] as GameState);
        return [entry.headline, ...entry.details, statLine(entry.statsAfter)];
      })
      .join('\n');
    expect(text).toMatch(/speed/);
    expect(text).toMatch(/combat/i);
    expect(text).not.toMatch(/fighting|moving skill|movement|plains move|forest move|mountain move|_move/i);
  });
});
