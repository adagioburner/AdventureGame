import { useEffect, useRef } from 'react';
import { poiAt, unclaimedGoldUnits, type GameEvent, type GameState, type PlayerId, type Point } from '@adventure/core';
import type { ArtCatalog } from '../art/catalog.ts';
import type { PlayedTurn, Purchase } from '../modes/hotseat.ts';
import { GUARD_LABEL, STAT_LABEL, STAT_ORDER } from './journal.ts';
import { Die, Portrait, StatIcon } from './Sprites.tsx';

/**
 * What a turn ended on, when it ended on a guarded POI (§8): the die, the skill
 * added to it and the guard strength it was compared against, whichever way
 * it went. It stays until OK. An unguarded claim shows a `ClaimNotice` instead.
 */
export function ResultCard({ catalog, turn, rolling, onClose }: { catalog: ArtCatalog; turn: PlayedTurn; rolling: boolean; onClose: () => void }) {
  const interacted = turn.events.find((event): event is Extract<GameEvent, { type: 'interacted' }> => event.type === 'interacted');
  const reward = interacted?.resolution.reward ?? null;
  if (interacted === undefined || reward === null) return null;
  const { roll, skillUsed, claimed } = interacted.resolution;
  const guard = poiAt(turn.after.map, interacted.resolution.node)?.guard ?? null;
  if (roll === null || skillUsed === null || guard === null) return null;
  const avatar = turn.after.players.find((player) => player.id === turn.player)?.avatarId ?? '';
  const prize = `${reward.units} ${STAT_LABEL[reward.kind]}`;
  const className = `card result${rolling ? ' rolling' : claimed ? ' took' : ' missed'}`;

  return (
    <div className={className} role="status" aria-live="polite">
      <header>
        <Portrait catalog={catalog} avatarId={avatar} size={40} label={turn.name} />
        <h2>{`${turn.name} faces a ${GUARD_LABEL[guard.type]} guard of ${guard.strength}`}</h2>
      </header>
      <div className="roll">
        <Die catalog={catalog} value={roll.value} rolling={rolling} size={72} />
        {rolling ? (
          <p className="sum">Rolling…</p>
        ) : (
          <p className="sum">
            <b>{roll.value}</b> rolled + <b>{turn.statsBefore[skillUsed]}</b> {STAT_LABEL[skillUsed]} ={' '}
            <b>{roll.value + turn.statsBefore[skillUsed]}</b> against <b>{guard.strength}</b>
          </p>
        )}
      </div>
      {rolling ? null : (
        <p className="outcome">
          {claimed
            ? `More than ${guard.strength}: the guard is beaten. +${prize}.`
            : `Not more than ${guard.strength}: the ${STAT_LABEL[reward.kind]} stays on the space.`}
        </p>
      )}
      {rolling ? null : (
        <button className="btn" type="button" onClick={onClose}>
          OK
        </button>
      )}
    </div>
  );
}

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
  return <FloatingNotice player={turn.player} text={`${STAT_LABEL[reward.kind]} +${reward.units}`} {...timing} />;
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
  return <FloatingNotice player={purchase.player} text={text} {...timing} />;
}

interface NoticeTiming {
  /** Where the top of a player's figure shows on the map right now. */
  locate: (player: PlayerId) => Point | null;
  stayMs: number;
  appearMs: number;
  fadeMs: number;
}

/** A small card on a player's figure that fades in, drifts up, and fades out. */
function FloatingNotice({ player, text, locate, stayMs, appearMs, fadeMs }: { player: PlayerId; text: string } & NoticeTiming) {
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
      <div ref={card} className="claim">
        <h2>{text}</h2>
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
