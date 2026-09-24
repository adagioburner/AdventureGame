import { useEffect, useRef, useState } from 'react';
import { DEFAULT_RULESET } from '@adventure/config';
import type { GameState } from '@adventure/core';
import type { ClientMessage, Principal, SetupSeat, SetupState } from '@adventure/protocol';
import { atlasOf, type ArtCatalog } from '../art/catalog.ts';
import type { LoadedArt } from '../render/pixi/textures.ts';
import { Figurine } from '../page/Sprites.tsx';
import { ordinal } from './text.ts';

interface SetupPanelProps {
  readonly art: LoadedArt;
  readonly setup: SetupState;
  /** The engine's opening position for these seats, for the stamina each starts with. */
  readonly opening: GameState;
  readonly me: Principal;
  readonly connected: boolean;
  /** [Q48, 11] The game master declined this user's last request. */
  readonly declined: boolean;
  send(message: ClientMessage): boolean;
}

/** A player's name's longest, as on the hot seat panel and the server. */
const NAME_MAX = 24;

/** How long a name may sit half typed before it is sent. */
const NAME_SETTLE_MS = 700;

const RANGES = {
  players: DEFAULT_RULESET.config.players.PLAYER_COUNT,
  thinking: DEFAULT_RULESET.config.ai.THINKING_TIME_SECONDS,
};

/**
 * The online setup panel (§6.1, Q48), in the hot seat panel's style (Q48, 13).
 *
 * The game master picks the player count, 2 to 5 and never below the seats
 * people hold (9), accepts or declines people (7, 11), renames the computer
 * seats and changes their figures (14), sets one thinking time for all of
 * them (15), and starts, with or without empty seats (12, 16). Everyone else
 * asks to join with a name and a figure, which they can change until the start
 * (10), and can withdraw a request or leave (11).
 */
