import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_RULESET, startingStaminaForSeat } from '@adventure/config';
import type { ControlMode } from '@adventure/core';
import { isOpenSeat, type ClientMessage, type Principal, type SetupSeat, type SetupState } from '@adventure/protocol';
import { atlasOf, type ArtCatalog } from '../art/catalog.ts';
import { Figurine } from '../page/Sprites.tsx';
import type { LoadedArt } from '../render/pixi/textures.ts';
import { withCount, withSeat, type LocalLimits, type LocalSetup } from './local.ts';
import './setup.css';

/** A player's name's longest, as on the server. */
const NAME_MAX = 24;

/** A game's name's longest, as on the server. */
const GAME_NAME_MAX = 40;

/** How long a name may sit half typed before it is sent. */
const NAME_SETTLE_MS = 700;

const RANGES = {
  players: DEFAULT_RULESET.config.players.PLAYER_COUNT,
  thinking: DEFAULT_RULESET.config.ai.THINKING_TIME_SECONDS,
};

/** [Q51, 22] The two ways a seat can be played, in the order the panel shows them. */
const CONTROLS: readonly { readonly control: ControlMode; readonly label: string }[] = [
  { control: 'human', label: 'Human' },
  { control: 'ai', label: 'Computer' },
];

/** A game on this device only: "Play online" off. */
export interface LocalPanel {
  readonly kind: 'local';
  readonly setup: LocalSetup;
  readonly limits: LocalLimits;
  onChange(next: LocalSetup): void;
  onStart(): void;
  /**
   * [Q51, 26 and 29] The switch, for someone logged in on the site; `null`
   * where the game cannot be stored (logged out, or the game page, which has
   * no server).
   */
  readonly playOnline: { readonly busy: boolean; readonly problem: string | null; turnOn(): void } | null;
}

/** A game on the server: "Play online" on. */
export interface OnlinePanel {
  readonly kind: 'online';
  readonly setup: SetupState;
  readonly me: Principal;
  readonly connected: boolean;
  /** [Q48, 11] The game master declined this user's last request. */
  readonly declined: boolean;
  send(message: ClientMessage): boolean;
  /** [Q51, 25] The game master turned "Play online" off. */
  onTurnOff(): void;
}

/**
 * The one setup screen, for a game on this device and a game online alike
 * ([Q51], Andrei 2026-09-24: "Can we unify these screens, with a simple toggle
 * that tells us whether the game we create is stored?").
 *
 * The same panel either way: "Play online", the number of players (2 to 5),
 * a card for each seat with Human and Computer, a name, a figure and, for a
 * computer, its thinking time, and Start. Online it also has what only a
 * stored game has: the game's name, join requests, Cancel, and for anyone
 * else who opens it the join form (Q48). Seat 1 of a stored game is always
 * the game master's, and another Human seat is kept for someone who asks to
 * join (Q51, 22 and 23).
 */
export function SetupPanel({ art, panel }: { readonly art: LoadedArt; readonly panel: LocalPanel | OnlinePanel }) {
  return panel.kind === 'local' ? <LocalSetupPanel art={art} panel={panel} /> : <OnlineSetupPanel art={art} panel={panel} />;
}

/* ------------------------------ on this device ------------------------------ */

