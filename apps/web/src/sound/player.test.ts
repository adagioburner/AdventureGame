import { describe, expect, it } from 'vitest';
import type { SoundName } from '../art/manifest.ts';
import { SOUND_STORAGE_KEY, createSoundPlayer, type AudioData, type AudioOut, type SoundEnv, type SoundTable } from './player.ts';

/** A stand-in for the Web Audio API that records what was started, and at what volume. */
class FakeAudio implements AudioOut {
  state = 'running';
  currentTime = 0;
  destination = 'speaker';
  readonly started: { url: string; volume: number; at: number }[] = [];
  readonly stopped: string[] = [];
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  decodeAudioData(data: ArrayBuffer): Promise<AudioData> {
    return Promise.resolve({ url: new TextDecoder().decode(data) });
  }
  createBuffer(): AudioData {
    return { url: 'silence' };
  }
  createGain() {
    return { gain: { value: 1 }, connect: (to: unknown) => to };
  }
  createBufferSource() {
    const audio = this;
    let gain: { gain: { value: number } } | null = null;
    return {
      buffer: null as AudioData | null,
      onended: null as (() => void) | null,
      connect(to: unknown) {
        gain = to as { gain: { value: number } };
        return to;
      },
      start(when = 0) {
        const url = (this.buffer as { url: string } | null)?.url ?? '';
        if (url !== 'silence') audio.started.push({ url, volume: gain?.gain.value ?? 1, at: when });
      },
      stop() {
        const url = (this.buffer as { url: string } | null)?.url ?? '';
        audio.stopped.push(url);
      },
    };
  }
}

function setup(stored: string | null = null) {
  const kept = new Map<string, string>();
  if (stored !== null) kept.set(SOUND_STORAGE_KEY, stored);
  const audio = new FakeAudio();
  let gesture: () => void = () => undefined;
  let back: () => void = () => undefined;
  const env: SoundEnv = {
    createAudio: () => audio,
    fetchBytes: (url) => Promise.resolve(new TextEncoder().encode(url).buffer as ArrayBuffer),
    storage: { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => void kept.set(key, value) },
    onGesture: (unlock) => {
      gesture = unlock;
    },
    onReturn: (resume) => {
      back = resume;
    },
  };
  const player = createSoundPlayer(env);
  return { player, audio, kept, tap: () => gesture(), comeBack: () => back() };
}

const TABLE: SoundTable = {
  step: { urls: ['step_1', 'step_2', 'step_3'], volume: 1 },
  pickup: { urls: ['pickup'], volume: 0.5 },
  battle_won: { urls: ['won'], volume: 1 },
  battle_lost: { urls: ['lost'], volume: 1 },
  rest: { urls: ['rest'], volume: 1 },
  message: { urls: ['message'], volume: 1 },
  respawn: { urls: ['respawn'], volume: 1 },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the sound player (Q63)', () => {
  it('plays nothing before the first tap, as browsers require', async () => {
    const { player, audio } = setup();
    player.load(TABLE);
    await settle();
    player.play('pickup');
    expect(audio.started).toEqual([]);
  });

  it('plays a sound at its volume once tapped and loaded', async () => {
    const { player, audio, tap } = setup();
    player.load(TABLE);
    tap();
    await settle();
    player.play('pickup');
    expect(audio.started).toEqual([{ url: 'pickup', volume: 0.5, at: 0 }]);
  });

  it('uses a sound’s takes in turn (133)', async () => {
    const { player, audio, tap } = setup();
    tap();
    player.load(TABLE);
    await settle();
    for (let i = 0; i < 4; i++) player.play('step');
    expect(audio.started.map((start) => start.url)).toEqual(['step_1', 'step_2', 'step_3', 'step_1']);
  });

  it('plays a sound later on the audio clock, and stops those to come when sound is turned off', async () => {
    const { player, audio, tap } = setup();
    tap();
    player.load(TABLE);
    await settle();
    audio.currentTime = 10;
    player.play('step', 0.22);
    player.play('step', 0.44);
    expect(audio.started.map((start) => start.at)).toEqual([10.22, 10.44]);
    player.setOn(false);
    expect(audio.stopped).toEqual(['step_1', 'step_2']);
  });

  it('starts on, and keeps the choice on this device (139)', async () => {
    const { player, audio, kept, tap } = setup();
    expect(player.on).toBe(true);
    let heard = 0;
    player.subscribe(() => heard++);
    player.setOn(false);
    expect(heard).toBe(1);
    expect(kept.get(SOUND_STORAGE_KEY)).toBe('off');
    tap();
    player.load(TABLE);
    await settle();
    const names: SoundName[] = ['step', 'pickup', 'battle_won', 'battle_lost'];
    for (const name of names) player.play(name);
    expect(audio.started).toEqual([]);
    expect(setup('off').player.on).toBe(false);
    expect(setup('on').player.on).toBe(true);
  });

  it('brings the output back on the next tap after it was stopped', async () => {
    const { player, audio, tap } = setup();
    player.load(TABLE);
    tap();
    await settle();
    audio.state = 'interrupted';
    player.play('battle_won');
    expect(audio.started).toEqual([]);
    tap();
    await settle();
    player.play('battle_won');
    expect(audio.started).toEqual([{ url: 'won', volume: 1, at: 0 }]);
  });

  it('brings the output back when the page comes back to the front (144)', async () => {
    const { player, audio, tap, comeBack } = setup();
    player.load(TABLE);
    tap();
    await settle();
    audio.state = 'interrupted';
    comeBack();
    await settle();
    player.play('message');
    expect(audio.started).toEqual([{ url: 'message', volume: 1, at: 0 }]);
  });
});
