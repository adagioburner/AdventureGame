import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  applyAction,
  buyableNow,
  previewPath,
  type BuyAction,
  type DiceSource,
  type GameEvent,
  type GameState,
  type NodeId,
  type PathPreview,
  type PlayerId,
  type PoiRuntimeState,
  type PlayerState,
  type Point,
  type TurnAction,
} from '@adventure/core';
import { GLIDE_MS } from '../interaction/camera.ts';
import { createMoveModeController, type EnterRefusal, type MoveModeState } from '../interaction/moveMode.ts';
import type { Pick } from '../interaction/picking.ts';
import type { PlayedTurn, Purchase } from '../modes/hotseat.ts';
import type { PlayedChange, PlaySource, PlayUpdate } from '../modes/play.ts';
import { position } from '../render/geometry.ts';
import type { LoadedArt } from '../render/pixi/textures.ts';
import type { FigureCue, MapScene, Walker } from '../render/sceneModel.ts';
import { endingSound, isRest, returnedSites } from '../sound/cues.ts';
import { soundTableOf, sounds } from '../sound/player.ts';
import { BuyPanel } from './BuyPanel.tsx';
import { ClaimNotice, EndCard, PurchaseNotice, ResultCard } from './Cards.tsx';
import { isUnguardedClaim, journalEntry, purchaseEntry, purchaseNotices, type JournalEntry } from './journal.ts';
import { MapView, type MapHandle } from './MapView.tsx';
import { Players } from './Players.tsx';
import { TurnControls } from './TurnControls.tsx';
import { TurnLog } from './TurnLog.tsx';

/** The page's phone layout, as `index.html` switches to it. */
export const PHONE = '(max-width: 899px)';

/**
 * How long End Turn's walk takes per step, the die tumbles, a notice stays up,
 * and an unguarded claim's notice takes to fade in, stays up (2 seconds, his
 * pick) and takes to fade out; how long a computer's die card stays up
 * (3 seconds, Q42); how long a figure found from its card stands on its
 * ring (2 seconds, [Q120, 471]); how long, with Track pressed, the map
 * stays on a site a speed or skill came back to (1.5 seconds, Q135, 541); and
 * how long the figure on turn blinks over a route saved from the turn before
 * (2 seconds, [Q145, 574]).
 */
export const timing = {
  stepMs: 220,
  tumbleMs: 1100,
  noticeMs: 2200,
  appearMs: 200,
  claimMs: 2000,
  fadeMs: 500,
  computerCardMs: 3000,
  foundMs: 2000,
  respawnStayMs: 1500,
  savedRouteBlinkMs: 2000,
};

interface GameScreenProps {
  readonly art: LoadedArt;
  readonly scene: MapScene;
  readonly play: PlaySource;
  readonly logOpen: boolean;
  /** [Q54, 31 and 33] Online, the players with no connection. */
  readonly away?: ReadonlySet<PlayerId> | undefined;
  /** [Q54, 31 and 33] Online, what the game shown waits on when someone is away; `null` when nobody is. */
  readonly waitingOn?: ((state: GameState) => string | null) | undefined;
  /** [Q56, 71] Online, the connection to the server is down and being brought back. */
  readonly offline?: boolean;
  /** [Q56, 58] Online, the message board, shown where the turn log is while it is open. */
  readonly board?: ReactNode;
  /** [Q56, 61] What the end card's button reads: "New game" unless given. */
  readonly newGameLabel?: string;
  onCloseLog(): void;
  onNewGame(): void;
}

/** The route a turn's walk is shown along: the one drawn when it was committed. */
interface Planned {
  readonly path: PathPreview | null;
  readonly waypoint: NodeId | null;
}

/**
 * One game on the §7.1 UI: a hotseat game (§7.2), with no out-of-turn
 * planning, or a stored game the server plays (`play`).
 *
 * End Turn plays out in three beats — the figure walks the steps the engine
 * says it walked, the die tumbles if a guard was faced, then the new state is
 * shown and the next seat's controls come up. The engine has resolved the
 * whole turn before the first beat; the beats only reveal it. Turns are shown
 * one after another, in the order `play` reports them.
 */