function LocalSetupPanel({ art, panel }: { readonly art: LoadedArt; readonly panel: LocalPanel }) {
  const catalog = art.catalog;
  const figures = figuresOf(catalog);
  const { setup, limits, onChange } = panel;
  // Thinking-time boxes holding something that is not a whole number in
  // range; the seat keeps its last good one, and Start waits.
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const ready = invalid.size === 0 && setup.seats.every((seat) => seat.name.trim().length > 0);

  return (
    <form
      className="card setup"
      aria-label="New game"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) panel.onStart();
      }}
    >
      <h2>New game</h2>
      <p className="muted">Each seat takes its turn on this screen, played by a person or by the computer.</p>
      {panel.playOnline === null ? null : (
        <>
          <PlayOnlineSwitch on={false} disabled={panel.playOnline.busy} onChange={panel.playOnline.turnOn} />
          {panel.playOnline.problem === null ? null : (
            <p className="problem" role="alert">
              {panel.playOnline.problem}
            </p>
          )}
        </>
      )}
      <PlayerCount count={setup.seats.length} lowest={RANGES.players.min} disabled={false} onChange={(count) => onChange(withCount(setup, count, limits))} />
      {setup.seats.map((seat, index) => (
        <SeatCard key={seat.id} seat={index + 1}>
          <ControlToggle
            label={`Seat ${index + 1}`}
            control={seat.control}
            disabled={false}
            onChange={(control) => onChange(withSeat(setup, seat.id, { control }))}
          />
          <NameAndFigure
            catalog={catalog}
            figures={figures}
            label={`Seat ${index + 1}`}
            name={seat.name}
            avatarId={seat.avatarId}
            taken={new Set(setup.seats.filter((other) => other.id !== seat.id).map((other) => other.avatarId))}
            disabled={false}
            immediate
            onChange={(name, avatarId) => onChange(withSeat(setup, seat.id, { name, avatarId }))}
          />
          {seat.control === 'ai' ? (
            <ThinkingTime
              label={`seat-${index + 1}`}
              seconds={seat.thinkingSeconds}
              disabled={false}
              immediate
              onChange={(thinkingSeconds) => onChange(withSeat(setup, seat.id, { thinkingSeconds }))}
              onValidity={(ok) =>
                setInvalid((current) => {
                  if (ok === !current.has(seat.id)) return current;
                  const next = new Set(current);
                  if (ok) next.delete(seat.id);
                  else next.add(seat.id);
                  return next;
                })
              }
            />
          ) : null}
        </SeatCard>
      ))}
      <button className="btn primary start" type="submit" disabled={!ready}>
        Start the game
      </button>
    </form>
  );
}

/* --------------------------------- online --------------------------------- */