export function SetupPanel({ art, setup, opening, me, connected, declined, send }: SetupPanelProps) {
  const catalog = art.catalog;
  const figures = atlasOf(catalog, catalog.manifest.figurines.sheet).sprites.map((sprite) => sprite.id);
  const gameId = setup.gameId;
  const isGameMaster = setup.gameMaster === me.userId;
  const people = setup.seats.filter((seat) => seat.userId !== null);
  const seated = people.some((seat) => seat.userId === me.userId);
  const request = setup.pending.find((pending) => pending.userId === me.userId) ?? null;
  const starting = setup.phase !== 'setup';
  const idle = !connected || starting;

  return (
    <section className="card setup online" aria-label="Game setup">
      <h2>{setup.name}</h2>
      <p className="muted">
        {starting
          ? 'Starting the game…'
          : isGameMaster
            ? 'You are the game master. Computers play the seats nobody has taken when you start.'
            : `Game master: ${setup.gameMasterName}. Computers play the seats nobody has taken at the start.`}
      </p>
      {connected ? null : (
        <p className="problem" role="status">
          Reconnecting to the server…
        </p>
      )}

      {!seated && !isGameMaster ? (
        <JoinRequestForm
          catalog={catalog}
          figures={figures}
          setup={setup}
          me={me}
          request={request}
          declined={declined}
          disabled={idle}
          send={send}
        />
      ) : null}

      {isGameMaster ? (
        <div className="choice">
          <span>Players</span>
          <div className="control-toggle count" role="radiogroup" aria-label="Number of players">
            {range(RANGES.players.min, RANGES.players.max).map((count) => (
              <button
                key={count}
                type="button"
                role="radio"
                aria-checked={setup.playerCount === count}
                disabled={idle || count < people.length}
                onClick={() => send({ type: 'setup.setPlayerCount', gameId, count })}
              >
                {count}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {setup.seats.map((seat, index) => {
        const mine = seat.userId === me.userId;
        const editable = mine || (isGameMaster && seat.userId === null);
        const stamina = opening.players[index]?.stats.stamina;
        return (
          <fieldset key={seat.id} className="seat">
            <legend>
              Seat {seat.seat} · moves {ordinal(seat.seat)} · starts with {stamina ?? '?'} stamina
            </legend>
            {seatTag(seat, setup, me) === null ? null : <p className="tag">{seatTag(seat, setup, me)}</p>}
            {editable ? (
              <NameAndFigure
                catalog={catalog}
                figures={figures}
                label={`Seat ${seat.seat}`}
                name={seat.name}
                avatarId={seat.avatarId}
                taken={takenFor(setup, seat)}
                disabled={idle}
                onChange={(name, avatarId) => send({ type: 'setup.updateSeat', gameId, seatId: seat.id, name, avatarId })}
              />
            ) : (
              <div className="seated">
                <Figurine catalog={catalog} avatarId={seat.avatarId} size={46} />
                <b>{seat.name}</b>
              </div>
            )}
          </fieldset>
        );
      })}

      {isGameMaster && setup.seats.some((seat) => seat.control === 'ai') ? (
        <ThinkingTime
          seconds={setup.thinkingSeconds}
          disabled={idle}
          onChange={(seconds) => send({ type: 'setup.setThinkingTime', gameId, seconds })}
        />
      ) : null}

      {isGameMaster && setup.pending.length > 0 ? (
        <fieldset className="seat requests">
          <legend>Asking to join</legend>
          {people.length >= setup.playerCount ? (
            <p className="muted">Every seat is taken by a person. Raise the number of players to accept someone.</p>
          ) : null}
          {setup.pending.map((pending) => {
            const holder = figureHolder(setup, pending.requestedAvatarId);
            return (
              <div key={pending.userId} className="request">
                <Figurine catalog={catalog} avatarId={pending.requestedAvatarId} size={40} />
                <div className="who-asks">
                  <b>{pending.requestedName}</b>
                  {holder === null ? null : (
                    <small>
                      {holder.name} has taken this figure. Waiting for {pending.requestedName} to pick another.
                    </small>
                  )}
                </div>
                <div className="buttons">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={idle || people.length >= setup.playerCount || holder !== null}
                    onClick={() => send({ type: 'setup.respondToJoin', gameId, userId: pending.userId, accept: true })}
                  >
                    Accept
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={idle}
                    onClick={() => send({ type: 'setup.respondToJoin', gameId, userId: pending.userId, accept: false })}
                  >
                    Decline
                  </button>
                </div>
              </div>
            );
          })}
        </fieldset>
      ) : null}

      {isGameMaster ? (
        <>
          <button className="btn primary start" type="button" disabled={idle} onClick={() => send({ type: 'setup.start', gameId })}>
            Start the game
          </button>
          <button
            className="btn ghost start"
            type="button"
            disabled={idle}
            onClick={() => {
              if (window.confirm('Cancel this game? It leaves the game list and cannot be started again.'))
                send({ type: 'setup.cancel', gameId });
            }}
          >
            Cancel the game
          </button>
        </>
      ) : seated ? (
        <button className="btn start" type="button" disabled={idle} onClick={() => send({ type: 'setup.leave', gameId })}>
          Leave the game
        </button>
      ) : null}
    </section>
  );
}

/** Whose a seat is, over its name: "You", "Game master", "Computer", or nothing for another person. */
function seatTag(seat: SetupSeat, setup: SetupState, me: Principal): string | null {
  if (seat.userId === null) return 'Computer';
  const tags = [seat.userId === me.userId ? 'You' : null, seat.userId === setup.gameMaster ? 'Game master' : null].filter(
    (tag) => tag !== null,
  );
  return tags.length === 0 ? null : tags.join(' · ');
}

/**
 * The figures greyed out for `seat`, or for a join request when `seat` is
 * null. [Q49, 18] A person may take a computer's figure, and the computer
 * switches, so only other people's are greyed for a person or a request; a
 * computer may take nobody's.
 */
function takenFor(setup: SetupState, seat: SetupSeat | null): ReadonlySet<string> {
  const others = setup.seats.filter((other) => other.id !== seat?.id && (seat?.userId === null || other.userId !== null));
  return new Set(others.map((other) => other.avatarId));
}

/** [Q49, 19] The person who holds `figure`, which a request naming it cannot be accepted with. */
function figureHolder(setup: SetupState, figure: string): SetupSeat | null {
  return setup.seats.find((seat) => seat.userId !== null && seat.avatarId === figure) ?? null;
}

/** [Q48, 10 and 11] Asking to join, changing a request, or asking again after a no. */
function JoinRequestForm({
  catalog,
  figures,
  setup,
  me,
  request,
  declined,
  disabled,
  send,
}: {
  readonly catalog: ArtCatalog;
  readonly figures: readonly string[];
  readonly setup: SetupState;
  readonly me: Principal;
  readonly request: SetupState['pending'][number] | null;
  readonly declined: boolean;
  readonly disabled: boolean;
  send(message: ClientMessage): boolean;
}) {
  const taken = takenFor(setup, null);
  const [draft, setDraft] = useState(() => ({
    name: me.displayName.slice(0, NAME_MAX),
    avatarId: figures.find((id) => !taken.has(id)) ?? figures[0] ?? '',
  }));
  const gameId = setup.gameId;

  if (request !== null) {
    const holder = figureHolder(setup, request.requestedAvatarId);
    return (
      <fieldset className="seat">
        <legend>Your request</legend>
        {holder === null ? (
          <p className="waiting">Waiting for the game master to answer.</p>
        ) : (
          <p className="problem" role="status">
            {holder.name} has taken the figure you asked for. Pick another so the game master can accept you.
          </p>
        )}
        <NameAndFigure
          catalog={catalog}
          figures={figures}
          label="Your request"
          name={request.requestedName}
          avatarId={request.requestedAvatarId}
          taken={taken}
          disabled={disabled}
          onChange={(name, avatarId) => send({ type: 'setup.updateRequest', gameId, name, avatarId })}
        />
        <button className="btn start" type="button" disabled={disabled} onClick={() => send({ type: 'setup.withdraw', gameId })}>
          Withdraw the request
        </button>
      </fieldset>
    );
  }

  const holder = figureHolder(setup, draft.avatarId);
  const ready = draft.name.trim().length > 0 && holder === null;
  return (
    <fieldset className="seat">
      <legend>Join this game</legend>
      {declined ? (
        <p className="problem" role="status">
          The game master declined your request.
        </p>
      ) : null}
      {holder === null ? null : (
        <p className="problem" role="status">
          {holder.name} has just taken the figure you picked. Pick another.
        </p>
      )}
      <NameAndFigure
        catalog={catalog}
        figures={figures}
        label="Your"
        name={draft.name}
        avatarId={draft.avatarId}
        taken={taken}
        disabled={disabled}
        immediate
        onChange={(name, avatarId) => setDraft({ name, avatarId })}
      />
      <button
        className="btn primary start"
        type="button"
        disabled={disabled || !ready}
        onClick={() => send({ type: 'setup.requestJoin', gameId, name: draft.name.trim(), avatarId: draft.avatarId })}
      >
        {declined ? 'Ask again' : 'Ask to join'}
      </button>
    </fieldset>
  );
}

/**
 * A name box and the figurines, as in a hot seat seat. A figure is sent at
 * once; a name when the box loses focus, on Enter, or once typing pauses, so
 * the others don't see every keystroke. `immediate` reports every keystroke,
 * for a form that sends nothing until its button.
 */
function NameAndFigure({
  catalog,
  figures,
  label,
  name,
  avatarId,
  taken,
  disabled,
  immediate = false,
  onChange,
}: {
  readonly catalog: ArtCatalog;
  readonly figures: readonly string[];
  readonly label: string;
  readonly name: string;
  readonly avatarId: string;
  readonly taken: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly immediate?: boolean;
  onChange(name: string, avatarId: string): void;
}) {
  const [draft, setDraft] = useState(name);
  const editing = useRef(false);
  const latest = useRef({ name, avatarId, onChange });
  latest.current = { name, avatarId, onChange };

  // Someone else's change (the server's echo, or the game master renaming a
  // computer from another tab) shows unless this box is being typed in.
  useEffect(() => {
    if (!editing.current) setDraft(name);
  }, [name]);

  const commit = (text: string): void => {
    const trimmed = text.trim();
    const now = latest.current;
    if (trimmed.length > 0 && trimmed !== now.name) now.onChange(trimmed, now.avatarId);
  };

  useEffect(() => {
    if (immediate) return;
    const timer = window.setTimeout(() => commit(draft), NAME_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, immediate]);

  return (
    <>
      <label>
        <span>Name</span>
        <input
          value={draft}
          maxLength={NAME_MAX}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          name={`${label.toLowerCase().replace(/\W+/g, '-')}-name`}
          onFocus={() => {
            editing.current = true;
          }}
          onBlur={() => {
            editing.current = false;
            commit(draft);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(draft);
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            if (immediate) onChange(event.target.value, avatarId);
          }}
        />
      </label>
      <div className="figurines" role="radiogroup" aria-label={`${label} figurine`}>
        {figures.map((id) => {
          const held = taken.has(id);
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={avatarId === id}
              aria-label={`Figurine ${id.replace(/\D+/g, '')}${held ? ', taken' : ''}`}
              disabled={disabled || held}
              className="figurine"
              onClick={() => onChange(draft.trim().length > 0 ? draft.trim() : name, id)}
            >
              <Figurine catalog={catalog} avatarId={id} size={46} />
            </button>
          );
        })}
      </div>
    </>
  );
}

/** [Q48, 15] One thinking time for every computer seat, whole seconds, as the hot seat box takes it. */
function ThinkingTime({
  seconds,
  disabled,
  onChange,
}: {
  readonly seconds: number;
  readonly disabled: boolean;
  onChange(seconds: number): void;
}) {
  const [typed, setTyped] = useState(String(seconds));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setTyped(String(seconds));
  }, [seconds]);
  const valid = (text: string): number | null => {
    const value = Number(text.trim());
    return text.trim().length > 0 && Number.isInteger(value) && value >= RANGES.thinking.min && value <= RANGES.thinking.max ? value : null;
  };
  useEffect(() => {
    const value = valid(typed);
    if (value === null || value === seconds) return;
    const timer = window.setTimeout(() => onChange(value), NAME_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);
  return (
    <div className="seat">
      <label className="think">
        <span>Computers think for</span>
        <input
          type="number"
          inputMode="numeric"
          min={RANGES.thinking.min}
          max={RANGES.thinking.max}
          step={1}
          value={typed}
          name="thinking-seconds"
          disabled={disabled}
          aria-invalid={valid(typed) === null}
          onFocus={() => {
            editing.current = true;
          }}
          onBlur={() => {
            editing.current = false;
          }}
          onChange={(event) => setTyped(event.target.value)}
        />
        <span>seconds</span>
        <small>
          {RANGES.thinking.min} to {RANGES.thinking.max}
        </small>
      </label>
    </div>
  );
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
}
