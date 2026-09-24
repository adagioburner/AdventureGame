import { useMemo, useState } from 'react';
import type { ControlMode, GameMap } from '@adventure/core';
import { atlasOf, type ArtCatalog } from '../art/catalog.ts';
import { HotseatGame, type HotseatSeat } from '../modes/hotseat.ts';
import type { LoadedArt } from '../render/pixi/textures.ts';
import type { MapScene } from '../render/sceneModel.ts';
import { MapView } from './MapView.tsx';
import { Figurine } from './Sprites.tsx';

interface SetupScreenProps {
  readonly art: LoadedArt;
  readonly map: GameMap;
  readonly scene: MapScene;
  readonly seats: readonly HotseatSeat[];
  onSeats(seats: readonly HotseatSeat[]): void;
  onStart(): void;
}

/** The two ways a seat can be played, in the order the panel shows them. */
const CONTROLS: readonly { readonly control: ControlMode; readonly label: string }[] = [
  { control: 'human', label: 'Human' },
  { control: 'ai', label: 'Computer' },
];

/**
 * Local setup (§6.1, cut down to hotseat): two seats (Q22), a name and a
 * figurine for each. Turn order is seat order. The map for the chosen seed is
 * drawn behind, with both figures on the plains node they will start from.
 *
 * [Andrei, 2026-09-24] Q41: Human and Computer buttons at the top of each seat,
 * both seats starting as Human, and a computer seat's thinking time in whole
 * seconds under its figurines. A computer's name and figurine are picked as a
 * person's are.
 */
export function SetupScreen({ art, map, scene, seats, onSeats, onStart }: SetupScreenProps) {
  const catalog = art.catalog;
  // The opening position is the engine's, so the stamina shown per seat is
  // `createGameState`'s own.
  const opening = useMemo(() => new HotseatGame({ map, seats, diceSeed: 'setup' }).state, [map, seats]);
  const figurines = atlasOf(catalog, catalog.manifest.figurines.sheet).sprites.map((sprite) => sprite.id);
  const range = map.ruleset.config.ai.THINKING_TIME_SECONDS;
  // What is typed in each thinking-time box, which may be half an edit; the
  // seat keeps the last whole number in range.
  const [typed, setTyped] = useState<readonly string[]>(() => seats.map((seat) => String(seat.thinkingSeconds)));
  const seconds = (text: string): number | null => {
    const value = Number(text.trim());
    return text.trim().length > 0 && Number.isInteger(value) && value >= range.min && value <= range.max ? value : null;
  };
  const ready = seats.every(
    (seat, index) => seat.name.trim().length > 0 && (seat.control !== 'ai' || seconds(typed[index] ?? '') !== null),
  );

  const change = (index: number, patch: Partial<HotseatSeat>): void => {
    onSeats(seats.map((seat, at) => (at === index ? { ...seat, ...patch } : seat)));
  };
  const type = (index: number, text: string): void => {
    setTyped(typed.map((current, at) => (at === index ? text : current)));
    const value = seconds(text);
    if (value !== null) change(index, { thinkingSeconds: value });
  };

  return (
    <>
      <MapView art={art} map={map} scene={scene} state={opening} path={null} waypoint={null} walker={null} />
      <form
        className="card setup"
        aria-label="New hot seat game"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onStart();
        }}
      >
        <h2>New hot seat game</h2>
        <p className="muted">
          Two seats take turns on this screen, each played by a person or by the computer. Both start on the plains node where
          the figures stand.
        </p>
        {seats.map((seat, index) => {
          const player = opening.players[index];
          return (
            <fieldset key={index} className="seat">
              <legend>
                Seat {index + 1} · moves {index === 0 ? 'first' : 'second'} · starts with {player?.stats.stamina ?? '?'} stamina
              </legend>
              <div className="control-toggle" role="radiogroup" aria-label={`Seat ${index + 1} played by`}>
                {CONTROLS.map(({ control, label }) => (
                  <button
                    key={control}
                    type="button"
                    role="radio"
                    aria-checked={seat.control === control}
                    onClick={() => change(index, { control })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label>
                <span>Name</span>
                <input
                  value={seat.name}
                  maxLength={24}
                  spellCheck={false}
                  autoComplete="off"
                  name={`seat-${index + 1}-name`}
                  onChange={(event) => change(index, { name: event.target.value })}
                />
              </label>
              <div className="figurines" role="radiogroup" aria-label={`Seat ${index + 1} figurine`}>
                {figurines.map((id) => {
                  const taken = seats.some((other, at) => at !== index && other.avatarId === id);
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={seat.avatarId === id}
                      aria-label={`Figurine ${id.replace(/\D+/g, '')}${taken ? ', taken by the other seat' : ''}`}
                      disabled={taken}
                      className="figurine"
                      onClick={() => change(index, { avatarId: id })}
                    >
                      <Figurine catalog={catalog} avatarId={id} size={46} />
                    </button>
                  );
                })}
              </div>
              {seat.control === 'ai' ? (
                <label className="think">
                  <span>Thinking time</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={range.min}
                    max={range.max}
                    step={1}
                    value={typed[index] ?? ''}
                    name={`seat-${index + 1}-thinking`}
                    aria-invalid={seconds(typed[index] ?? '') === null}
                    onChange={(event) => type(index, event.target.value)}
                  />
                  <span>seconds</span>
                  <small>
                    {range.min} to {range.max}
                  </small>
                </label>
              ) : null}
            </fieldset>
          );
        })}
        <button className="btn primary start" type="submit" disabled={!ready}>
          Start the game
        </button>
      </form>
    </>
  );
}
