import { startComputerMove, type AiPlayer, type Cancellation, type ComputerTurn } from '@adventure/ai';
import {
  asNodeId,
  createDiceSource,
  createRng,
  routeTable,
  shareRouteTable,
  type GameMap,
  type GameState,
  type NodeId,
  type PlayerId,
  type RouteTable,
} from '@adventure/core';
import type { HotseatGame } from './hotseat.ts';

/** How long the computer thinks in each frame before handing the page back to draw it. */
export const SLICE_MS = 12;

/**
 * [Q235] How long route lists are worked out for in one go where the browser
 * cannot say how long it will stay idle; at least one list either way.
 */
export const ROUTE_LIST_SLICE_MS = 8;

/**
 * The computer's seats in a hot seat game (§9; Q41, Q42): `chooseComputerMove`
 * with each seat's own thinking time.
 *
 * It thinks on the page's own thread, a slice of about `SLICE_MS` a frame,
 * with the thread handed back after each one so the frame is drawn: the map
 * still pans and zooms and the thinking bar still fills. A Web Worker would
 * keep the thread entirely free, but the published game page cannot count on
 * being allowed to start one; slices work wherever the page does. The
 * thinking time is wall-clock time from the moment it starts, the page's own
 * drawing included.
 *
 * Its randomness and its die are its own, seeded from the game's die seed, so
 * the games it plays in its head never use up a real roll.
 */
export function hotseatComputer(game: HotseatGame): AiPlayer {
  return pageComputer(game.state, `computer-${game.setup.diceSeed}`, (state, subject) => {
    const seat = state.players.find((player) => player.id === subject)?.seat;
    return seat === undefined ? undefined : game.setup.seats[seat - 1]?.thinkingSeconds;
  });
}

/**
 * The computer thinking on this page, for as many seconds as `secondsFor`
 * gives the seat: hot seat's computer seats, and online the computer seats of
 * a game this page's player is the game master of (§12.1, plan phase 7 item
 * 8). `seed` seeds the games it plays in its head. `opened` is the game as it
 * stands when the page opens it.
 *
 * The cheapest routes from every node of the map are worked out here, as the
 * game opens, and every move after reads them (`routeTable`), so no thinking
 * time goes on searching for a route again. [Q235, 891 A] The route lists are
 * worked out in the background from here on, between its moves, nearest the
 * figures first, carrying on from the ones worked out while the game was set up.
 */
export function pageComputer(
  opened: GameState,
  seed: string,
  secondsFor: (state: GameState, subject: PlayerId) => number | undefined,
): AiPlayer {
  const map = opened.map;
  const config = map.ruleset.config;
  carryRouteListsOver(map);
  routeTable(map.graph, config);
  if (opened.status === 'in_progress' && opened.players.some((player) => player.control === 'ai')) {
    workOutRouteLists(map, figuresOf(opened));
  }
  const rng = createRng(seed);
  const dice = createDiceSource(rng.fork('dice'), config);

  return {
    chooseAction(state: GameState, subject: PlayerId, cancel?: Cancellation): Promise<ComputerTurn> {
      const seconds = secondsFor(state, subject);
      if (seconds === undefined) return Promise.reject(new RangeError(`no seat for ${subject}`));

      // While it thinks, it works out the lists it needs itself.
      pauseRouteLists();
      const thinking = startComputerMove(state, subject, { config, thinkingMs: seconds * 1000, rng, dice, now: () => performance.now() });
      return new Promise((resolve, reject) => {
        const slice = (): void => {
          if (cancel?.aborted === true) return;
          try {
            if (thinking.step(SLICE_MS)) {
              const { buy, action } = thinking.move();
              resolve({ buy, action });
              workOutRouteLists(map, figuresOf(state));
            } else handBack(slice);
          } catch (error) {
            reject(error);
            workOutRouteLists(map, figuresOf(state));
          }
        };
        handBack(slice);
      });
    },
  };
}

/** Where every figure stands. */
function figuresOf(state: GameState): NodeId[] {
  return state.players.map((player) => player.position);
}

/** [Q235] The route lists being worked out in the background, one map at a time. */
interface RouteListWork {
  readonly map: GameMap;
  /** The nodes whose lists to work out, in order. */
  readonly order: readonly NodeId[];
  next: number;
  running: boolean;
}

