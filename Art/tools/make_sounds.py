#!/usr/bin/env python3
"""Generate the placeholder sound effects Andrei picked by ear (Q63).

[Andrei, 2026-09-27] "we need at least minimal sound effects, for moving,
picking up a reward, winning a battle and losing a battle", and [2026-09-28]
"we need the resting sound and the "new message" as well, for a complete
minimal set". He chose from samples on the sound details page, and these are
the recipes he heard:

- moving, 127 B: a wooden figure tapping the board, in three slightly
  different takes that the game uses in turn (133);
- picking up a reward, 128 A: two rising chimes;
- a battle won, 129 B: four rising chimes;
- a battle lost, 130 A: two falling horn notes, the second one sagging;
- resting, 142 B: a soft breath out;
- a new message, 143 B: two knocks on a wooden door.

They are placeholders, marked `"placeholder": true` in `Art/manifest.json`, and
any of them can be replaced by dropping in a new file (`Art/README.md`).

Run from the repository root:

    python3 Art/tools/make_sounds.py

Deterministic: fixed seeds, so the same recipe always writes the same bytes and
rerunning it changes only the sounds whose recipe was edited. No third-party
dependencies, since the environment that made these had none: the tones are
added up sample by sample and written with the standard `wave` module, as
44.1 kHz 16-bit mono WAV, which every browser plays.

Every sound is set to one level (140), measured above 300 Hz, which is what a
phone's speaker plays; the footsteps are set lower because they repeat.
"""

from __future__ import annotations

import math
import os
import random
import struct
import wave

SR = 44100
SOUNDS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'Sounds')

# The loudness each sound is set to, as `loudness()` measures it.
STEP_LEVEL = 0.10
EVENT_LEVEL = 0.20


def zeros(seconds: float) -> list[float]:
    return [0.0] * int(round(seconds * SR))


def mix(into: list[float], sound: list[float], at: float = 0.0, gain: float = 1.0) -> list[float]:
    start = int(round(at * SR))
    need = start + len(sound)
    if need > len(into):
        into.extend([0.0] * (need - len(into)))
    for i, v in enumerate(sound):
        into[start + i] += v * gain
    return into


class Biquad:
    """RBJ cookbook biquad filter, direct form I."""

    def __init__(self, kind: str, f0: float, q: float) -> None:
        w = 2 * math.pi * f0 / SR
        cw, sw = math.cos(w), math.sin(w)
        alpha = sw / (2 * q)
        if kind == 'highpass':
            b0, b1, b2 = (1 + cw) / 2, -(1 + cw), (1 + cw) / 2
        elif kind == 'bandpass':  # constant 0 dB peak gain
            b0, b1, b2 = alpha, 0.0, -alpha
        else:
            raise ValueError(kind)
        a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
        self.b = (b0 / a0, b1 / a0, b2 / a0)
        self.a = (a1 / a0, a2 / a0)

    def run(self, xs: list[float]) -> list[float]:
        b0, b1, b2 = self.b
        a1, a2 = self.a
        x1 = x2 = y1 = y2 = 0.0
        out = []
        for x in xs:
            y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2, x1, y2, y1 = x1, x, y1, y
            out.append(y)
        return out


def noise(seconds: float, rng: random.Random) -> list[float]:
    return [rng.uniform(-1, 1) for _ in range(int(round(seconds * SR)))]


def shape(xs: list[float], attack: float, tau: float) -> list[float]:
    """A linear attack, then an exponential decay with time constant `tau`."""
    out = []
    for i, x in enumerate(xs):
        t = i / SR
        out.append(x * (t / attack if t < attack else math.exp(-(t - attack) / tau)))
    return out


def fade_edges(xs: list[float], fin: float = 0.001, fout: float = 0.01) -> list[float]:
    """Short fades at both ends, so a sound never starts or stops with a click."""
    n = len(xs)
    a, b = int(fin * SR), int(fout * SR)
    for i in range(min(a, n)):
        xs[i] *= i / a
    for i in range(min(b, n)):
        xs[n - 1 - i] *= i / b
    return xs