function OnlineSetupPanel({ art, panel }: { readonly art: LoadedArt; readonly panel: OnlinePanel }) {
  const catalog = art.catalog;
  const figures = figuresOf(catalog);
  const { setup, me, send } = panel;
  const gameId = setup.gameId;
  const isGameMaster = setup.gameMaster === me.userId;
  const people = setup.seats.filter((seat) => seat.userId !== null);
  const seated = people.some((seat) => seat.userId === me.userId);
  const request = setup.pending.find((pending) => pending.userId === me.userId) ?? null;
  const starting = setup.phase !== 'setup';
  const idle = !panel.connected || starting;
  const openSeats = setup.seats.filter(isOpenSeat).length;

  return (
    <section className="card setup" aria-label="Game setup">
      <h2>{isGameMaster ? 'New game' : setup.name}</h2>
      <p className="muted">
        {starting
          ? 'Starting the game…'
          : isGameMaster
            ? 'You are the game master. Others can ask to join the Human seats, and the computer plays any nobody has taken when you start.'
            : `Game master: ${setup.gameMasterName}. The computer plays any Human seat nobody has taken at the start.`}
      </p>
      {panel.connected ? null : (
        <p className="problem" role="status">
          Reconnecting to the server…
        </p>
      )}

      {isGameMaster ? (
        <>
          <PlayOnlineSwitch on disabled={idle} onChange={panel.onTurnOff} />
          <GameName name={setup.name} disabled={idle} onChange={(name) => send({ type: 'setup.rename', gameId, name })} />
        </>
      ) : null}

      {!seated && !isGameMaster ? (
        <JoinRequestForm
          catalog={catalog}
          figures={figures}
          setup={setup}
          me={me}
          request={request}
          declined={panel.declined}
          disabled={idle}
          send={send}
        />
      ) : null}

      {isGameMaster && setup.pending.length > 0 ? (
        <fieldset className="seat requests">
          <legend>Asking to join</legend>
          {openSeats === 0 ? (
            <p className="muted">No Human seat is free. Make a seat Human or raise the number of players to accept someone.</p>
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
                    disabled={idle || openSeats === 0 || holder !== null}
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
        <PlayerCount
          count={setup.playerCount}
          lowest={people.length}
          disabled={idle}
          onChange={(count) => send({ type: 'setup.setPlayerCount', gameId, count })}
        />
      ) : null}

      {setup.seats.map((seat) => {
        const mine = seat.userId === me.userId;
        const tag = seatTag(seat, setup, me, isGameMaster);
        return (
          <SeatCard key={seat.id} seat={seat.seat}>
            {isGameMaster && seat.userId !== me.userId ? (
              <ControlToggle
                label={`Seat ${seat.seat}`}
                control={seat.control}
                disabled={idle || seat.userId !== null}
                onChange={(control) => send({ type: 'setup.setSeatControl', gameId, seatId: seat.id, control })}
              />
            ) : null}
            {tag === null ? null : <p className="tag">{tag}</p>}
            {isOpenSeat(seat) ? (
              <p className="open-seat">
                {isGameMaster
                  ? 'Kept for someone who asks to join. If nobody has by the start, the computer plays this seat.'
                  : 'Waiting for someone to join.'}
              </p>
            ) : mine || (isGameMaster && seat.userId === null) ? (
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
            {isGameMaster && seat.control === 'ai' ? (
              <ThinkingTime
                label={`seat-${seat.seat}`}
                seconds={seat.thinkingSeconds}
                disabled={idle}
                onChange={(seconds) => send({ type: 'setup.setThinkingTime', gameId, seatId: seat.id, seconds })}
              />
            ) : null}
          </SeatCard>
        );
      })}

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

/**
 * Over a seat's name, for everyone but the game master, who has the Human and
 * Computer buttons instead: "Game master", "You", "Computer", or nothing.
 */
function seatTag(seat: SetupSeat, setup: SetupState, me: Principal, isGameMaster: boolean): string | null {
  if (seat.userId === me.userId) return isGameMaster ? 'You · game master' : 'You';
  if (isGameMaster) return null;
  if (seat.userId === setup.gameMaster) return 'Game master';
  return seat.control === 'ai' ? 'Computer' : null;
}

/**
 * The figures greyed out for `seat`, or for a join request when `seat` is
 * null. [Q49, 18] A person may take a computer's figure, and the computer
 * switches, so only other people's are greyed for a person or a request; a
 * computer may take nobody's.
 */
function takenFor(setup: SetupState, seat: SetupSeat | null): ReadonlySet<string> {
  const others = setup.seats.filter(
    (other) => other.id !== seat?.id && other.avatarId !== '' && (seat?.control === 'ai' || other.userId !== null),
  );
  return new Set(others.map((other) => other.avatarId));
}

/** [Q49, 19] The person who holds `figure`, which a request naming it cannot be accepted with. */
function figureHolder(setup: SetupState, figure: string): SetupSeat | null {
  return setup.seats.find((seat) => seat.userId !== null && seat.avatarId === figure) ?? null;
}

/* ------------------------------ shared pieces ------------------------------ */

function figuresOf(catalog: ArtCatalog): string[] {
  return atlasOf(catalog, catalog.manifest.figurines.sheet).sprites.map((sprite) => sprite.id);
}

/** [Q51, 28] "Play online", with what it means under it. */
function PlayOnlineSwitch({ on, disabled, onChange }: { readonly on: boolean; readonly disabled: boolean; onChange(): void }) {
  return (
    <div className="play-online">
      <button type="button" role="switch" aria-checked={on} aria-labelledby="play-online-label" disabled={disabled} onClick={onChange}>
        <span className="knob" />
      </button>
      <div>
        <b id="play-online-label">Play online</b>
        <small>Others can ask to join, and it stays in your games.</small>
      </div>
    </div>
  );
}

/** [Q51, 27] A stored game's name, as the game list shows it; sent as a player's name is. */
function GameName({ name, disabled, onChange }: { readonly name: string; readonly disabled: boolean; onChange(name: string): void }) {
  const [draft, handlers] = useSettledText(name, onChange);
  return (
    <label className="field">
      <span>Game name</span>
      <input
        name="game-name"
        value={draft.value}
        maxLength={GAME_NAME_MAX}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        {...handlers}
      />
    </label>
  );
}

/** [Q51, 21] 2 to 5 players, and never fewer than the seats people hold. */
function PlayerCount({
  count,
  lowest,
  disabled,
  onChange,
}: {
  readonly count: number;
  readonly lowest: number;
  readonly disabled: boolean;
  onChange(count: number): void;
}) {
  return (
    <div className="choice">
      <span>Players</span>
      <div className="control-toggle count" role="radiogroup" aria-label="Number of players">
        {range(RANGES.players.min, RANGES.players.max).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={count === option}
            disabled={disabled || option < lowest}
            onClick={() => onChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A seat's card, under the legend both kinds of game share. */
function SeatCard({ seat, children }: { readonly seat: number; readonly children: ReactNode }) {
  return (
    <fieldset className="seat">
      <legend>
        Seat {seat} · starts with {startingStaminaForSeat(seat, DEFAULT_RULESET)} stamina
      </legend>
      {children}
    </fieldset>
  );
}

/** [Q41, Q51 22] Human and Computer, at the top of a seat. */
function ControlToggle({
  label,
  control,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly control: ControlMode;
  readonly disabled: boolean;
  onChange(control: ControlMode): void;
}) {
  return (
    <div className="control-toggle" role="radiogroup" aria-label={`${label} played by`}>
      {CONTROLS.map((option) => (
        <button
          key={option.control}
          type="button"
          role="radio"
          aria-checked={control === option.control}
          disabled={disabled}
          onClick={() => {
            if (control !== option.control) onChange(option.control);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A box of text sent after a short pause in typing, on Enter, or on leaving
 * the box, so the others don't see every keystroke; someone else's change
 * shows unless the box is being typed in. Returns the draft and the box's
 * handlers.
 */
function useSettledText(value: string, onChange: (text: string) => void, immediate = false) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const commit = (text: string): void => {
    const trimmed = text.trim();
    const now = latest.current;
    if (trimmed.length > 0 && trimmed !== now.value) now.onChange(trimmed);
  };

  useEffect(() => {
    if (immediate) return;
    const timer = window.setTimeout(() => commit(draft), NAME_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, immediate]);

  return [
    { value: draft },
    {
      onFocus: () => {
        editing.current = true;
      },
      onBlur: () => {
        editing.current = false;
        if (!immediate) commit(draft);
      },
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter' && !immediate) commit(draft);
      },
      onChange: (event: { target: { value: string } }) => {
        setDraft(event.target.value);
        if (immediate) latest.current.onChange(event.target.value);
      },
    },
  ] as const;
}

/**
 * A name box and the figurines. A figure is sent at once; a name as
 * `useSettledText` sends it. `immediate` reports every keystroke, for a form
 * that sends nothing until its button, and for a game on this device.
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
  const [draft, handlers] = useSettledText(name, (text) => onChange(text, avatarId), immediate);
  return (
    <>
      <label>
        <span>Name</span>
        <input
          value={draft.value}
          maxLength={NAME_MAX}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          name={`${label.toLowerCase().replace(/\W+/g, '-')}-name`}
          {...handlers}
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
              onClick={() => onChange(draft.value.trim().length > 0 ? draft.value.trim() : name, id)}
            >
              <Figurine catalog={catalog} avatarId={id} size={46} />
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * [Q41, Q51 24] A computer seat's thinking time, whole seconds, under its
 * figures. A number in range is sent after a short pause online, or at once on
 * this device; anything else stays in the box, marked, and `onValidity` hears
 * about it.
 */
function ThinkingTime({
  label,
  seconds,
  disabled,
  immediate = false,
  onChange,
  onValidity,
}: {
  readonly label: string;
  readonly seconds: number;
  readonly disabled: boolean;
  readonly immediate?: boolean;
  onChange(seconds: number): void;
  onValidity?(ok: boolean): void;
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
    onValidity?.(value !== null);
    if (value === null || value === seconds) return;
    if (immediate) {
      onChange(value);
      return;
    }
    const timer = window.setTimeout(() => onChange(value), NAME_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);
  // A seat that stops being a computer takes its box away; it no longer holds Start back.
  useEffect(() => () => onValidity?.(true), []);
  return (
    <label className="think">
      <span>Thinking time</span>
      <input
        type="number"
        inputMode="numeric"
        min={RANGES.thinking.min}
        max={RANGES.thinking.max}
        step={1}
        value={typed}
        name={`${label}-thinking`}
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
  );
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
  // A figure no seat holds to begin with, so asking takes nobody's figure
  // unless the person picks one.
  const [draft, setDraft] = useState(() => ({
    name: me.displayName.slice(0, NAME_MAX),
    avatarId: figures.find((id) => !setup.seats.some((seat) => seat.avatarId === id)) ?? figures[0] ?? '',
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

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
}
