import { useEffect, useRef, type ReactNode } from 'react';
import { poiAt, rewardAmount, unclaimedGoldUnits, type GameEvent, type GameState, type PlayerId, type Point } from '@adventure/core';
import type { ArtCatalog } from '../art/catalog.ts';
import type { PlayedTurn, Purchase } from '../modes/hotseat.ts';
import { GUARD_LABEL, STAT_LABEL, STAT_ORDER } from './journal.ts';
import { Die, Portrait, StatIcon } from './Sprites.tsx';

/** How far a claim's notice drifts while it is up, in CSS pixels: from a little over the head to about 40 above it. */
const NOTICE_RISE = { from: 6, to: -40 };
/** The gap between the figure's head and the notice's bottom edge, in CSS pixels. */
const NOTICE_GAP = 2;

/**
 * [Andrei, 2026-09-24] An unguarded claim's notice: "can the disappearing card
 * be smaller? i would prefer it if it was floating up from the figure as it
 * lands on the POI". From a preview he picked a small card, the result card's
 * look shrunk, up for 2 seconds (`stayMs`). It says only what was taken, as
 * "plains speed +2", fades in over `appearMs`, drifts up the whole time and
 * fades out over `fadeMs`. It sits on the figure's head every frame, so it
 * keeps its size at any zoom and moves with the figure through a pan. The page
 * takes it away once it has faded.
 */
export function ClaimNotice({ turn, ...timing }: { turn: PlayedTurn } & NoticeTiming) {
  const interacted = turn.events.find((event): event is Extract<GameEvent, { type: 'interacted' }> => event.type === 'interacted');
  const reward = interacted?.resolution.reward ?? null;
  if (reward === null) return null;
  return (
    <FloatingNotice player={turn.player} {...timing}>
      <h2>{`${STAT_LABEL[reward.kind]} +${rewardAmount(reward, turn.after.map.ruleset.config)}`}</h2>
    </FloatingNotice>
  );
}

/**
 * [Andrei, 2026-10-26] Q314: "your own and other players fights pop up and
 * disrupt your planning". A guard fight floats on the fighter's head as a
 * claim's notice does, every player's fights, your own included, with no OK
 * (3). Over the guard's kind and strength the die tumbles, then the notice
 * says whether the guard was beaten, with the sum under it (1 A): green when
 * it was, red when it held. It stays 3 seconds (2) and fades as a claim's
 * notice does. `stayMs` counts from the start of the tumble.
 */
export function FightNotice({ catalog, turn, rolling, ...timing }: { catalog: ArtCatalog; turn: PlayedTurn; rolling: boolean } & NoticeTiming) {
  const interacted = turn.events.find((event): event is Extract<GameEvent, { type: 'interacted' }> => event.type === 'interacted');
  const reward = interacted?.resolution.reward ?? null;
  if (interacted === undefined || reward === null) return null;
  const { roll, skillUsed, claimed } = interacted.resolution;
  const guard = poiAt(turn.after.map, interacted.resolution.node)?.guard ?? null;
  if (roll === null || skillUsed === null || guard === null) return null;
  const skill = turn.statsBefore[skillUsed];
  const kind = GUARD_LABEL[guard.type];
  return (
    <FloatingNotice player={turn.player} className={rolling ? 'rolling' : claimed ? 'took' : 'missed'} {...timing}>
      <div className="fight">
        <Die catalog={catalog} value={roll.value} rolling={rolling} size={40} />
        {rolling ? (
          <h2>{`${kind.charAt(0).toUpperCase()}${kind.slice(1)} guard of ${guard.strength}`}</h2>
        ) : (
          <div>
            <h2>{claimed ? `Guard beaten: ${STAT_LABEL[reward.kind]} +${rewardAmount(reward, turn.after.map.ruleset.config)}` : 'Guard holds'}</h2>
            <p className="fight-sum">{`${roll.value} + ${skill} ${STAT_LABEL[skillUsed]} = ${roll.value + skill} against ${guard.strength}`}</p>
          </div>
        )}
      </div>
    </FloatingNotice>
  );
}

/**
 * [Q190] Andrei, 2026-10-02: "Their purchase panel should open, with the
 * purchases they made, and stay open for some time", then "another option is
 * to have a small panel floating up similar to when you claim a reward", which
 * he chose (774): "Basically the purchase notice works the same way as
 * claiming a reward, but happens before the walk, not after". So it is the
 * claim's notice, on the buyer's figure, with the claim's timing (775).
 */
export function PurchaseNotice({ purchase, text, ...timing }: { purchase: Purchase; text: string } & NoticeTiming) {
  return (
    <FloatingNotice player={purchase.player} {...timing}>
      <h2>{text}</h2>
    </FloatingNotice>
  );
}

interface NoticeTiming {
  /** Where the top of a player's figure shows on the map right now. */
  locate: (player: PlayerId) => Point | null;
  stayMs: number;
  appearMs: number;
  fadeMs: number;
}