def trim_tail(xs: list[float], floor: float = 0.0005) -> list[float]:
    """Cut the silence after a sound has died away."""
    peak = max(abs(v) for v in xs) or 1.0
    last = len(xs) - 1
    while last > 0 and abs(xs[last]) < floor * peak:
        last -= 1
    return fade_edges(xs[: last + 1 + int(0.01 * SR)])


def loudness(xs: list[float], window: float = 0.05) -> float:
    """RMS of the loudest 50 ms, measured above 300 Hz as a phone speaker plays it."""
    xs = Biquad('highpass', 300, 0.7).run(xs)
    w = max(1, int(window * SR))
    acc = sum(v * v for v in xs[:w])
    best = acc
    for i in range(w, len(xs)):
        acc += xs[i] * xs[i] - xs[i - w] * xs[i - w]
        best = max(best, acc)
    return math.sqrt(best / w)


def level(xs: list[float], rms: float, peak_cap: float = 0.89) -> list[float]:
    """Scale a sound to loudness `rms`, keeping its peak under `peak_cap`."""
    g = rms / (loudness(xs) or 1.0)
    peak = max(abs(v) for v in xs) * g
    if peak > peak_cap:
        g *= peak_cap / peak
    return [v * g for v in xs]


# ---------------------------------------------------------------- voices

def bell(f: float, seconds: float, tau: float,
         partials=((1.0, 1.0), (2.0, 0.32), (3.0, 0.11), (4.16, 0.06), (5.43, 0.03))) -> list[float]:
    """A struck bell: a few partials over `f`, the higher ones dying sooner."""
    out = zeros(seconds)
    for ratio, amp in partials:
        fr = f * ratio
        if fr > SR / 2 - 1000:
            continue
        t_k = tau / (ratio ** 0.7)
        w = 2 * math.pi * fr / SR
        for i in range(len(out)):
            t = i / SR
            out[i] += amp * min(1.0, t / 0.002) * math.exp(-t / t_k) * math.sin(w * i)
    return out


def horn(f: float, seconds: float, attack: float, release: float, bright: float,
         droop: float = 0.0, decay_tau: float | None = None) -> list[float]:
    """A horn note: harmonics falling off as 1/n, brighter through the attack.

    `droop` lets the pitch sag by that share over the note; `decay_tau` lets
    it fade while held.
    """
    out = []
    ph = 0.0
    harmonics = [n for n in range(1, 16) if f * n < 9000]
    for i in range(int(round((seconds + release) * SR))):
        t = i / SR
        if t < attack:
            env = t / attack
            b = 0.25 + (bright + 0.12 - 0.25) * env
        else:
            env = 1.0 if decay_tau is None else math.exp(-(t - attack) / decay_tau)
            b = bright + 0.12 * math.exp(-(t - attack) / 0.05)
        if t > seconds:
            env *= max(0.0, 1 - (t - seconds) / release)
        ph += 2 * math.pi * f * (1 - droop * min(1.0, t / max(seconds, 1e-6))) / SR
        s = 0.0
        amp = 1.0
        for n in harmonics:
            s += amp / n * math.sin(n * ph)
            amp *= b
        out.append(s * env)
    return out


# ---------------------------------------------------------------- the sounds

def step(take: int) -> list[float]:
    """127 B: a wooden figure set down on the board, a short knock with a few wood resonances."""
    rng = random.Random(200 + take)
    k = 1 + (rng.random() - 0.5) * 0.08
    excite = shape(noise(0.004, rng), 0.0003, 0.0012)
    excite.extend([0.0] * int(0.12 * SR))
    out = zeros(0.12)
    for f, q, g in ((190 * k, 6, 0.55), (820 * k, 22, 1.0), (1730 * k, 18, 0.45), (3200 * k, 12, 0.18)):
        mix(out, Biquad('bandpass', f, q).run(excite), 0.0, g)
    out = Biquad('highpass', 120, 0.7).run(out)
    return trim_tail(fade_edges(out))


