import type { ArtCatalog } from '../art/catalog.ts';
import { SOUND_NAMES, type SoundName } from '../art/manifest.ts';

/**
 * [Andrei, 2026-09-27] "we need at least minimal sound effects" (Q63): the
 * page's one sound player, which the game screen asks to play a sound and the
 * map's Sound button turns on and off.
 *
 * Sound is on until someone turns it off on this device, and the device
 * remembers that (139). Every sound plays at the level its file was made at,
 * times its manifest volume, with no slider (140): the device's own volume
 * sets how loud, and an iPhone's silent switch silences it, as it does all
 * sound a web page plays through the Web Audio API.
 *
 * A browser lets a page make sound only once the person has tapped or typed
 * on it, so the player waits for that and plays nothing before it.
 */
export interface SoundPlayer {
  /** Whether sound is on on this device. */
  readonly on: boolean;
  setOn(on: boolean): void;
  /** Hears every change of `on`. */
  subscribe(listener: () => void): () => void;
  /** The files each sound plays, with its volume. Each file is fetched once. */
  load(table: SoundTable): void;
  /**
   * Plays `name` in `delay` seconds (now if omitted), its next take if it has
   * several; nothing while sound is off or its file has not loaded. Sounds
   * still to come stop when sound is turned off.
   */
  play(name: SoundName, delay?: number): void;
}

export type SoundTable = Readonly<Record<SoundName, { readonly urls: readonly string[]; readonly volume: number }>>;

/** The sound files `Art/manifest.json` names, as the page fetches them. */
export function soundTableOf(catalog: ArtCatalog): SoundTable {
  return Object.fromEntries(
    SOUND_NAMES.map((name) => [name, { urls: catalog.soundUrls(name), volume: catalog.manifest.sounds[name].volume }]),
  ) as Record<SoundName, SoundTable[SoundName]>;
}

/** The parts of the Web Audio API the player uses, so a test can stand in for them. */
export interface AudioOut {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<AudioData>;
  createBufferSource(): {
    buffer: AudioData | null;
    connect(to: unknown): unknown;
    start(when?: number): void;
    stop(): void;
    onended: (() => void) | null;
  };
  createGain(): { readonly gain: { value: number }; connect(to: unknown): unknown };
  createBuffer(channels: number, length: number, sampleRate: number): AudioData;
}

/** A decoded sound. */
export type AudioData = object;

/** What the player needs from the page around it. */
export interface SoundEnv {
  /** Makes the audio output; called on the first tap or key press, since browsers allow sound only after one. */
  createAudio(): AudioOut | null;
  fetchBytes(url: string): Promise<ArrayBuffer>;
  /** Where the on/off choice is kept; `null` where nothing can be kept. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Calls `unlock` on every tap and key press from now on. */
  onGesture(unlock: () => void): void;
}

/** The key the on/off choice is kept under on this device. */
export const SOUND_STORAGE_KEY = 'adventure.sound';

export function createSoundPlayer(env: SoundEnv): SoundPlayer {
  let on = read(env.storage) !== 'off';
  const listeners = new Set<() => void>();
  let audio: AudioOut | null = null;
  let table: SoundTable | null = null;
  const bytes = new Map<string, Promise<ArrayBuffer>>();
  const decoded = new Map<string, AudioData>();
  const decoding = new Set<string>();
  const next = new Map<SoundName, number>();
  // Sounds started and not yet over, so turning sound off can stop them.
  const playing = new Set<ReturnType<AudioOut['createBufferSource']>>();

  const decode = (): void => {
    const out = audio;
    if (out === null) return;
    for (const [url, fetched] of bytes) {
      if (decoded.has(url) || decoding.has(url)) continue;
      decoding.add(url);
      fetched
        .then((data) => out.decodeAudioData(data.slice(0)))
        .then(
          (buffer) => decoded.set(url, buffer),
          // A file that cannot be fetched or decoded stays silent; the game plays on.
          () => undefined,
        );
    }
  };

  env.onGesture(() => {
    if (audio === null) {
      audio = env.createAudio();
      if (audio === null) return;
      // Older iPhones start the output only once something has played inside a tap.
      try {
        const silence = audio.createBufferSource();
        silence.buffer = audio.createBuffer(1, 1, 22050);
        silence.connect(audio.destination);
        silence.start();
      } catch {
        // Nothing to start: the output runs without it.
      }
      decode();
    }
    // A phone call or another app can stop the output; the next tap brings it back.
    if (audio.state !== 'running') void audio.resume().catch(() => undefined);
  });

  return {
    get on() {
      return on;
    },
    setOn(value) {
      if (value === on) return;
      on = value;
      if (!on) {
        for (const source of playing) {
          try {
            source.stop();
          } catch {
            // Already over.
          }
        }
        playing.clear();
      }
      try {
        env.storage?.setItem(SOUND_STORAGE_KEY, on ? 'on' : 'off');
      } catch {
        // Not kept on this device: the choice lasts until the page is closed.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load(sounds) {
      table = sounds;
      for (const { urls } of Object.values(sounds)) {
        for (const url of urls) {
          if (bytes.has(url)) continue;
          const fetched = env.fetchBytes(url);
          fetched.catch(() => undefined);
          bytes.set(url, fetched);
        }
      }
      decode();
    },
    play(name, delay = 0) {
      if (!on || audio === null || audio.state !== 'running' || table === null) return;
      const { urls, volume } = table[name];
      if (urls.length === 0) return;
      // [Q63, 133] Several takes of one sound are used in turn.
      const take = next.get(name) ?? 0;
      next.set(name, (take + 1) % urls.length);
      const buffer = decoded.get(urls[take] as string);
      if (buffer === undefined) return;
      const source = audio.createBufferSource();
      source.buffer = buffer;
      const gain = audio.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(audio.destination);
      source.onended = () => playing.delete(source);
      playing.add(source);
      source.start(audio.currentTime + Math.max(0, delay));
    },
  };
}

function read(storage: SoundEnv['storage']): string | null {
  try {
    return storage?.getItem(SOUND_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The page's own sound player, or one that never plays where there is no page (tests, the server). */
export const sounds: SoundPlayer = createSoundPlayer(typeof window === 'undefined' ? silentEnv() : browserEnv(window));

function browserEnv(page: Window): SoundEnv {
  let storage: Storage | null = null;
  try {
    storage = page.localStorage;
  } catch {
    // Kept nowhere: a private window, or site data blocked.
  }
  return {
    createAudio() {
      const constructors = page as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Audio = constructors.AudioContext ?? constructors.webkitAudioContext;
      return Audio === undefined ? null : (new Audio() as unknown as AudioOut);
    },
    fetchBytes: (url) =>
      fetch(url).then((response) => {
        if (!response.ok) throw new Error(`${url}: ${response.status}`);
        return response.arrayBuffer();
      }),
    storage,
    onGesture(unlock) {
      // The events a browser counts as the person asking for sound.
      for (const type of ['pointerup', 'touchend', 'click', 'keydown']) {
        page.document.addEventListener(type, unlock, { capture: true, passive: true });
      }
    },
  };
}

function silentEnv(): SoundEnv {
  return {
    createAudio: () => null,
    fetchBytes: () => Promise.reject(new Error('no page')),
    storage: null,
    onGesture: () => undefined,
  };
}
