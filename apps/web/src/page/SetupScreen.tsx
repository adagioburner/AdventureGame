import { useMemo } from 'react';
import type { GameMap } from '@adventure/core';
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

/**
 * Local setup (§6.1, cut down to hotseat): two seats (Q22), a name and a
 * figurine for each. Turn order is seat order. The map for the chosen seed is
 * drawn behind, with both figures on the plains node they will start from.
 */
export function SetupScreen({ art, map, scene, seats, onSeats, onStart }: SetupScreenProps) {
  const catalog = art.catalog;
  // The opening position is the engine's, so the stamina shown per seat is
  // `createGameState`'s own.
  const opening = useMemo(() => new HotseatGame({ map, seats, diceSeed: 'setup' }).state, [map, seats]);
  const figurines = atlasOf(catalog, catalog.manifest.figurines.sheet).sprites.map((sprite) => sprite.id);
  const ready = seats.every((seat) => seat.name.trim().length > 0);

  const change = (index: number, patch: Partial<HotseatSeat>): void => {
    onSeats(seats.map((seat, at) => (at === index ? { ...seat, ...patch } : seat)));
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
        <p className="muted">Two players share this screen and take turns. Both start on the plains node where the figures stand.</p>
        {seats.map((seat, index) => {
          const player = opening.players[index];
          return (
            <fieldset key={index} className="seat">
              <legend>
                Seat {index + 1} · moves {index === 0 ? 'first' : 'second'} · starts with {player?.stats.stamina ?? '?'} stamina
              </legend>
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
