import { describe, expect, it } from 'vitest';
import {
  applyAction,
  pathCost,
  previewPath,
  refreshAllowance,
  routeVia,
  shortestPath,
  type GameState,
  type NodeId,
  type TurnAction,
} from '@adventure/core';
import { HotseatGame, HOTSEAT_MODE } from '../modes/hotseat.ts';
import { ONLINE_MODE } from '../modes/online.ts';
import { mapFor } from '../page/seed.ts';
import { createMoveModeController, type MoveModeController } from './moveMode.ts';

const map = mapFor('adventure');
const config = map.ruleset.config;

function setup(): { game: HotseatGame; controller: MoveModeController; sent: TurnAction[] } {
  const game = new HotseatGame({
    map,
    seats: [
      { name: 'Ada', avatarId: 'player_avatars_01', control: 'human', thinkingSeconds: 10 },
      { name: 'Bram', avatarId: 'player_avatars_02', control: 'human', thinkingSeconds: 10 },
    ],
    diceSeed: 'move-mode',
  });
  const sent: TurnAction[] = [];
  const controller = createMoveModeController({
    mode: HOTSEAT_MODE,
    localPlayers: new Set(game.state.players.map((player) => player.id)),
    commit: (action) => {
      sent.push(action);
      game.play(action);
      controller.setGame(game.state);
    },
  });
  controller.setGame(game.state);
  return { game, controller, sent };
}

function seat(state: GameState, index: number) {
  const player = state.players[index];
  if (player === undefined) throw new Error(`no seat ${index + 1}`);
  return player;
}

/** A node `hops` roads away from the start, along the cheapest route to the farthest POI. */
function nodeAlong(state: GameState, hops: number): { target: NodeId; route: readonly NodeId[] } {
  const from = seat(state, 0).position;
  const far = map.pois
    .map((poi) => shortestPath(map.graph, from, poi.node, config) ?? [])
    .sort((a, b) => b.length - a.length)[0];
  if (far === undefined || far.length < hops) throw new Error('map too small');
  const target = far[hops - 1] as NodeId;
  return { target, route: far.slice(0, hops) };
}

