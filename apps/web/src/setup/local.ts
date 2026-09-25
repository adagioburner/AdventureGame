import type { IntRange } from '@adventure/config';
import type { ControlMode } from '@adventure/core';
import { isOpenSeat, type NewGameSetup, type SetupState } from '@adventure/protocol';
import type { HotseatSeat } from '../modes/hotseat.ts';

/**
 * A setup that lives on this device only: the one setup screen with "Play
 * online" off ([Q51]). Every seat is played here, by a person or by the
 * computer, as on the hot seat panel before the screens became one (Q41):
 * switching a seat between Human and Computer keeps its name and figure.
 *
 * Turning "Play online" on sends this to the server (`toNewGameSetup`), and
 * turning it off brings a stored game's setup back here (`fromOnlineSetup`).
 */
export interface LocalSetup {
  /** In seat order: the first moves first. */
  readonly seats: readonly LocalSeat[];
  /** The `n` of the next seat's id, never reused, so a seat keeps its id as others come and go. */
  readonly nextId: number;
}

export interface LocalSeat {
  readonly id: string;
  readonly name: string;
  readonly avatarId: string;
  readonly control: ControlMode;
  /** Kept for a person too, so switching back and forth keeps it (Q41). */
  readonly thinkingSeconds: number;
}

/** What a local setup is checked against: §11's ranges and the figurine sheet. */
export interface LocalLimits {
  readonly playerCount: IntRange;
  readonly thinkingSeconds: IntRange;
  readonly defaultThinkingSeconds: number;
  readonly figures: readonly string[];
}

/** [Q41] A new game: two seats, both people, on different figures. */
export function newLocalSetup(limits: LocalLimits): LocalSetup {
  return withCount({ seats: [], nextId: 1 }, limits.playerCount.min, limits);
}

/** [Q51, 21] 2 to 5 seats. New seats are people, as a new game's are; fewer seats drop the last ones. */
export function withCount(setup: LocalSetup, count: number, limits: LocalLimits): LocalSetup {
  const bounded = Math.min(limits.playerCount.max, Math.max(limits.playerCount.min, Math.round(count)));
  const seats = setup.seats.slice(0, bounded);
  let nextId = setup.nextId;
  while (seats.length < bounded) {
    seats.push({
      id: `local:${nextId++}`,
      name: `Player ${seats.length + 1}`,
      avatarId: limits.figures.find((id) => !seats.some((seat) => seat.avatarId === id)) ?? limits.figures[0] ?? '',
      control: 'human',
      thinkingSeconds: limits.defaultThinkingSeconds,
    });
  }
  return { seats, nextId };
}

/** One seat changed; the panel greys out figures other seats hold, so figures stay each seat's own. */
export function withSeat(setup: LocalSetup, id: string, change: Partial<Omit<LocalSeat, 'id'>>): LocalSetup {
  return { ...setup, seats: setup.seats.map((seat) => (seat.id === id ? { ...seat, ...change } : seat)) };
}

/** The seats a hot seat game starts with. A name left empty is "Player N", as before. */
export function toHotseatSeats(setup: LocalSetup): HotseatSeat[] {
  return setup.seats.map((seat, index) => ({
    name: seat.name.trim() || `Player ${index + 1}`,
    avatarId: seat.avatarId,
    control: seat.control,
    thinkingSeconds: seat.thinkingSeconds,
  }));
}

/**
 * [Q51, 25] What turning "Play online" on sends. Seat 1 becomes the game
 * master's, keeping its figure; another Human seat is kept for someone who
 * asks to join (23); a computer keeps its name, figure and thinking time.
 */
export function toNewGameSetup(setup: LocalSetup, mapSeed: string): NewGameSetup {
  const named = toHotseatSeats(setup);
  return {
    mapSeed,
    seats: named.map((seat, index) =>
      index === 0
        ? { control: 'human', avatarId: seat.avatarId }
        : seat.control === 'ai'
          ? { control: 'ai', name: seat.name, avatarId: seat.avatarId, thinkingSeconds: seat.thinkingSeconds }
          : { control: 'human' },
    ),
  };
}

/**
 * [Q51, 25] A stored game's setup brought back to this device when "Play
 * online" is turned off: every seat stays as it was, now played here. A Human
 * seat nobody had taken becomes "Player N" on a figure no seat holds.
 */
export function fromOnlineSetup(online: SetupState, limits: LocalLimits): LocalSetup {
  const seats: LocalSeat[] = [];
  online.seats.forEach((seat, index) => {
    seats.push({
      id: `local:${index + 1}`,
      name: isOpenSeat(seat) ? `Player ${index + 1}` : seat.name,
      avatarId: seat.avatarId,
      control: seat.control,
      thinkingSeconds: seat.thinkingSeconds,
    });
  });
  const held = new Set(seats.map((seat) => seat.avatarId).filter((id) => id !== ''));
  const figured = seats.map((seat) => {
    if (seat.avatarId !== '') return seat;
    const free = limits.figures.find((id) => !held.has(id)) ?? limits.figures[0] ?? '';
    held.add(free);
    return { ...seat, avatarId: free };
  });
  return { seats: figured, nextId: seats.length + 1 };
}