export function GameScreen({
  art,
  scene,
  play: source,
  logOpen,
  away,
  waitingOn,
  offline = false,
  board = null,
  newGameLabel,
  onCloseLog,
  onNewGame,
}: GameScreenProps) {
  const catalog = art.catalog;
  const [shown, setShown] = useState<GameState>(source.state);
  const [move, setMove] = useState<MoveModeState>({ kind: 'idle' });
  const [armed, setArmed] = useState(false);
  const [walker, setWalker] = useState<Walker | null>(null);
  const [inFlight, setInFlight] = useState<{ path: PathPreview | null; waypoint: NodeId | null } | null>(null);
  const [result, setResult] = useState<{ turn: PlayedTurn; rolling: boolean } | null>(null);
  const [entries, setEntries] = useState<readonly JournalEntry[]>(() => journalOf(source.history));
  const [notice, setNotice] = useState<string | null>(null);
  const [endOpen, setEndOpen] = useState(true);
  // Whether the player planning has picked their figure up; until they do,
  // the current player's figure blinks, even over a route saved from their
  // last turn.
  const [engaged, setEngaged] = useState(false);
  const [planner, setPlanner] = useState<PlayerId | null>(null);
  // [Andrei, 2026-09-25] Q57: the map either follows the players on turn or
  // stays where the viewer put it, and the Track button says which. It is
  // pressed when a game opens (76).
  const [tracking, setTracking] = useState(true);
  // Track as it is now, for a turn's play-out that is still going when it changes.
  const trackingNow = useRef(tracking);
  trackingNow.current = tracking;
  // [Q135, 540] While the sites a turn brought a speed or skill back to are
  // shown, after its claim: the ones still drawn empty, as before the turn,
  // until each is revealed. The next player's turn-start glide waits for it.
  const [returning, setReturning] = useState<ReadonlyMap<NodeId, PoiRuntimeState> | null>(null);
  const drawn = useMemo(() => (returning === null ? shown : withHeld(shown, returning)), [shown, returning]);
  // [Q120, 471] The player whose card was clicked last, while their figure
  // stands on its ring; `click` counts clicks, so clicking the same card again
  // starts the ring's time over.
  const [found, setFound] = useState<{ readonly player: PlayerId; readonly click: number } | null>(null);
  const clicks = useRef(0);
  const handle = useRef<MapHandle | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const busy = inFlight !== null;
  // Online, a turn this page committed that the server has not played yet.
  const [awaiting, setAwaiting] = useState(false);
  // [Q63, 139] Whether sound is on on this device, as the map's Sound button shows it.
  const soundOn = useSyncExternalStore(sounds.subscribe, () => sounds.on);
  useEffect(() => sounds.load(soundTableOf(catalog)), [catalog]);

  const say = useCallback((text: string) => setNotice(text), []);
  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), timing.noticeMs);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // [Q145, 574] The turn shown whose opening blink is over: from then on a
  // route saved from the turn before shows as planned (575). The blink is
  // timed from when the map can glide to the player on turn (Q46): after an
  // unguarded claim's notice and a site coming back (Q135).
  const [settledTurn, setSettledTurn] = useState<number | null>(null);
  const turnShown =
    shown.status === 'in_progress' && !busy && returning === null && !(result !== null && isUnguardedClaim(result.turn)) ? shown.turn.number : null;
  useEffect(() => {
    if (turnShown === null) return;
    const timer = window.setTimeout(() => setSettledTurn(turnShown), timing.savedRouteBlinkMs);
    return () => window.clearTimeout(timer);
  }, [turnShown]);

  useEffect(() => {
    if (found === null) return;
    const timer = window.setTimeout(() => setFound(null), timing.foundMs);
    return () => window.clearTimeout(timer);
  }, [found]);

  // [Andrei, 2026-09-24] "the unguarded poi should produce a card that fades
  // itself. The guarded POI produce a card with a die roll that has an ok
  // button": an unguarded claim's notice has no OK and goes once it has faded.
  useEffect(() => {
    if (result === null || result.rolling || !isUnguardedClaim(result.turn)) return;
    const timer = window.setTimeout(() => setResult(null), timing.claimMs + timing.fadeMs);
    return () => window.clearTimeout(timer);
  }, [result]);
  // [Andrei, 2026-09-24] Q42: "the computer's die panel closes itself, pressing
  // OK is not necessary". OK still closes it sooner. [Q56, 50] Online, so does every other player's:
  // only a card of this page's own player waits for OK.
  useEffect(() => {
    if (result === null || result.rolling || isUnguardedClaim(result.turn)) return;
    if (source.localPlayers.has(result.turn.player)) return;
    const timer = window.setTimeout(() => setResult(null), timing.computerCardMs);
    return () => window.clearTimeout(timer);
  }, [result, source]);
  const locateFigure = useCallback((player: PlayerId) => handle.current?.screenOfFigure(player) ?? null, []);

  const commit = useRef<(action: TurnAction) => void>(() => undefined);
  /** Commit a turn to `play`, keeping `planned` to walk it along when it comes back, after what a computer `buy`s first. */
  const play = useRef<(action: TurnAction, planned: Planned, buy?: BuyAction | null) => void>(() => undefined);
  // [Q190] The turn the buy panel was opened on; online, whether a purchase this page sent is not played yet.
  const [buyTurn, setBuyTurn] = useState<number | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  // [Q190, 774] Another player's purchase floating up from their figure, while it shows.
  const [bought, setBought] = useState<{ readonly purchase: Purchase; readonly text: string; readonly key: number } | null>(null);
  const boughtKey = useRef(0);
  /** The route of the turn this page committed last, until that turn is shown. */
  const committed = useRef<{ readonly turn: number; readonly planned: Planned } | null>(null);
  const controller = useMemo(
    () =>
      createMoveModeController({
        mode: source.mode,
        localPlayers: source.localPlayers,
        commit: (action) => commit.current(action),
      }),
    [source],
  );
  // [Q56, 53] Online, the route being drawn is saved on the server as it is
  // drawn: what was sent last, until the game shows it saved.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    const sync = (): void => {
      setMove(controller.state);
      setArmed(controller.waypointArmed);
      setEngaged(controller.engaged);
      setPlanner(controller.planner);
      // [Q57, 73] Picking a figure up, or changing its route, is planning: Track unpresses.
      if (controller.engaged) setTracking(false);
      const save = source.savePlan;
      const who = controller.planner;
      if (save === null || who === null) return;
      const saved = savedRouteKey(source.state, who);
      if (sent.current === saved) sent.current = null;
      const now = controller.state;
      // [Q210, 818 B] So is a route picked again for speeds bought, though it stays down.
      if (!(controller.engaged || controller.repicked) || now.kind !== 'previewing') return;
      const key = routeKey(now.path, now.waypoint);
      if (key === saved || key === sent.current) return;
      if (save(who, now.path, now.waypoint)) sent.current = key;
    };
    const unsubscribe = controller.subscribe(sync);
    controller.setGame(source.state);
    sync();
    return unsubscribe;
  }, [controller, source]);

  commit.current = (action) => {
    // The route End Turn committed stays drawn while the figure walks it.
    const planned =
      action.kind === 'move' && move.kind === 'previewing' ? { path: move.preview, waypoint: move.waypoint } : { path: null, waypoint: null };
    play.current(action, planned);
  };
  play.current = (action, planned, buy = null) => {
    committed.current = { turn: source.state.turn.number, planned };
    try {
      source.commit(action, buy);
    } catch (error) {
      committed.current = null;
      say(error instanceof Error ? error.message : String(error));
      controller.setGame(source.state);
      return;
    }
    // Online the turn comes back once the server has played it; until then
    // its route stays drawn and nothing else can be committed.
    if (committed.current !== null) {
      setInFlight(planned);
      setAwaiting(true);
    }
  };

  // Every update `play` reports is shown in turn: a turn plays out before the
  // next one starts, and a change that is not a turn just shows the new state.
  const queue = useRef<PlayUpdate[]>([]);
  const showing = useRef(false);
  const show = useRef<(update: PlayUpdate) => Promise<void>>(async () => undefined);
  show.current = async (update) => {
    if (update.kind === 'refused') {
      setPurchasing(false);
      // What this page committed was not played: its controls come back.
      if (committed.current !== null) {
        committed.current = null;
        setInFlight(null);
        setAwaiting(false);
      }
      controller.setGame(source.state);
      if (update.reason !== null) say(update.reason);
      return;
    }
    const { before, after, turn, purchase = null, movedOn = false, resignedYou = false } = update.change;
    // [Q190] A purchase shows on the cards at once; it has a line in its turn's
    // log entry, or an entry of its own if it ended the game (756).
    if (purchase !== null) {
      if (source.localPlayers.has(purchase.player)) setPurchasing(false);
      if (after.status === 'finished') setEntries((current) => [purchaseEntry(purchase), ...current]);
    }
    // [Q85, 296] Resigned by the game master, whenever it happens.
    if (resignedYou) {
      const name = after.players.find((player) => player.resigned && !before.players.find((was) => was.id === player.id)?.resigned)?.name;
      if (name !== undefined) say(`The game master resigned you. The computer plays ${name} from now on.`);
    }
    if (turn === null || update.shown === 'caught_up') {
      // [Q54, 32] A turn missed while the connection was down is in the log,
      // and the map shows where it left everyone, with no walk.
      if (turn !== null) setEntries((current) => [journalEntry(turn, before, movedOn), ...current]);
      const mine = committed.current;
      if (turn !== null && mine !== null && mine.turn <= before.turn.number) {
        committed.current = null;
        setInFlight(null);
        setAwaiting(false);
      }
      setShown(after);
      controller.setGame(after);
      if (after.status === 'finished') setEndOpen(true);
      if (purchase !== null && update.shown === 'played' && !source.localPlayers.has(purchase.player)) await showPurchase(purchase);
      return;
    }
    const mine = committed.current;
    if (mine !== null && mine.turn <= before.turn.number) {
      committed.current = null;
      setAwaiting(false);
    }
    setResult(null);
    // [Q56, 50] A turn this page did not commit, another player's online, is
    // walked along its own route, drawn as their End turn drew it.
    setInFlight(
      mine !== null && mine.turn === before.turn.number
        ? mine.planned
        : { path: routeOf(before, turn.action), waypoint: turn.action.kind === 'move' ? (turn.action.waypoint ?? null) : null },
    );
    // Whatever happens while it plays out, the turn has been played: the
    // page must end up showing it, never stuck part-way.
    await playOut(turn, before).catch(() => undefined);
    const back = returnedSites(turn.events);
    if (back.length > 0 && turn.after.status === 'in_progress') setReturning(runtimesAt(before, back));
    setWalker(null);
    setShown(turn.after);
    setEntries((current) => [journalEntry(turn, before, movedOn), ...current]);
    setInFlight(null);
    controller.setGame(turn.after);
    if (turn.after.status === 'finished') {
      setEndOpen(true);
      return;
    }
    announce(turn, movedOn);
    await bringBack(turn, back).catch(() => undefined);
    setReturning(null);
  };
  /**
   * [Andrei, 2026-10-02] "Basically the purchase notice works the same way as
   * claiming a reward, but happens before the walk, not after" (Q190, 774
   * and 775). Online every page but the buyer's sees it; on one device, a
   * computer's purchases only (773). Each speed or skill bought floats up on
   * its own (785), one after another, each with the cash register (778), and
   * what the buyer does next waits until the last has faded (776), so
   * purchases made one after another float up one after another (779).
   * Purchases caught up or already in the log when the screen opened never
   * come here (780).
   */
  const showPurchase = async (purchase: Purchase): Promise<void> => {
    for (const text of purchaseNotices(purchase)) {
      boughtKey.current += 1;
      setBought({ purchase, text, key: boughtKey.current });
      sounds.play('purchase');
      await sleep(timing.claimMs + timing.fadeMs);
    }
    setBought(null);
  };
  const announce = (turn: PlayedTurn, movedOn: boolean): void => {
    // [Q56, 55] A player the game master moved on is told so, whenever it happens.
    if (movedOn && source.localPlayers.has(turn.player) && source.mode.allowOutOfTurnPlanning) {
      say('The game master moved you on.');
      return;
    }
    // [Q56, 52] Online, the notice reads "Your turn" on the page of the player whose turn it is.
    const next = turn.after.players[turn.after.turn.activeSeat - 1];
    if (next === undefined) return;
    say(source.mode.allowOutOfTurnPlanning && source.localPlayers.has(next.id) ? 'Your turn' : `${next.name}’s turn`);
  };
  /**
   * [Andrei, 2026-09-30] "we cannot just bring the skill back silently. There
   * has to be a respawn sound, and if Track is pressed, we should bring the
   * respawn site into view" (Q135). Once the turn's walk, die and claim notice
   * are done (540), a site that came back gets its icons back with the far
   * bell (539); with Track pressed the map first glides there as at the start
   * of a turn (Q46) and stays `timing.respawnStayMs` (541) before gliding on
   * to the next player. Without Track the view stays where it is. Turns caught
   * up or already in the log when the screen opened never come here.
   */
  const bringBack = async (turn: PlayedTurn, back: readonly NodeId[]): Promise<void> => {
    if (back.length === 0) return;
    // The claim notice rides on the figure that made the claim: it is seen out first.
    if (isUnguardedClaim(turn)) await sleep(timing.claimMs + timing.fadeMs);
    for (const node of back) {
      if (!trackingNow.current) {
        // Nothing to look at as it happens: whatever is left comes back at once, heard once.
        setReturning(new Map());
        sounds.play('respawn');
        return;
      }
      handle.current?.glideTo(node);
      await sleep(GLIDE_MS);
      setReturning((held) => new Map([...(held ?? [])].filter(([site]) => site !== node)));
      sounds.play('respawn');
      await sleep(timing.respawnStayMs);
    }
  };
  useEffect(() => {
    const drain = async (): Promise<void> => {
      if (showing.current) return;
      showing.current = true;
      for (let update = queue.current.shift(); update !== undefined; update = queue.current.shift()) await show.current(update);
      showing.current = false;
    };
    const unsubscribe = source.subscribe((update) => {
      queue.current.push(update);
      void drain();
    });
    return () => {
      unsubscribe();
      queue.current = [];
    };
  }, [source]);

  /**
   * The walk, then the die: what End Turn shows before the result is revealed.
   * [Q63, 138] Every turn played out here is heard, whoever played it; turns
   * caught up or already in the log when the screen opened never come here.
   */
  const playOut = async (turn: PlayedTurn, before: GameState): Promise<void> => {
    // [Q63, 142] A rest is heard as the turn passes and the resting player's
    // stamina goes up on their card.
    if (isRest(turn.events)) sounds.play('rest');
    const moved = find(turn.events, 'moved');
    if (moved !== undefined && moved.resolution.walked.length > 0) {
      const nodes = [moved.resolution.from, ...moved.resolution.walked].map((node) => position(before.map.graph, node));
      // [Q63, 131] A footstep each time the figure reaches the next node, timed
      // by the sound's own clock so the steps keep the walk's pace however
      // smoothly the map draws.
      for (let node = 1; node < nodes.length; node++) sounds.play('step', (node * timing.stepMs) / 1000);
      await walk(turn.player, nodes, setWalker);
    }
    const interacted = find(turn.events, 'interacted');
    if (interacted === undefined || interacted.resolution.reward === null) return;
    if (interacted.resolution.roll !== null) {
      setResult({ turn, rolling: true });
      await sleep(timing.tumbleMs);
    }
    setResult({ turn, rolling: false });
    // [Q63, 134 and 136] As an unguarded claim's notice appears, or as the die
    // stops and the card shows whether the guard was beaten.
    const ending = endingSound(turn.events);
    if (ending !== null) sounds.play(ending);
  };

  // [Andrei, 2026-09-24] Q42: a computer's turn starts with it thinking for its
  // seat's time, while its figure blinks, and then plays out like a person's
  // End turn: its route drawn, the walk, the die. Leaving the game stops it.
  useEffect(() => {
    const computer = source.computer;
    if (computer === null || busy || shown !== source.state || shown.status !== 'in_progress') return;
    const player = shown.players[shown.turn.activeSeat - 1];
    if (player === undefined || !source.thinksFor(player)) return;
    const cancel = { aborted: false };
    computer.chooseAction(shown, player.id, cancel).then(
      ({ buy, action }) => {
        if (cancel.aborted) return;
        // [Q190, 761] What it bought, then its move; no move if buying ended the game (756).
        if (action !== null) {
          play.current(action, { path: routeOf(afterBuying(shown, buy), action), waypoint: null }, buy);
          return;
        }
        try {
          if (buy !== null) source.buy(buy);
        } catch (error) {
          say(error instanceof Error ? error.message : String(error));
        }
      },
      (error: unknown) => say(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      cancel.aborted = true;
    };
  }, [source, shown, busy, say]);

  // [Andrei, 2026-09-24] "we need to center the map on the current player's
  // figure at the beginning of each turn, both human and AI" (Q46): the map
  // glides there at the zoom it already has, from the first turn on. After an
  // unguarded claim it waits until the claim's notice has faded, since the
  // notice rides on the figure that made the claim. [Q57, 74] Only while Track
  // is pressed; on one device it presses itself at the start of every turn,
  // since a new person is at the screen (77).
  const centeredTurn = useRef<number | null>(null);
  useEffect(() => {
    if (!mapReady || busy || shown.status !== 'in_progress') return;
    if (result !== null && isUnguardedClaim(result.turn)) return;
    if (returning !== null) return;
    if (centeredTurn.current === shown.turn.number) return;
    const player = shown.players[shown.turn.activeSeat - 1];
    if (player === undefined) return;
    centeredTurn.current = shown.turn.number;
    if (source.mode.allowOutOfTurnPlanning && !tracking) return;
    setTracking(true);
    handle.current?.glideTo(player.position);
  }, [mapReady, busy, shown, result, returning, source, tracking]);

  const refuse = (why: EnterRefusal): void => {
    const active = shown.players[shown.turn.activeSeat - 1];
    if (why === 'not_your_turn' && active !== undefined) say(`It is ${active.name}’s turn. In hot seat nobody plans out of turn.`);
  };

  const active = shown.players[shown.turn.activeSeat - 1];
  const online = source.mode.allowOutOfTurnPlanning;
  // [Q56, 48 and 49] Online, a turn that is not this page's player's: they
  // watch it, and can plan their own next move meanwhile.
  const othersTurn = online && active !== undefined && !source.localPlayers.has(active.id);
  /** Who Plan a move plans for: the player on turn on one device, this page's own player online. */
  const planFor = online ? shown.players.find((player) => source.localPlayers.has(player.id)) : active;
  const canPlan = online ? planFor !== undefined : active?.control !== 'ai';
  /** The turn is this page's to play: hot seat's player on turn, or online this page's own. */
  const ownTurn = !othersTurn && active !== undefined && source.localPlayers.has(active.id);
  // [Q190] The person on turn here can buy while they hold the gold for a unit
  // and nothing they did is still playing out. Only Done and Cancel close the
  // panel (766); a turn that moves on under it (the game master's Move on)
  // takes it away, and nothing is bought.
  const buyable = ownTurn && active !== undefined && active.control === 'human' ? buyableNow(shown, active.id) : null;
  const buyOpen = buyable !== null && buyTurn === shown.turn.number;
  const canBuy = buyable !== null && buyable.kinds.length > 0 && shown === source.state && !busy && !purchasing && !offline;
  const buyFor = (canBuy || buyOpen) && active !== undefined ? active : null;
  /** [768] Done: everything picked, bought at once; nothing if nothing was. */
  const finishBuying = (skills: BuyAction['skills']): void => {
    setBuyTurn(null);
    if (skills.length === 0 || active === undefined) return;
    try {
      source.buy({ kind: 'buy', player: active.id, skills });
      // [Q190, 778] The buyer hears the cash register on Done.
      sounds.play('purchase');
      if (online) setPurchasing(true);
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
    }
  };
  const onTap = (target: Pick, shift: boolean): void => {
    if (busy || shown.status !== 'in_progress') return;
    if (controller.state.kind === 'idle') {
      // On one device the figure on turn is the one picked up where figures
      // stand together; online it is this page's own.
      const clicked = online
        ? (target.players.find((player) => source.localPlayers.has(player)) ?? target.players[0])
        : (target.players.find((player) => player === active?.id) ?? target.players[0]);
      // [Q145, 570] On your own turn your figure needs no tap first: a tap
      // on a space, or on another player's figure, chooses that space as it
      // would once your figure is picked up.
      if (ownTurn && clicked !== active?.id) {
        if (target.node === null) return;
        controller.choose(target.node, shift);
        setResult(null);
        return;
      }
      if (clicked === undefined) {
        if (target.node !== null && canPlan) say('Tap your figure, or Plan a move, before choosing where to go.');
        return;
      }
      const refused = controller.enter(clicked);
      if (refused !== null) return refuse(refused);
      setResult(null);
      return;
    }
    // Tapping your own figure while a route is up picks it up; it does not
    // make its own node the destination.
    const planning = controller.planner;
    if (planning !== null && target.players.includes(planning)) {
      controller.engage();
      return;
    }
    const node = target.node;
    if (node === null) return;
    controller.choose(node, shift);
  };

  const plan = (): void => {
    if (planFor === undefined) return;
    const refused = controller.enter(planFor.id);
    if (refused !== null) return refuse(refused);
    setResult(null);
    // A phone shows the whole map too small to find a figure or tap a node,
    // so planning from the button there starts close in on the player.
    if (window.matchMedia(PHONE).matches) handle.current?.centerOn(planFor.position);
  };
  /**
   * [Andrei, 2026-09-30] Q120: "clicking on a player's card finds this player
   * on the map". The map jumps to their figure and zooms in as far as the
   * Find button did (470), which the cards replace (475); Track unpresses
   * (473), and the figure stands on a ring for a moment (471).
   */
  const findPlayer = (player: PlayerId): void => {
    setTracking(false);
    handle.current?.centerOnFigure(player);
    clicks.current += 1;
    setFound({ player, click: clicks.current });
  };
  /**
   * [Q57, 74 and 75] Pressing Track closes planning, keeping the route, and
   * glides the map to the figure walking or else the player on turn; pressing
   * it again unpresses it.
   */
  const pressTrack = (): void => {
    if (tracking) {
      setTracking(false);
      return;
    }
    controller.putDown();
    setTracking(true);
    handle.current?.track(active?.position ?? null);
  };
  /** [Q57, 76] End turn and Rest press Track, without moving the map, so the walk and the turns after it are watched. */
  const endTurn = (rest: boolean): void => {
    if (rest) controller.rest();
    else controller.endTurn();
    if (!controller.engaged) setTracking(true);
  };
  /** Cancel puts the route down, and online clears the saved one too ([Q56, 53]). */
  const cancel = useRef<() => void>(() => undefined);
  cancel.current = () => {
    const who = controller.planner;
    controller.cancel();
    const save = source.savePlan;
    if (save === null || who === null) return;
    const empty = routeKey([], null);
    if (savedRouteKey(source.state, who) === empty && (sent.current === null || sent.current === empty)) return;
    if (save(who, [], null)) sent.current = empty;
  };
  // [Q56, 54] The game master's Move on, asked first, for a person on turn.
  const moveOn = source.moveOn;
  const onMoveOn =
    moveOn !== null && othersTurn && active !== undefined && active.control === 'human'
      ? () => {
          if (!window.confirm(`Play ${active.name}’s saved route now? With none saved, ${active.name} rests.`)) return;
          try {
            moveOn(active);
          } catch (error) {
            say(error instanceof Error ? error.message : String(error));
          }
        }
      : null;
  // [Q85, 294 to 296] The game master's Resign for the person on turn, beside Move on, asked first.
  const resignPlayer = source.resignPlayer;
  const onResign =
    resignPlayer !== null && othersTurn && active !== undefined && active.control === 'human'
      ? () => {
          if (!window.confirm(`Resign ${active.name}? The computer plays ${active.name} from now on.`)) return;
          try {
            resignPlayer(active);
          } catch (error) {
            say(error instanceof Error ? error.message : String(error));
          }
        }
      : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A read-only window for the screenshot scripts and browser checks: where a
  // node is on screen, and the game as the engine holds it.
  useEffect(() => {
    const hooks = {
      state: () => source.state,
      shown: () => shown,
      diceSeed: source.diceSeed,
      busy: () => busy,
      thinking: () => !busy && shown === source.state && shown.status === 'in_progress' && active !== undefined && source.thinksFor(active),
      move: () => controller.state,
      planner: () => (controller.engaged ? controller.planner : null),
      tracking: () => tracking,
      returning: () => returning !== null,
      screenOf: (node: number): Point | null => handle.current?.screenOf(node as NodeId) ?? null,
      figureOf: (player: string): Point | null => handle.current?.screenOfFigure(player as PlayerId) ?? null,
      setTiming: (next: Partial<typeof timing>) => Object.assign(timing, next),
    };
    (window as unknown as { __adventure?: typeof hooks }).__adventure = hooks;
  }, [source, controller, shown, busy, active, tracking, returning]);

  const path = inFlight !== null ? inFlight.path : move.kind === 'previewing' ? move.preview : null;
  // A committed or walking route is the player on turn's; a route being
  // planned is its planner's, online perhaps someone waiting for their turn
  // ([Q56, 49]), so it starts at their figure.
  const pathFrom = inFlight !== null || planner === null ? active?.position : shown.players.find((player) => player.id === planner)?.position;
  const waypoint = inFlight !== null ? inFlight.waypoint : move.kind === 'idle' ? null : move.waypoint;
  // [Andrei, 2026-10-01] Q145: "blink until there's a route planned [...] if
  // the route is saved from previous planning we can blink for a short while
  // and stop". A route brought back blinks for its first 2 seconds (574), then
  // stands on the ring of a route planned (575) without being picked up, so
  // Track stays as it was; tapping the figure stops the blink as before (576).
  const routePlanned = engaged || (move.kind === 'previewing' && settledTurn === shown.turn.number);
  const cue: FigureCue =
    shown.status !== 'in_progress' || busy
      ? 'none'
      : move.kind !== 'idle' && routePlanned && planner === active?.id
        ? 'selected'
        : 'blink';
  // [Q56, 49] Online, a figure picked up out of turn is highlighted as on its own turn.
  const plannerShown =
    shown.status === 'in_progress' && !busy && move.kind !== 'idle' && engaged && planner !== active?.id ? planner : null;

  return (
    <div className="game">
      <Players
        catalog={catalog}
        state={shown}
        away={away}
        onFind={findPlayer}
        buy={buyFor === null ? null : { player: buyFor.id, open: buyOpen, onOpen: () => setBuyTurn(shown.turn.number) }}
      />
      <TurnControls
        state={shown}
        move={move}
        waypointArmed={armed}
        busy={busy}
        awaiting={awaiting}
        buying={buyOpen}
        thinkingMs={thinkingMsOf(source, active)}
        waiting={waitingOn?.(shown) ?? null}
        othersTurn={othersTurn}
        canPlan={canPlan}
        offline={offline}
        onMoveOn={onMoveOn}
        onResign={onResign}
        onPlan={plan}
        onCancel={() => cancel.current()}
        onArmWaypoint={(on) => controller.armWaypoint(on)}
        onClearWaypoint={() => controller.clearWaypoint()}
        onEndTurn={() => endTurn(false)}
        onRest={() => endTurn(true)}
      />
      <div className={`log-host${logOpen || board !== null ? ' open' : ''}`}>
        {board ?? <TurnLog entries={entries} map={source.map} diceSeed={source.diceSeed} onClose={onCloseLog} />}
      </div>
      <main className="stage">
        <MapView
          art={art}
          map={source.map}
          scene={scene}
          state={drawn}
          path={path}
          pathFrom={pathFrom ?? null}
          waypoint={waypoint}
          walker={walker}
          cue={cue}
          planner={plannerShown}
          found={found?.player ?? null}
          onTap={onTap}
          tracking={tracking}
          onTrack={shown.status === 'in_progress' ? pressTrack : undefined}
          // [Q63, 145] Sound stays after the game ends, where Track goes.
          sound={{ on: soundOn, onToggle: () => sounds.setOn(!soundOn) }}
          onMoved={() => setTracking(false)}
          onReady={(ready) => {
            handle.current = ready;
            setMapReady(ready !== null);
          }}
        />
        {buyOpen && buyFor !== null && buyable !== null ? (
          <BuyPanel
            catalog={catalog}
            player={buyFor}
            kinds={buyable.kinds}
            price={buyable.price}
            onDone={finishBuying}
            onCancel={() => setBuyTurn(null)}
          />
        ) : null}
        {notice === null ? null : (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {result === null ? null : isUnguardedClaim(result.turn) ? (
          <ClaimNotice
            key={result.turn.after.turn.number}
            turn={result.turn}
            locate={locateFigure}
            stayMs={timing.claimMs}
            appearMs={timing.appearMs}
            fadeMs={timing.fadeMs}
          />
        ) : (
          <ResultCard catalog={catalog} turn={result.turn} rolling={result.rolling} onClose={() => setResult(null)} />
        )}
        {bought === null ? null : (
          <PurchaseNotice
            key={bought.key}
            purchase={bought.purchase}
            text={bought.text}
            locate={locateFigure}
            stayMs={timing.claimMs}
            appearMs={timing.appearMs}
            fadeMs={timing.fadeMs}
          />
        )}
        {/* The winning turn's own card, or the purchase that won, comes first; OK on a card brings up the end. */}
        {shown.status === 'finished' && endOpen && inFlight === null && result === null && bought === null ? (
          <EndCard catalog={catalog} state={shown} newGameLabel={newGameLabel} onNewGame={onNewGame} onClose={() => setEndOpen(false)} />
        ) : null}
      </main>
    </div>
  );
}

/** The turn log's entries for the turns played before the screen opened, newest first. */
function journalOf(history: readonly PlayedChange[]): JournalEntry[] {
  return history
    .flatMap(({ before, after, turn, purchase = null, movedOn = false }) =>
      turn !== null ? [journalEntry(turn, before, movedOn)] : purchase !== null && after.status === 'finished' ? [purchaseEntry(purchase)] : [],
    )
    .reverse();
}

/** A route as the page compares routes: its steps and its waypoint. */
function routeKey(path: readonly NodeId[], waypoint: NodeId | null): string {
  return `${path.join(' ')}|${path.length === 0 ? '' : (waypoint ?? '')}`;
}

/** The route `player` has saved in `state`. */
function savedRouteKey(state: GameState, player: PlayerId): string {
  const saved = state.players.find((candidate) => candidate.id === player)?.plannedPath ?? null;
  return routeKey(saved?.path ?? [], saved?.waypoint ?? null);
}

/** How long the player on turn thinks, for a computer seat; `null` for a person. */
function thinkingMsOf(source: PlaySource, active: PlayerState | undefined): number | null {
  const seconds = active === undefined ? null : source.thinkingSecondsOf(active);
  return seconds === null ? null : seconds * 1000;
}

/** Walk a figure along `nodes` (world units), one road at a time. */
function walk(player: PlayerId, nodes: readonly Point[], show: (walker: Walker) => void): Promise<void> {
  const steps = nodes.length - 1;
  const total = steps * timing.stepMs;
  return new Promise((resolve) => {
    if (steps <= 0 || total <= 0) {
      resolve();
      return;
    }
    const start = performance.now();
    const frame = (now: number): void => {
      // A frame's timestamp can be a little earlier than `start`.
      const t = Math.min(1, Math.max(0, (now - start) / total));
      const along = t * steps;
      const index = Math.min(steps - 1, Math.floor(along));
      const a = nodes[index] as Point;
      const b = nodes[index + 1] as Point;
      const f = along - index;
      show({ player, at: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f } });
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

/** [Q190] `state` once `buy` is played: no die is rolled for it. The state as it was if it is refused. */
function afterBuying(state: GameState, buy: BuyAction | null): GameState {
  if (buy === null) return state;
  try {
    return applyAction(state, buy, NO_DICE).state;
  } catch {
    return state;
  }
}

const NO_DICE: DiceSource = {
  roll: () => {
    throw new RangeError('a purchase rolls no die');
  },
  pick: () => {
    throw new RangeError('a purchase draws nothing');
  },
};

/** The computer's route as a person's End turn would show it: §7's colours for this turn. */
function routeOf(state: GameState, action: TurnAction): PathPreview | null {
  const player = state.players[state.turn.activeSeat - 1];
  if (action.kind !== 'move' || action.path.length === 0 || player === undefined) return null;
  return previewPath(state.map.graph, player.position, action.path, state.turn.allowance, player.stats.stamina, state.map.ruleset.config);
}

/** `state` with the POIs on `held`'s nodes as they were before they came back: still taken, so drawn empty. */
function withHeld(state: GameState, held: ReadonlyMap<NodeId, PoiRuntimeState>): GameState {
  if (held.size === 0) return state;
  return {
    ...state,
    poiRuntime: state.poiRuntime.map((runtime, index) => {
      const node = state.map.pois[index]?.node;
      return (node === undefined ? undefined : held.get(node)) ?? runtime;
    }),
  };
}

/** What a POI's runtime was in `state`, for each of `nodes` that has one. */
function runtimesAt(state: GameState, nodes: readonly NodeId[]): Map<NodeId, PoiRuntimeState> {
  return new Map(
    nodes.flatMap((node) => {
      const index = state.map.poiByNode.get(node);
      const runtime = index === undefined ? undefined : state.poiRuntime[index];
      return runtime === undefined ? [] : [[node, runtime] as const];
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function find<T extends GameEvent['type']>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}