describe('move mode (§7.1), idle → selecting → previewing', () => {
  it('starts idle and enters moving mode when the player whose turn it is is clicked', () => {
    const { game, controller } = setup();
    expect(controller.state.kind).toBe('idle');
    expect(controller.enter(seat(game.state, 0).id)).toBeNull();
    expect(controller.state).toEqual({ kind: 'selecting', waypoint: null });
  });

  it('refuses the other seat in hotseat: there is no out-of-turn planning (§7.2)', () => {
    const { game, controller } = setup();
    expect(controller.enter(seat(game.state, 1).id)).toBe('not_your_turn');
    expect(controller.state.kind).toBe('idle');
  });

  it('draws the cheapest route with the colours previewPath gives it, and nothing of its own', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const { target } = nodeAlong(game.state, 12);
    controller.enter(player.id);
    controller.selectDestination(target);
    const path = shortestPath(map.graph, player.position, target, config) ?? [];
    expect(controller.state).toEqual({
      kind: 'previewing',
      destination: target,
      waypoint: null,
      path,
      preview: previewPath(map.graph, player.position, path, game.state.turn.allowance, player.stats.stamina, config),
    });
  });

  it('routes through a shift-clicked waypoint, and a second shift-click on it clears it', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const { target } = nodeAlong(game.state, 10);
    // A waypoint off the cheapest route, so the route visibly changes.
    const off = map.graph.adjacency[player.position]?.find((node) => !(shortestPath(map.graph, player.position, target, config) ?? []).includes(node));
    if (off === undefined) throw new Error('no neighbour off the route');
    controller.enter(player.id);
    controller.choose(target, false);
    controller.choose(off, true);
    const via = routeVia(map.graph, player.position, off, target, config);
    expect(controller.state.kind === 'previewing' && controller.state.path).toEqual(via);
    expect(controller.state.kind !== 'idle' && controller.state.waypoint).toBe(off);
    controller.choose(off, true);
    expect(controller.state.kind === 'previewing' && controller.state.path).toEqual(shortestPath(map.graph, player.position, target, config));
  });

  it('lets a touch screen arm the waypoint with a button instead of the shift key', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const { target, route } = nodeAlong(game.state, 8);
    controller.enter(player.id);
    controller.armWaypoint(true);
    controller.choose(route[3] as NodeId, false);
    expect(controller.state).toEqual({ kind: 'selecting', waypoint: route[3] });
    expect(controller.waypointArmed).toBe(false);
    controller.choose(target, false);
    expect(controller.state.kind === 'previewing' && controller.state.destination).toBe(target);
  });

  it('commits the shown route with End Turn, and its waypoint with it', () => {
    const { game, controller, sent } = setup();
    const player = seat(game.state, 0);
    const { target, route } = nodeAlong(game.state, 8);
    controller.enter(player.id);
    controller.choose(route[2] as NodeId, true);
    controller.choose(target, false);
    const shown = controller.state.kind === 'previewing' ? controller.state.path : null;
    controller.endTurn();
    expect(sent).toEqual([{ kind: 'move', player: player.id, path: shown, waypoint: route[2] }]);
  });

  it('stays put when End Turn is pressed with no route: an empty path, §8’s way to fight a guard again', () => {
    const { game, controller, sent } = setup();
    const player = seat(game.state, 0);
    controller.endTurn();
    expect(sent).toEqual([{ kind: 'move', player: player.id, path: [], waypoint: null }]);
    expect(seat(game.state, 0).position).toBe(player.position);
  });

  it('rests instead, from any state', () => {
    const { game, controller, sent } = setup();
    const player = seat(game.state, 0);
    controller.enter(player.id);
    controller.rest();
    expect(sent).toEqual([{ kind: 'rest', player: player.id }]);
    expect(seat(game.state, 0).stats.stamina).toBe(player.stats.stamina + config.movement.REST_STAMINA_GAIN);
  });

  it('hands over to the next seat, and only that seat can plan', () => {
    const { game, controller } = setup();
    controller.rest();
    expect(controller.state.kind).toBe('idle');
    expect(controller.enter(seat(game.state, 0).id)).toBe('not_your_turn');
    expect(controller.enter(seat(game.state, 1).id)).toBeNull();
  });

  it('opens a player’s next turn on the route they could not finish, recoloured for that turn', () => {
    const { game, controller } = setup();
    const ada = seat(game.state, 0);
    // The dearest route to any POI, beyond Ada's stamina, so the walk stops short.
    const route = map.pois
      .map((poi) => shortestPath(map.graph, ada.position, poi.node, config) ?? [])
      .sort((p, q) => pathCost(map.graph, q, config) - pathCost(map.graph, p, config))[0] as readonly NodeId[];
    expect(pathCost(map.graph, route, config)).toBeGreaterThan(ada.stats.stamina);
    const target = route[route.length - 1] as NodeId;
    controller.enter(ada.id);
    controller.choose(route[route.length - 2] as NodeId, true);
    controller.choose(target, false);
    controller.endTurn();
    const saved = seat(game.state, 0).plannedPath;
    expect(saved?.waypoint).toBe(route[route.length - 2]);
    controller.rest(); // Bram's turn

    const now = seat(game.state, 0);
    const path = saved?.path ?? [];
    expect(controller.state).toEqual({
      kind: 'previewing',
      destination: target,
      waypoint: saved?.waypoint ?? null,
      path,
      preview: previewPath(map.graph, now.position, path, refreshAllowance(now.stats), now.stats.stamina, config),
    });
  });

  it('cancels back to idle, and a cancelled route is not committed', () => {
    const { game, controller, sent } = setup();
    const player = seat(game.state, 0);
    controller.enter(player.id);
    controller.selectDestination(nodeAlong(game.state, 5).target);
    controller.cancel();
    expect(controller.state.kind).toBe('idle');
    controller.endTurn();
    expect(sent).toEqual([{ kind: 'move', player: player.id, path: [], waypoint: null }]);
  });
});

