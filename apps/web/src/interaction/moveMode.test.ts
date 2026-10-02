import { describe, expect, it } from 'vitest';
import {
  applyAction,
  bestRoute,
  bestRouteVia,
  pathCost,
  previewPath,
  refreshAllowance,
  routeVia,
  shortestPath,
  type GameState,
  type NodeId,
  type TurnAction,
} from '@adventure/core';
import { HotseatGame, HOTSEAT_MODE, type UiModeConfig } from '../modes/hotseat.ts';
import { ONLINE_MODE } from '../modes/online.ts';
import { mapFor } from '../page/seed.ts';
import { createMoveModeController, type MoveModeController } from './moveMode.ts';

const map = mapFor('adventure', 'standard');
const config = map.ruleset.config;

function setup(mode: UiModeConfig = HOTSEAT_MODE): { game: HotseatGame; controller: MoveModeController; sent: TurnAction[] } {
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
    mode,
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

  it('rests when End Turn is pressed with no route away from a guard (490)', () => {
    const { game, controller, sent } = setup();
    const player = seat(game.state, 0);
    controller.endTurn();
    expect(sent).toEqual([{ kind: 'rest', player: player.id }]);
    expect(seat(game.state, 0).position).toBe(player.position);
    expect(seat(game.state, 0).stats.stamina).toBe(player.stats.stamina + config.movement.REST_STAMINA_GAIN);
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

  it('keeps a route drawn this turn through Rest, and opens the next turn on it (Andrei, 2026-10-01)', () => {
    const { game, controller, sent } = setup();
    const ada = seat(game.state, 0);
    const { target, route } = nodeAlong(game.state, 8);
    controller.enter(ada.id);
    controller.choose(route[2] as NodeId, true);
    controller.choose(target, false);
    const drawn = controller.state.kind === 'previewing' ? controller.state.path : [];
    controller.rest();
    expect(sent).toEqual([{ kind: 'rest', player: ada.id, plan: { path: drawn, waypoint: route[2] } }]);
    expect(seat(game.state, 0).position).toBe(ada.position);
    expect(seat(game.state, 0).plannedPath).toEqual({ path: drawn, waypoint: route[2] });
    controller.rest(); // Bram's turn

    expect(controller.state).toMatchObject({ kind: 'previewing', destination: target, waypoint: route[2], path: drawn });
    expect(controller.engaged).toBe(false);
  });

  it('keeps the route as changed this turn through Rest, not the one saved before', () => {
    const { game, controller } = setup();
    const ada = seat(game.state, 0);
    const route = map.pois
      .map((poi) => shortestPath(map.graph, ada.position, poi.node, config) ?? [])
      .sort((p, q) => pathCost(map.graph, q, config) - pathCost(map.graph, p, config))[0] as readonly NodeId[];
    controller.enter(ada.id);
    controller.selectDestination(route[route.length - 1] as NodeId);
    controller.endTurn();
    controller.rest(); // Bram's turn
    const saved = seat(game.state, 0).plannedPath;
    const elsewhere = map.graph.adjacency[seat(game.state, 0).position]?.find((node) => !saved?.path.includes(node));
    if (elsewhere === undefined) throw new Error('no neighbour off the saved route');
    controller.enter(ada.id);
    controller.selectDestination(elsewhere);
    const changed = controller.state.kind === 'previewing' ? controller.state.path : [];
    expect(changed).not.toEqual(saved?.path);
    controller.rest();
    expect(seat(game.state, 0).plannedPath).toEqual({ path: changed, waypoint: null });
  });

  it('keeps no route after Cancel, with Rest or with End turn (610)', () => {
    for (const press of ['rest', 'endTurn'] as const) {
      const { game, controller, sent } = setup();
      const ada = seat(game.state, 0);
      const route = map.pois
        .map((poi) => shortestPath(map.graph, ada.position, poi.node, config) ?? [])
        .sort((p, q) => pathCost(map.graph, q, config) - pathCost(map.graph, p, config))[0] as readonly NodeId[];
      controller.enter(ada.id);
      controller.selectDestination(route[route.length - 1] as NodeId);
      controller.endTurn();
      controller.rest(); // Bram's turn
      expect(seat(game.state, 0).plannedPath).not.toBeNull();
      expect(controller.state.kind).toBe('previewing');
      controller.cancel();
      controller[press]();
      expect(sent.at(-1)).toEqual({ kind: 'rest', player: ada.id, plan: { path: [], waypoint: null } });
      expect(seat(game.state, 0).plannedPath).toBeNull();
      controller.rest(); // Bram's turn
      expect(controller.state.kind).toBe('idle');
    }
  });

  it('cancels back to idle, and a cancelled route is not committed', () => {
    const { game, controller, sent } = setup();
    const player = seat(game.state, 0);
    controller.enter(player.id);
    controller.selectDestination(nodeAlong(game.state, 5).target);
    controller.cancel();
    expect(controller.state.kind).toBe('idle');
    controller.endTurn();
    expect(sent).toEqual([{ kind: 'rest', player: player.id }]);
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
    pick: () => {
      throw new Error('a saved route brings no skill back');
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

  it('rests with no route of its own: the route drawn is saved as it is drawn, and a rest keeps the saved one', () => {
    const { game, controller, sent, play } = onlineSetup();
    const ada = seat(game.state, 0);
    const bram = seat(game.state, 1);
    play({ kind: 'rest', player: ada.id });
    controller.enter(bram.id);
    controller.selectDestination(nodeAlong(game.state, 4).target);
    controller.rest();
    expect(sent).toEqual([{ kind: 'rest', player: bram.id }]);
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

describe('a space chosen on your own turn needs no tap on your figure first (Q145, 570 to 572)', () => {
  it('picks the figure up and chooses the space, as tapping the figure then the space does', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const { target } = nodeAlong(game.state, 6);
    controller.choose(target, false);
    expect(controller.engaged).toBe(true);
    expect(controller.planner).toBe(player.id);
    const tapped = setup();
    tapped.controller.enter(player.id);
    tapped.controller.choose(target, false);
    expect(controller.state).toEqual(tapped.controller.state);
  });

  it('makes a shift-clicked space the waypoint', () => {
    const { game, controller } = setup();
    const { route } = nodeAlong(game.state, 6);
    controller.choose(route[2] as NodeId, true);
    expect(controller.state).toEqual({ kind: 'selecting', waypoint: route[2] });
    expect(controller.engaged).toBe(true);
  });

  it('works again after Cancel, and for the next seat on its turn', () => {
    const { game, controller } = setup();
    controller.choose(nodeAlong(game.state, 4).target, false);
    controller.cancel();
    controller.choose(nodeAlong(game.state, 5).target, false);
    expect(controller.state.kind).toBe('previewing');
    controller.rest();
    const bram = seat(game.state, 1);
    const near = map.graph.adjacency[bram.position]?.[0] as NodeId;
    controller.choose(near, false);
    expect(controller.planner).toBe(bram.id);
    expect(controller.state).toMatchObject({ kind: 'previewing', destination: near });
  });

  it('online, plans on this player’s own turn but not while another plays (572)', () => {
    const { game, controller, play } = onlineSetup();
    const ada = seat(game.state, 0);
    const bram = seat(game.state, 1);
    const near = map.graph.adjacency[bram.position]?.[0] as NodeId;
    controller.choose(near, false);
    expect(controller.state.kind).toBe('idle');
    expect(controller.engaged).toBe(false);
    play({ kind: 'rest', player: ada.id });
    controller.choose(near, false);
    expect(controller.planner).toBe(bram.id);
    expect(controller.engaged).toBe(true);
    expect(controller.state).toMatchObject({ kind: 'previewing', destination: near });
  });

  it('does nothing once the game is over', () => {
    const { game, controller } = setup();
    controller.setGame({ ...game.state, status: 'finished' });
    controller.choose(nodeAlong(game.state, 3).target, false);
    expect(controller.state.kind).toBe('idle');
  });
});

describe('Track closes planning (Q57, 75)', () => {
  it('keeps the route drawn with the figure put down, and End turn still plays it', () => {
    const { game, controller, sent } = setup();
    const player = seat(game.state, 0);
    controller.enter(player.id);
    controller.selectDestination(nodeAlong(game.state, 3).target);
    const route = controller.state.kind === 'previewing' ? controller.state.path : null;
    controller.armWaypoint(true);
    controller.putDown();
    expect(controller.engaged).toBe(false);
    expect(controller.waypointArmed).toBe(false);
    expect(controller.state).toMatchObject({ kind: 'previewing', path: route });
    controller.endTurn();
    expect(sent).toEqual([{ kind: 'move', player: player.id, path: route, waypoint: null }]);
  });

  it('drops a route that has no destination yet', () => {
    const { game, controller } = setup();
    controller.enter(seat(game.state, 0).id);
    controller.putDown();
    expect(controller.state.kind).toBe('idle');
    expect(controller.engaged).toBe(false);
  });

  it('online, shows the saved route after it, and the next turn opens on it', () => {
    const { game, controller } = onlineSetup();
    const ada = seat(game.state, 0);
    const bram = seat(game.state, 1);
    const route = nodeAlong(game.state, 3).route;
    controller.enter(bram.id);
    controller.selectDestination(route[route.length - 1] as NodeId);
    // The page saves the route on the server as it is drawn; the game then carries it.
    const saved = planned(game.state, bram.id, route);
    controller.setGame(saved);
    controller.putDown();
    expect(controller.state).toMatchObject({ kind: 'previewing', path: route });
    const noDice = {
      roll: () => {
        throw new Error('resting rolls no die');
      },
      pick: () => {
        throw new Error('no skill is short yet');
      },
    };
    controller.setGame(applyAction(saved, { kind: 'rest', player: ada.id }, noDice).state);
    expect(controller.engaged).toBe(false);
    expect(controller.planner).toBe(bram.id);
    expect(controller.state).toMatchObject({ kind: 'previewing', path: route });
  });
});

/** `state` with `player`'s three speeds set, as buying them would leave it. */
function withSpeeds(state: GameState, player: GameState['players'][number]['id'], plains: number, forest: number, mountain: number): GameState {
  return {
    ...state,
    players: state.players.map((candidate) =>
      candidate.id === player ? { ...candidate, stats: { ...candidate.stats, plains_move: plains, forest_move: forest, mountain_move: mountain } } : candidate,
    ),
  };
}

/** `state` with `player`'s combat 1 higher, as buying it would leave it. */
function withFighting(state: GameState, player: GameState['players'][number]['id']): GameState {
  return {
    ...state,
    players: state.players.map((candidate) =>
      candidate.id === player ? { ...candidate, stats: { ...candidate.stats, fighting: candidate.stats.fighting + 1 } } : candidate,
    ),
  };
}

/** A site whose best route from the first seat, with `state`'s speeds, is not the cheapest by terrain alone. */
function siteWithBetterRoute(state: GameState): { target: NodeId; best: readonly NodeId[]; cheapest: readonly NodeId[] } {
  const player = seat(state, 0);
  for (const poi of map.pois) {
    const best = bestRoute(map.graph, player.position, poi.node, player.stats, config) ?? [];
    const cheapest = shortestPath(map.graph, player.position, poi.node, config) ?? [];
    if (best.length > 0 && best.join() !== cheapest.join()) return { target: poi.node, best, cheapest };
  }
  throw new Error('no site has a better route for these speeds');
}

describe('the route drawn is the best for the player’s speeds (Q210, 810 A to 813 A, 818 B)', () => {
  it('draws the best route for the player’s speeds, not the cheapest by terrain alone', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const fast = withSpeeds(game.state, player.id, 1, 2, 4);
    controller.setGame(fast);
    const { target, best } = siteWithBetterRoute(fast);
    controller.enter(player.id);
    controller.selectDestination(target);
    expect(controller.state).toMatchObject({ kind: 'previewing', destination: target, path: best });
  });

  it('takes each leg the best way through a waypoint (812 A)', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const fast = withSpeeds(game.state, player.id, 1, 2, 4);
    controller.setGame(fast);
    const { target, best } = siteWithBetterRoute(fast);
    const waypoint = best[Math.floor(best.length / 2)] as NodeId;
    controller.enter(player.id);
    controller.choose(target, false);
    controller.choose(waypoint, true);
    const stats = seat(fast, 0).stats;
    expect(controller.state).toMatchObject({
      kind: 'previewing',
      waypoint,
      path: bestRouteVia(map.graph, player.position, waypoint, target, stats, config),
    });
  });

  it('picks the route drawn again when speeds are bought, as choosing its destination again would (813 A)', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const { target, best, cheapest } = siteWithBetterRoute(withSpeeds(game.state, player.id, 1, 2, 4));
    controller.enter(player.id);
    controller.selectDestination(target);
    expect(controller.state).toMatchObject({ kind: 'previewing', path: cheapest });
    controller.setGame(withSpeeds(game.state, player.id, 1, 2, 4));
    expect(controller.state).toMatchObject({ kind: 'previewing', destination: target, path: best });
    expect(controller.engaged).toBe(true);
  });

  it('picks a saved route not picked up again too, leaving it down, so Track stays as it was (818 B)', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const { target, best, cheapest } = siteWithBetterRoute(withSpeeds(game.state, player.id, 1, 2, 4));
    const saved = planned(game.state, player.id, cheapest);
    controller.setGame(saved);
    expect(controller.state).toMatchObject({ kind: 'previewing', path: cheapest });
    expect(controller.engaged).toBe(false);
    expect(controller.unsaved).toBe(false);
    controller.setGame(withSpeeds(saved, player.id, 1, 2, 4));
    expect(controller.state).toMatchObject({ kind: 'previewing', destination: target, path: best });
    expect(controller.engaged).toBe(false);
    expect(controller.unsaved).toBe(true);
  });

  it('keeps showing a route picked again until the turn ends, and End turn walks it, on one device (818 B)', () => {
    const { game, controller, sent } = setup();
    const player = seat(game.state, 0);
    const { best, cheapest } = siteWithBetterRoute(withSpeeds(game.state, player.id, 1, 2, 4));
    const saved = planned(game.state, player.id, cheapest);
    controller.setGame(saved);
    const fast = withSpeeds(saved, player.id, 1, 2, 4);
    controller.setGame(fast);
    // Fighting bought later in the turn: the saved route is still last turn's.
    controller.setGame(withFighting(fast, player.id));
    expect(controller.state).toMatchObject({ kind: 'previewing', path: best });
    expect(controller.engaged).toBe(false);
    controller.endTurn();
    expect(sent).toEqual([{ kind: 'move', player: player.id, path: best, waypoint: null }]);
    expect(controller.unsaved).toBe(false);
  });

  it('keeps a route picked again for the next turn when the player rests, on one device (818 B)', () => {
    const { game, controller, sent } = setup();
    const player = seat(game.state, 0);
    const { best, cheapest } = siteWithBetterRoute(withSpeeds(game.state, player.id, 1, 2, 4));
    const saved = planned(game.state, player.id, cheapest);
    controller.setGame(saved);
    controller.setGame(withSpeeds(saved, player.id, 1, 2, 4));
    controller.rest();
    expect(sent).toEqual([{ kind: 'rest', player: player.id, plan: { path: best, waypoint: null } }]);
  });

  it('online, once the route picked again is saved, shows the saved route as before (818 B)', () => {
    const { game, controller } = setup(ONLINE_MODE);
    const player = seat(game.state, 0);
    const { best, cheapest } = siteWithBetterRoute(withSpeeds(game.state, player.id, 1, 2, 4));
    const fast = withSpeeds(planned(game.state, player.id, cheapest), player.id, 1, 2, 4);
    controller.setGame(planned(game.state, player.id, cheapest));
    controller.setGame(fast);
    expect(controller.unsaved).toBe(true);
    // The page saves it on the server, which sends the game back with it.
    controller.setGame(planned(fast, player.id, best));
    expect(controller.state).toMatchObject({ kind: 'previewing', path: best });
    expect(controller.unsaved).toBe(false);
    expect(controller.engaged).toBe(false);
  });

  it('online, a saved route changed another way replaces the route picked again (818 B)', () => {
    const { game, controller } = setup(ONLINE_MODE);
    const player = seat(game.state, 0);
    const { cheapest } = siteWithBetterRoute(withSpeeds(game.state, player.id, 1, 2, 4));
    const fast = withSpeeds(planned(game.state, player.id, cheapest), player.id, 1, 2, 4);
    controller.setGame(planned(game.state, player.id, cheapest));
    controller.setGame(fast);
    const elsewhere = nodeAlong(game.state, 2).route;
    controller.setGame(planned(fast, player.id, elsewhere));
    expect(controller.state).toMatchObject({ kind: 'previewing', path: elsewhere });
    expect(controller.unsaved).toBe(false);
  });

  it('picks a route picked again up when the figure is tapped (818 B)', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const { best, cheapest } = siteWithBetterRoute(withSpeeds(game.state, player.id, 1, 2, 4));
    const saved = planned(game.state, player.id, cheapest);
    controller.setGame(saved);
    controller.setGame(withSpeeds(saved, player.id, 1, 2, 4));
    controller.engage();
    expect(controller.engaged).toBe(true);
    expect(controller.unsaved).toBe(false);
    expect(controller.state).toMatchObject({ kind: 'previewing', path: best });
  });

  it('leaves the route as it was, only recoloured, when the speeds bought do not change it', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const { target } = nodeAlong(game.state, 3);
    controller.setGame(planned(game.state, player.id, shortestPath(map.graph, player.position, target, config) ?? []));
    const before = controller.state;
    // A plains speed of 1 leaves this short route the best one.
    controller.setGame(withSpeeds(planned(game.state, player.id, before.kind === 'previewing' ? before.path : []), player.id, 1, 0, 0));
    expect(controller.state).toMatchObject({ kind: 'previewing', path: before.kind === 'previewing' ? before.path : null });
    expect(controller.engaged).toBe(false);
  });
});

describe('a route put down with Track, or cancelled, stays as it is when something is bought (819 A)', () => {
  it('keeps a route put down with Track on one device, and End turn walks it', () => {
    const { game, controller, sent } = setup();
    const player = seat(game.state, 0);
    const { target, route } = nodeAlong(game.state, 3);
    // Last turn's route, brought back; the player draws another and presses Track.
    const saved = planned(game.state, player.id, nodeAlong(game.state, 2).route);
    controller.setGame(saved);
    controller.enter(player.id);
    controller.selectDestination(target);
    controller.putDown();
    expect(controller.unsaved).toBe(true);
    controller.setGame(withFighting(saved, player.id));
    expect(controller.state).toMatchObject({ kind: 'previewing', destination: target, path: route });
    expect(controller.engaged).toBe(false);
    controller.endTurn();
    expect(sent).toEqual([{ kind: 'move', player: player.id, path: route, waypoint: null }]);
  });

  it('picks a route put down with Track again for speeds bought, from where it was going', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const { target, best, cheapest } = siteWithBetterRoute(withSpeeds(game.state, player.id, 1, 2, 4));
    controller.enter(player.id);
    controller.selectDestination(target);
    controller.putDown();
    expect(controller.state).toMatchObject({ kind: 'previewing', path: cheapest });
    controller.setGame(withSpeeds(game.state, player.id, 1, 2, 4));
    expect(controller.state).toMatchObject({ kind: 'previewing', destination: target, path: best });
    expect(controller.engaged).toBe(false);
  });

  it('brings back no route after Cancel on one device (610)', () => {
    const { game, controller } = setup();
    const player = seat(game.state, 0);
    const saved = planned(game.state, player.id, nodeAlong(game.state, 3).route);
    controller.setGame(saved);
    expect(controller.state.kind).toBe('previewing');
    controller.cancel();
    controller.setGame(withFighting(saved, player.id));
    expect(controller.state.kind).toBe('idle');
    controller.setGame(withSpeeds(withFighting(saved, player.id), player.id, 1, 2, 4));
    expect(controller.state.kind).toBe('idle');
  });

  it('online, keeps a route put down before it is saved, then shows the saved one', () => {
    const { game, controller } = setup(ONLINE_MODE);
    const player = seat(game.state, 0);
    const { target, route } = nodeAlong(game.state, 3);
    controller.enter(player.id);
    controller.selectDestination(target);
    controller.putDown();
    expect(controller.unsaved).toBe(true);
    // Something else arrives before the save does.
    controller.setGame(withFighting(game.state, player.id));
    expect(controller.state).toMatchObject({ kind: 'previewing', path: route });
    controller.setGame(planned(withFighting(game.state, player.id), player.id, route));
    expect(controller.state).toMatchObject({ kind: 'previewing', path: route });
    expect(controller.unsaved).toBe(false);
  });

  it('online, a route already saved when put down is the saved one as before', () => {
    const { game, controller } = setup(ONLINE_MODE);
    const player = seat(game.state, 0);
    const { target, route } = nodeAlong(game.state, 3);
    controller.enter(player.id);
    controller.selectDestination(target);
    controller.setGame(planned(game.state, player.id, route));
    controller.putDown();
    expect(controller.unsaved).toBe(false);
  });
});