let routeListWork: RouteListWork | null = null;

/**
 * [Q235, 890-894] Works out the route lists the computer reads
 * (`RouteTable.routesFrom`) ahead, in the background, starting with the
 * nodes nearest `from`: the starting place while the game is set up, the
 * figures once it is under way. Only the page that thinks for the computers
 * asks: the hot seat page, or online the game master's, from the moment setup
 * has the map and a computer seat (890 A), and on between the computer's moves
 * (891 A). Nothing on screen shows it (893 A), and phones do the same (894 A).
 *
 * Each list is a few milliseconds' work. They are worked out one at a time
 * while the browser is idle, so the page keeps drawing, and not while the
 * computer thinks (`pauseRouteLists`). A list already worked out is not
 * worked out again. Asking again, for this map or another, starts over in
 * the new order and drops the work asked for before.
 *
 * Returns a function that stops this work, and nothing asked for since.
 */
export function workOutRouteLists(map: GameMap, from: readonly NodeId[]): () => void {
  carryRouteListsOver(map);
  const table = routeTable(map.graph, map.ruleset.config);
  const job: RouteListWork = { map, order: nearestFirst(table, from, map.graph.nodes.length), next: 0, running: true };
  routeListWork = job;
  whenIdle((timeLeft) => workOn(job, table, timeLeft));
  return () => {
    job.running = false;
  };
}

/** [Q235] Stops the route lists being worked out in the background until they are asked for again. */
export function pauseRouteLists(): void {
  if (routeListWork !== null) routeListWork.running = false;
}

/**
 * [Q235] An online game's map arrives from the server as a copy of the one the
 * game master's page drew while setting it up: that copy reads the route lists
 * already worked out for the drawn one (`shareRouteTable`).
 */
function carryRouteListsOver(map: GameMap): void {
  const known = routeListWork?.map;
  if (known === undefined || known === map) return;
  shareRouteTable(known.graph, known.ruleset.config, map.graph, map.ruleset.config);
}

function workOn(job: RouteListWork, table: RouteTable, timeLeft: () => number): void {
  if (routeListWork !== job || !job.running) return;
  do {
    table.routesFrom(job.order[job.next] as NodeId);
    job.next += 1;
  } while (job.next < job.order.length && timeLeft() > 0);
  if (job.next < job.order.length) whenIdle((left) => workOn(job, table, left));
  else job.running = false;
}

/** Every node of the map, nearest any of `from` first, by the cheapest route; ties by node id. */
function nearestFirst(table: RouteTable, from: readonly NodeId[], count: number): NodeId[] {
  const cost = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  for (const source of from) {
    const costs = table.from(source).costs;
    for (let node = 0; node < count; node++) cost[node] = Math.min(cost[node] as number, costs[node] as number);
  }
  const nodes = Array.from({ length: count }, (_, node) => asNodeId(node));
  return nodes.sort((a, b) => (cost[a] === cost[b] ? a - b : (cost[a] as number) < (cost[b] as number) ? -1 : 1));
}

/**
 * Run `next` once the browser is idle, telling it how many milliseconds it
 * has; where it cannot say (a browser without `requestIdleCallback`, or no
 * browser at all), after the next frame as the computer's thinking does, with
 * `ROUTE_LIST_SLICE_MS`.
 */
function whenIdle(next: (timeLeft: () => number) => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback((deadline) => next(() => deadline.timeRemaining()), { timeout: 250 });
    return;
  }
  handBack(() => {
    const until = performance.now() + ROUTE_LIST_SLICE_MS;
    next(() => until - performance.now());
  });
}

/**
 * Run `next` once the page has drawn its next frame. Waiting on a message
 * alone is not enough: a browser may run message after message and put the
 * frame off, which is what a first try did. So the wait is for the frame's
 * callback, and then a message, which runs once that frame has been painted.
 * A hidden page draws no frames, and there (and outside a browser) it is the
 * message alone. A message rather than `setTimeout(0)`, which browsers hold
 * back by 4 ms once it nests.
 */
function handBack(next: () => void): void {
  const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  if (visible) requestAnimationFrame(() => afterMessage(next));
  else afterMessage(next);
}

function afterMessage(next: () => void): void {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    next();
  };
  channel.port2.postMessage(null);
}