/** A small card on a player's figure that fades in, drifts up, and fades out. */
function FloatingNotice({
  player,
  className,
  children,
  locate,
  stayMs,
  appearMs,
  fadeMs,
}: { player: PlayerId; className?: string; children: ReactNode } & NoticeTiming) {
  const anchor = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const follow = (): void => {
      const element = anchor.current;
      const at = locate(player);
      if (element !== null) {
        element.style.visibility = at === null ? 'hidden' : '';
        if (at !== null) {
          element.style.left = `${at.x}px`;
          element.style.top = `${at.y - NOTICE_GAP}px`;
        }
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [locate, player]);

  useEffect(() => {
    const total = stayMs + fadeMs;
    if (card.current === null || total <= 0) return;
    const rise = (t: number): string => `translateY(${NOTICE_RISE.from + (NOTICE_RISE.to - NOTICE_RISE.from) * t}px)`;
    const shown = Math.min(1, appearMs / total);
    const fading = Math.max(shown, stayMs / total);
    const animation = card.current.animate(
      [
        { offset: 0, opacity: 0, transform: rise(0) },
        { offset: shown, opacity: 1, transform: rise(shown) },
        { offset: fading, opacity: 1, transform: rise(fading) },
        { offset: 1, opacity: 0, transform: rise(1) },
      ],
      { duration: total, easing: 'linear', fill: 'forwards' },
    );
    return () => animation.cancel();
  }, [stayMs, appearMs, fadeMs]);

  return (
    <div ref={anchor} className="claim-anchor" role="status" aria-live="polite">
      <div ref={card} className={className === undefined ? 'claim' : `claim ${className}`}>
        {children}
      </div>
    </div>
  );
}

/**
 * [SOURCE §2] The game ends when one player's gold lead exceeds the gold still
 * on the map, or in a shared victory when players are tied with none left.
 * The engine decides that; this only says who and shows the final stats.
 */
export function EndCard({
  catalog,
  state,
  newGameLabel = 'New game',
  onNewGame,
  onClose,
}: {
  catalog: ArtCatalog;
  state: GameState;
  /** [Q56, 61 and Q72, 286] Online the button reads "Games". */
  newGameLabel?: string | undefined;
  onNewGame: () => void;
  onClose: () => void;
}) {
  const winners = state.players.filter((player) => state.winners.includes(player.id));
  const left = unclaimedGoldUnits(state);
  const names = listOf(winners.map((player) => player.name));
  // [Q85, 291 and 293] A game the game master ends goes to the most gold, as
  // one that runs out of time does. [Q56, 61] One the game master ended before
  // that has no winner.
  const unwon = state.ending === 'game_master' && winners.length === 0;
  const title = unwon
    ? 'The game master ended this game.'
    : winners.length === 1
      ? `${winners[0]?.name ?? ''} wins!`
      : `Shared victory: ${winners.map((player) => player.name).join(' and ')}`;
  const ranked = [...state.players].sort((a, b) => b.stats.gold - a.stats.gold);
  const [first, second] = ranked;
  const why = unwon
    ? null
    : state.ending === 'game_master'
      ? winners.length > 1
        ? `The game master ended the game with ${names} on ${first?.stats.gold ?? 0} gold each.`
        : `The game master ended the game. ${names} held the most gold, ${first?.stats.gold ?? 0} against ${second?.stats.gold ?? 0}.`
      : state.ending === 'time_out'
        ? winners.length > 1
          ? `Time ran out with ${names} on ${first?.stats.gold ?? 0} gold each.`
          : `Time ran out. ${names} held the most gold, ${first?.stats.gold ?? 0} against ${second?.stats.gold ?? 0}.`
        : winners.length > 1
          ? `Tied on ${first?.stats.gold ?? 0} gold with no gold left on the map.`
          : `${first?.stats.gold ?? 0} gold against ${second?.stats.gold ?? 0}: a lead of ${(first?.stats.gold ?? 0) - (second?.stats.gold ?? 0)}, more than the ${left} gold left on the map.`;

  return (
    <div className="card end" role="dialog" aria-label="The game is over">
      <h2>{title}</h2>
      <p className="outcome">
        {why === null ? null : `${why} `}Game over after {state.turn.number} turns.
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Player</th>
            {STAT_ORDER.map((kind) => (
              <th key={kind} scope="col" title={STAT_LABEL[kind]}>
                <StatIcon catalog={catalog} kind={kind} size={16} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ranked.map((player) => (
            <tr key={player.id} className={state.winners.includes(player.id) ? 'winner' : ''}>
              <th scope="row">
                <Portrait catalog={catalog} avatarId={player.avatarId} size={24} label="" />
                {player.name}
              </th>
              {STAT_ORDER.map((kind) => (
                <td key={kind}>{player.stats[kind]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons">
        <button className="btn primary" type="button" onClick={onNewGame}>
          {newGameLabel}
        </button>
        <button className="btn" type="button" onClick={onClose}>
          Look at the map
        </button>
      </div>
    </div>
  );
}

/** "Bea", "Bea and Cal", "Bea, Cal and Dan". */
function listOf(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
