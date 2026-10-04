import { describe, expect, it } from 'vitest';
import { asGameId, routeTable, startingNodeFor, type GameMap, type NodeId, type RouteTable } from '@adventure/core';
import { decodeClientMessage, encodeMessage } from '@adventure/protocol';
import { mapFor } from '../page/seed.ts';
import { hotseatComputer, pauseRouteLists, workOutRouteLists } from './computer.ts';
import { HotseatGame, type HotseatSeat } from './hotseat.ts';

const map = mapFor('adventure', 'standard');
const seats: readonly HotseatSeat[] = [
  { name: 'Ada', avatarId: 'player_avatars_01', control: 'ai', thinkingSeconds: 1 },
  { name: 'Bram', avatarId: 'player_avatars_02', control: 'ai', thinkingSeconds: 2 },
];

describe('the hot seat computer (Q41, Q42)', () => {
  it('thinks for its own seat’s time, then plays a legal move', async () => {
    const game = new HotseatGame({ map, seats, diceSeed: 'computer-test' });
    const computer = hotseatComputer(game);
    for (const seconds of [1, 2]) {
      const player = game.state.players[game.state.turn.activeSeat - 1]!;
      const started = performance.now();
      const { buy, action } = await computer.chooseAction(game.state, player.id);
      const took = performance.now() - started;
      expect(took).toBeGreaterThanOrEqual(seconds * 1000);
      expect(took).toBeLessThan(seconds * 1000 + 500);
      // Nobody has gold on the first turns, so nothing is bought.
      expect(buy).toBeNull();
      if (action === null) throw new Error('no move');
      expect(action.player).toBe(player.id);
      expect(() => game.play(action)).not.toThrow();
    }
    expect(game.turns.map((turn) => turn.seat)).toEqual([1, 2]);
  });

  it('stops thinking when cancelled, and never answers', async () => {
    const game = new HotseatGame({ map, seats, diceSeed: 'computer-cancel' });
    const cancel = { aborted: false };
    let answered = false;
    void hotseatComputer(game)
      .chooseAction(game.state, game.state.players[0]!.id, cancel)
      .then(() => {
        answered = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancel.aborted = true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(answered).toBe(false);
  });
});

describe('route lists worked out in the background (Q235)', () => {
  /** Records each node whose route list `map`'s table works out, in order. */
  function watchLists(map: GameMap): NodeId[] {
    const table = routeTable(map.graph, map.ruleset.config);
    const routesFrom = table.routesFrom.bind(table);
    const worked: NodeId[] = [];
    const seen = new Set<NodeId>();
    (table as { routesFrom: RouteTable['routesFrom'] }).routesFrom = (from) => {
      if (!seen.has(from)) {
        seen.add(from);
        worked.push(from);
      }
      return routesFrom(from);
    };
    return worked;
  }

  async function until(done: () => boolean, ms = 20_000): Promise<void> {
    const end = performance.now() + ms;
    while (!done() && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('works out every list during setup, nearest the starting place first (890 A)', async () => {
    const drawn = mapFor('setup-lists', 'standard');
    const worked = watchLists(drawn);
    const start = startingNodeFor(drawn);
    const stop = workOutRouteLists(drawn, [start]);
    await until(() => worked.length === drawn.graph.nodes.length);
    stop();
    expect(worked.length).toBe(drawn.graph.nodes.length);
    expect(worked[0]).toBe(start);
    const costs = routeTable(drawn.graph, drawn.ruleset.config).from(start).costs;
    const inOrder = worked.map((node) => costs[node] as number);
    expect(inOrder).toEqual([...inOrder].sort((a, b) => a - b));
  });

  it('stops when told, and while the computer thinks, and an older stop leaves newer work alone', async () => {
    const drawn = mapFor('stopped-lists', 'standard');
    const worked = watchLists(drawn);
    const stop = workOutRouteLists(drawn, [startingNodeFor(drawn)]);
    stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(worked).toEqual([]);

    const older = workOutRouteLists(drawn, [startingNodeFor(drawn)]);
    const newer = workOutRouteLists(drawn, [startingNodeFor(drawn)]);
    older();
    await until(() => worked.length > 10);
    pauseRouteLists();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paused = worked.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(worked.length).toBe(paused);
    expect(paused).toBeLessThan(drawn.graph.nodes.length);
    newer();
  });

  it('carries on once the game starts, from where the figures stand, on an online copy of the map (891 A)', async () => {
    const drawn = mapFor('carried-lists', 'standard');
    const stop = workOutRouteLists(drawn, [startingNodeFor(drawn)]);
    stop();
    // As an online game's map arrives from the server: sent by this page, stored there, and sent back.
    const sent = decodeClientMessage(encodeMessage({ type: 'gm.mapGenerated', gameId: asGameId('carried'), map: drawn }));
    if (sent.type !== 'gm.mapGenerated') throw new Error('not a map');
    const copy = sent.map;
    expect(copy).not.toBe(drawn);
    const game = new HotseatGame({ map: copy, seats, diceSeed: 'carried' });
    hotseatComputer(game);
    expect(routeTable(copy.graph, copy.ruleset.config)).toBe(routeTable(drawn.graph, drawn.ruleset.config));
    const worked = watchLists(copy);
    await until(() => worked.length > 0);
    expect(worked.length).toBeGreaterThan(0);
    pauseRouteLists();
  });

  it('works out nothing for a game with no computer seat', async () => {
    const drawn = mapFor('people-only', 'standard');
    const worked = watchLists(drawn);
    const people = seats.map((seat) => ({ ...seat, control: 'human' as const }));
    hotseatComputer(new HotseatGame({ map: drawn, seats: people, diceSeed: 'people' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(worked).toEqual([]);
  });
});
