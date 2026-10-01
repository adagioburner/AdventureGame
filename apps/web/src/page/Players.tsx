import { useEffect, useRef } from 'react';
import { TERRAINS } from '@adventure/config';
import type { GameState, PlayerId } from '@adventure/core';
import type { ArtCatalog } from '../art/catalog.ts';
import { STAT_LABEL, STAT_ORDER } from './journal.ts';
import { Portrait, StatIcon } from './Sprites.tsx';

/**
 * [SOURCE §6] "Per-player stats, uncapped: stamina, plains/forest/mountain
 * moving skill levels, fighting skill, magic skill, gold. Displayed for every
 * player to see, next to name and avatar."
 * [SOURCE §7.2] "The current player's name and avatar are prominently
 * displayed."
 *
 * Every number is read straight off the engine's `GameState`.
 *
 * [Q54, 31 and 33] Online, a player with no connection has "Away" on their card.
 * [Q56, 57] One who resigned reads "Resigned · the computer plays".
 *
 * [Andrei, 2026-09-30] Q120: "clicking on a player's card finds this player
 * on the map", every card, during the game and after it ends (474), by
 * `onFind`. On a laptop the pointer turns into a hand over a card, which
 * otherwise looks as before (472).
 */
export function Players({
  catalog,
  state,
  away,
  onFind,
}: {
  catalog: ArtCatalog;
  state: GameState;
  away?: ReadonlySet<PlayerId> | undefined;
  onFind?: ((player: PlayerId) => void) | undefined;
}) {
  const playing = state.status === 'in_progress';
  const list = useRef<HTMLElement | null>(null);
  // [Andrei, 2026-09-24] Q53: four or five cards scroll in their own column
  // (Q52), so at the start of each turn the column glides until the current
  // player's card shows. Only the column moves, and only if the card is out of
  // view. [Q58, 79] On a phone held upright the cards sit in one row, which
  // slides the same way, sideways, until the current card starts the row: the
  // row settles on a card's start (78), and would pull a slide that stopped
  // anywhere else back to where it was.
  const turn = playing ? `${state.turn.number}:${state.turn.activeSeat}` : null;
  useEffect(() => {
    const cards = list.current;
    const card = cards?.querySelector<HTMLElement>('.player.current') ?? null;
    if (turn === null || cards === null || card === null) return;
    const view = cards.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const style = getComputedStyle(cards);
    if (style.display === 'flex') {
      if (box.left < view.left || box.right > view.right) cards.scrollBy({ left: box.left - view.left, behavior: 'smooth' });
      return;
    }
    if (cards.scrollHeight <= cards.clientHeight) return;
    const padding = parseFloat(style.paddingTop) || 0;
    const by = box.top < view.top + padding ? box.top - view.top - padding : box.bottom > view.bottom - padding ? box.bottom - view.bottom + padding : 0;
    if (by !== 0) cards.scrollBy({ top: by, behavior: 'smooth' });
  }, [turn]);
  return (
    <section className="players" aria-label="Players" ref={list}>
      {state.players.map((player) => {
        const current = playing && player.seat === state.turn.activeSeat;
        const winner = state.winners.includes(player.id);
        return (
          <article
            key={player.id}
            className={`player${current ? ' current' : ''}${winner ? ' winner' : ''}${onFind === undefined ? '' : ' findable'}`}
            aria-current={current ? 'true' : undefined}
            onClick={onFind === undefined ? undefined : () => onFind(player.id)}
          >
            <header>
              <Portrait catalog={catalog} avatarId={player.avatarId} size={current ? 52 : 40} label={`${player.name}’s avatar`} />
              <div className="who">
                <h2>{player.name}</h2>
                <span className="tag">
                  {winner
                    ? 'Winner'
                    : current
                      ? `Turn ${state.turn.number} · playing now`
                      : player.resigned
                        ? 'Resigned · the computer plays'
                        : `Seat ${player.seat}`}
                  {away?.has(player.id) === true ? ' · Away' : null}
                </span>
              </div>
            </header>
            {/* [Q140] On a laptop STAT_ORDER fills four rows a column at a
                time: what moves a player on the left, the rest on the right
                with gold last and red. */}
            <ul className="stats">
              {STAT_ORDER.map((kind) => (
                <li key={kind} className={kind === 'gold' ? 'gold' : undefined} title={STAT_LABEL[kind]}>
                  <StatIcon catalog={catalog} kind={kind} size={18} />
                  <b>{player.stats[kind]}</b>
                  <span className="label">{STAT_LABEL[kind]}</span>
                </li>
              ))}
            </ul>
            {current ? (
              <p className="allowance">
                Free steps left this turn:{' '}
                {TERRAINS.map((terrain) => `${terrain} ${state.turn.allowance[terrain]}`).join(' · ')}
              </p>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