/** Online, seen from the page of the second seat's player: the engine plays every turn, as the server would. */
function onlineSetup(): { game: HotseatGame; controller: MoveModeController; sent: TurnAction[]; play(action: TurnAction): void } {
  const game = new HotseatGame({
    map,
    seats: [
      { name: 'Ada', avatarId: 'player_avatars_01', control: 'human', thinkingSeconds: 10 },
      { name: 'Bram', avatarId: 'player_avatars_02', control: 'human', thinkingSeconds: 10 },
    ],
    diceSeed: 'move-mode-online',
  });
  const sent: TurnAction[] = [];
  const play = (action: TurnAction): void => {
    game.play(action);
    controller.setGame(game.state);
  };
  const controller = createMoveModeController({
    mode: ONLINE_MODE,
    localPlayers: new Set([seat(game.state, 1).id]),
    commit: (action) => {
      sent.push(action);
      play(action);
    },
  });
  controller.setGame(game.state);
  return { game, controller, sent, play };
}

/** A state with `player`'s saved route set, as the server's `turn.plan` would leave it. */
function planned(state: GameState, player: GameState['players'][number]['id'], path: readonly NodeId[]): GameState {
  const noDice = {
    roll: () => {
      throw new Error('a saved route rolls no die');
    },
  };
  return applyAction(state, { kind: 'plan', player, path, waypoint: null }, noDice).state;
}

describe('move mode online (§7.1): planning out of turn (Q56, 49 to 53)', () => {
  it('plans for this page’s player while another plays, and does not pick the figure up until they do', () => {
    const { game, controller } = onlineSetup();
    const bram = seat(game.state, 1);
    expect(controller.planner).toBe(bram.id);
    expect(controller.engaged).toBe(false);
    expect(controller.enter(seat(game.state, 0).id)).toBe('not_local');
    expect(controller.enter(bram.id)).toBeNull();
    expect(controller.engaged).toBe(true);
    expect(controller.state.kind).toBe('selecting');
  });

  it('carries a route being drawn through another player’s turn into this player’s own, then End turn plays it', () => {
    const { game, controller, sent, play } = onlineSetup();
    const ada = seat(game.state, 0);
    const bram = seat(game.state, 1);
    const target = nodeAlong(game.state, 3).target;
    controller.enter(bram.id);
    controller.selectDestination(target);
    const route = controller.state.kind === 'previewing' ? controller.state.path : null;
    expect(route).not.toBeNull();
    play({ kind: 'rest', player: ada.id });
    expect(game.state.turn.activeSeat).toBe(2);
    expect(controller.engaged).toBe(true);
    expect(controller.state).toMatchObject({ kind: 'previewing', path: route });
    controller.endTurn();
    expect(sent).toEqual([{ kind: 'move', player: bram.id, path: route, waypoint: null }]);
    expect(controller.engaged).toBe(false);
  });

  it('shows the saved route while the figure is not picked up, following it as it changes', () => {
    const { game, controller } = onlineSetup();
    const bram = seat(game.state, 1);
    const route = nodeAlong(game.state, 3).route;
    controller.setGame(planned(game.state, bram.id, route));
    expect(controller.state).toMatchObject({ kind: 'previewing', path: route });
    expect(controller.engaged).toBe(false);
    controller.setGame(planned(game.state, bram.id, []));
    expect(controller.state.kind).toBe('idle');
  });

  it('keeps a picked-up route as drawn when the saved one lags behind it', () => {
    const { game, controller } = onlineSetup();
    const bram = seat(game.state, 1);
    const { route, target } = nodeAlong(game.state, 4);
    controller.enter(bram.id);
    controller.selectDestination(target);
    const drawn = controller.state.kind === 'previewing' ? controller.state.path : null;
    controller.setGame(planned(game.state, bram.id, route.slice(0, 2)));
    expect(controller.state).toMatchObject({ kind: 'previewing', path: drawn });
  });

  it('puts the route down when this player’s own turn ends', () => {
    const { game, controller, play } = onlineSetup();
    const ada = seat(game.state, 0);
    const bram = seat(game.state, 1);
    play({ kind: 'rest', player: ada.id });
    controller.enter(bram.id);
    controller.selectDestination(nodeAlong(game.state, 3).target);
    controller.rest();
    expect(controller.engaged).toBe(false);
    expect(game.state.turn.activeSeat).toBe(1);
    expect(controller.planner).toBe(bram.id);
  });
});