def pickup() -> list[float]:
    """128 A: two rising chimes, C6 then G6."""
    out = zeros(0.8)
    mix(out, bell(1046.5, 0.7, 0.26), 0.0, 0.8)
    mix(out, bell(1568.0, 0.7, 0.30), 0.085, 1.0)
    return trim_tail(out)


def battle_won() -> list[float]:
    """129 B: four rising chimes, C6 E6 G6 C7."""
    out = zeros(1.3)
    for i, f in enumerate((1046.5, 1318.5, 1568.0, 2093.0)):
        mix(out, bell(f, 1.0, 0.32 if i == 3 else 0.2), i * 0.065, 0.85 if i < 3 else 1.0)
    return trim_tail(out)


def battle_lost() -> list[float]:
    """130 A: two falling horn notes, G4 then D4, the second sagging as it fades."""
    out = zeros(1.2)
    mix(out, horn(392.0, 0.17, attack=0.03, release=0.06, bright=0.58), 0.0, 1.0)
    mix(out, horn(293.66, 0.55, attack=0.035, release=0.2, bright=0.55, droop=0.03, decay_tau=0.7), 0.24, 1.0)
    return trim_tail(out)


def rest() -> list[float]:
    """142 B: a soft breath out, noise shaped like a breath, swelling and fading."""
    rng = random.Random(500)
    xs = Biquad('bandpass', 1100, 0.9).run(Biquad('bandpass', 700, 0.6).run(noise(1.1, rng)))
    out = []
    for i, x in enumerate(xs):
        t = i / SR
        env = math.sin(math.pi * min(1.0, t / 0.35) / 2) ** 2 if t < 0.35 else math.exp(-(t - 0.35) / 0.22)
        out.append(x * env)
    return trim_tail(fade_edges(out))


def knock(k: float, rng: random.Random) -> list[float]:
    """One knock on a wooden door: deeper and longer ringing than a footstep."""
    excite = shape(noise(0.005, rng), 0.0004, 0.0016)
    excite.extend([0.0] * int(0.2 * SR))
    out = zeros(0.2)
    for f, q, g in ((140 * k, 8, 0.7), (520 * k, 40, 1.0), (1150 * k, 30, 0.45), (2300 * k, 18, 0.15)):
        mix(out, Biquad('bandpass', f, q).run(excite), 0.0, g)
    return Biquad('highpass', 100, 0.7).run(out)


def message() -> list[float]:
    """143 B: two knocks on a door, the second a shade lower and softer."""
    rng = random.Random(520)
    out = zeros(0.5)
    mix(out, knock(1.0, rng), 0.0, 1.0)
    mix(out, knock(0.97, rng), 0.16, 0.9)
    return trim_tail(fade_edges(out))


# File name under Art/Sounds/ -> (recipe, loudness). The manifest names these files.
SOUNDS = {
    'step_1.wav': (lambda: step(0), STEP_LEVEL),
    'step_2.wav': (lambda: step(1), STEP_LEVEL),
    'step_3.wav': (lambda: step(2), STEP_LEVEL),
    'pickup.wav': (pickup, EVENT_LEVEL),
    'battle_won.wav': (battle_won, EVENT_LEVEL),
    'battle_lost.wav': (battle_lost, EVENT_LEVEL),
    'rest.wav': (rest, EVENT_LEVEL),
    'message.wav': (message, EVENT_LEVEL),
}


def write(path: str, xs: list[float]) -> None:
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b''.join(struct.pack('<h', max(-32767, min(32767, int(round(v * 32767))))) for v in xs))


def main() -> None:
    os.makedirs(SOUNDS_DIR, exist_ok=True)
    for name, (recipe, loud) in SOUNDS.items():
        xs = level(recipe(), loud)
        write(os.path.join(SOUNDS_DIR, name), xs)
        print(f'Art/Sounds/{name}: {len(xs) / SR:.2f} s')


if __name__ == '__main__':
    main()
