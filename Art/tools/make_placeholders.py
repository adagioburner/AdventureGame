#!/usr/bin/env python3
"""Generate the placeholder art assets Claude was asked for: the d6 roll
animation (GDD.md §10 "die-roll animation"), the road/path brush pattern and
the three terrain textures (§10 "terrain textures (all 3 types) + road/path
brush pattern"), and the prospective-move markers (§10 "visual elements for
showing a prospective move (path highlight, cross, waypoint marker)").

These are placeholders. They exist so phases 3 and 4 of the implementation plan
have something to bind to and can be swapped for real art without a code
change: the sheets follow the same `{sheet, cell_width, cell_height, sprites}`
atlas shape as every other pair in `Art/`, so the loader treats them
identically.

Run from the repository root:

    python3 Art/tools/make_placeholders.py

Deterministic — the same inputs always produce byte-identical PNGs, so
regenerating is a no-op in git. No third-party dependencies: PNG encoding is
zlib plus a byte header, and drawing is a supersampled signed-distance
rasteriser, because the environment that made these had no imaging library.
"""

from __future__ import annotations

import json
import math
import os
import struct
import zlib

# Style copied from the supplied art: bold black outlines over flat fills.
BLACK = (24, 24, 24, 255)
WHITE = (250, 250, 248, 255)
DIRT = (150, 106, 62, 255)
DIRT_LIGHT = (183, 140, 92, 255)
DIRT_DARK = (109, 74, 41, 255)
PEBBLE = (128, 122, 112, 255)

SS = 3  # supersampling factor, box-downsampled for anti-aliasing


class Canvas:
    """An RGBA canvas drawn at SS× and downsampled on write."""

    def __init__(self, width: int, height: int) -> None:
        self.w = width
        self.h = height
        self.sw = width * SS
        self.sh = height * SS
        self.px = bytearray(self.sw * self.sh * 4)  # transparent

    def blend(self, x: int, y: int, rgba: tuple[int, int, int, int]) -> None:
        if not (0 <= x < self.sw and 0 <= y < self.sh):
            return
        i = (y * self.sw + x) * 4
        r, g, b, a = rgba
        if a == 255:
            self.px[i : i + 4] = bytes((r, g, b, a))
            return
        if a == 0:
            return
        dr, dg, db, da = self.px[i], self.px[i + 1], self.px[i + 2], self.px[i + 3]
        na = a + da * (255 - a) // 255
        if na == 0:
            return
        self.px[i] = (r * a + dr * da * (255 - a) // 255) // na
        self.px[i + 1] = (g * a + dg * da * (255 - a) // 255) // na
        self.px[i + 2] = (b * a + db * da * (255 - a) // 255) // na
        self.px[i + 3] = na

    def fill_sdf(self, box, sdf, color, edge: float = 0.0) -> None:
        """Paint `color` wherever `sdf(x, y) < edge`, over box (x0, y0, x1, y1)
        given in output pixels."""
        x0, y0, x1, y1 = box
        for sy in range(max(0, y0 * SS), min(self.sh, y1 * SS)):
            fy = (sy + 0.5) / SS
            for sx in range(max(0, x0 * SS), min(self.sw, x1 * SS)):
                if sdf((sx + 0.5) / SS, fy) < edge:
                    self.blend(sx, sy, color)

    def downsample(self) -> bytes:
        """Box-filter SS×SS blocks down to one pixel each."""
        out = bytearray(self.w * self.h * 4)
        n = SS * SS
        for y in range(self.h):
            rows = [(y * SS + dy) * self.sw for dy in range(SS)]
            for x in range(self.w):
                r = g = b = a = 0
                for base in rows:
                    i = (base + x * SS) * 4
                    for _ in range(SS):
                        r += self.px[i]
                        g += self.px[i + 1]
                        b += self.px[i + 2]
                        a += self.px[i + 3]
                        i += 4
                o = (y * self.w + x) * 4
                out[o : o + 4] = bytes((r // n, g // n, b // n, a // n))
        return bytes(out)


def write_png(path: str, width: int, height: int, rgba: bytes) -> None:
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        raw += rgba[y * width * 4 : (y + 1) * width * 4]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def rounded_square(cx: float, cy: float, half: float, radius: float, angle: float):
    """Signed distance to a rotated rounded square."""
    ca, sa = math.cos(-angle), math.sin(-angle)
    inner = half - radius

    def sdf(x: float, y: float) -> float:
        dx, dy = x - cx, y - cy
        lx, ly = dx * ca - dy * sa, dx * sa + dy * ca
        qx, qy = abs(lx) - inner, abs(ly) - inner
        mx, my = max(qx, 0.0), max(qy, 0.0)
        return math.hypot(mx, my) + min(max(qx, qy), 0.0) - radius

    return sdf


def disc(cx: float, cy: float, radius: float):
    def sdf(x: float, y: float) -> float:
        return math.hypot(x - cx, y - cy) - radius

    return sdf


# --- the d6 -----------------------------------------------------------------

# Pip layout per face, in units of the die's half-size (-1..1).
PIP_LAYOUT = {
    1: [(0, 0)],
    2: [(-0.45, -0.45), (0.45, 0.45)],
    3: [(-0.45, -0.45), (0, 0), (0.45, 0.45)],
    4: [(-0.45, -0.45), (0.45, -0.45), (-0.45, 0.45), (0.45, 0.45)],
    5: [(-0.45, -0.45), (0.45, -0.45), (0, 0), (-0.45, 0.45), (0.45, 0.45)],
    6: [
        (-0.45, -0.5),
        (0.45, -0.5),
        (-0.45, 0),
        (0.45, 0),
        (-0.45, 0.5),
        (0.45, 0.5),
    ],
}

CELL = 192
TUMBLE_FRAMES = 8
OUTLINE = 7.0


def draw_die(canvas: Canvas, ox: int, oy: int, face: int, angle: float, scale: float) -> None:
    """One die, centred in the cell at (ox, oy)."""
    cx, cy = ox + CELL / 2, oy + CELL / 2
    half = CELL * 0.33 * scale
    box = (ox, oy, ox + CELL, oy + CELL)

    outer = rounded_square(cx, cy, half, half * 0.22, angle)
    canvas.fill_sdf(box, outer, BLACK)
    inner = rounded_square(cx, cy, half - OUTLINE, (half - OUTLINE) * 0.2, angle)
    canvas.fill_sdf(box, inner, WHITE)

    ca, sa = math.cos(angle), math.sin(angle)
    pip_r = half * 0.155
    for px, py in PIP_LAYOUT[face]:
        lx, ly = px * (half - OUTLINE) * 0.86, py * (half - OUTLINE) * 0.86
        wx, wy = cx + lx * ca - ly * sa, cy + lx * sa + ly * ca
        canvas.fill_sdf(
            (int(wx - pip_r - 2), int(wy - pip_r - 2), int(wx + pip_r + 3), int(wy + pip_r + 3)),
            disc(wx, wy, pip_r),
            BLACK,
        )


def build_die(art_dir: str) -> None:
    faces = 6
    cols = max(TUMBLE_FRAMES, faces)
    width, height = cols * CELL, 2 * CELL
    canvas = Canvas(width, height)
    sprites = []

    # Row 0 — the tumble loop. Plays while the roll is in flight; the face shown
    # is deliberately arbitrary, so no frame of it can be read as the result.
    for i in range(TUMBLE_FRAMES):
        t = i / TUMBLE_FRAMES
        # A quarter turn over the loop, so the last frame flows into the first
        # (a square is unchanged by 90°). Offset by half a step so no tumble
        # frame lands axis-aligned and reads as a settled die.
        angle = (t + 0.5 / TUMBLE_FRAMES) * math.pi / 2
        scale = 0.94 + 0.06 * math.sin(t * math.pi * 2)
        face = (i % 6) + 1
        ox = i * CELL
        draw_die(canvas, ox, 0, face, angle, scale)
        sprites.append(
            {
                "id": f"Dice_d6_Tumble_{i + 1:02d}",
                "x": ox,
                "y": 0,
                "width": CELL,
                "height": CELL,
                "anchor": {"x": CELL // 2, "y": CELL // 2},
                "frame": i,
                "role": "tumble",
            }
        )

    # Row 1 — the six resting faces. The animation ends on the face matching the
    # roll the engine produced; `GUARD_DIE` is a d6 (§11).
    for face in range(1, faces + 1):
        ox = (face - 1) * CELL
        draw_die(canvas, ox, CELL, face, 0.0, 1.0)
        sprites.append(
            {
                "id": f"Dice_d6_Face_{face}",
                "x": ox,
                "y": CELL,
                "width": CELL,
                "height": CELL,
                "anchor": {"x": CELL // 2, "y": CELL // 2},
                "value": face,
                "role": "face",
            }
        )

    write_png(os.path.join(art_dir, "Dice_d6_sheet.png"), width, height, canvas.downsample())
    atlas = {
        "sheet": "Dice_d6_sheet.png",
        "cell_width": CELL,
        "cell_height": CELL,
        "placeholder": True,
        "notes": (
            "Placeholder for GDD.md §10's die-roll animation. GUARD_DIE is a d6 "
            "(§11). Play the eight 'tumble' sprites as a seamless loop while the "
            "roll is in flight, then hold the 'face' sprite whose `value` equals "
            "the roll the engine returned. No tumble frame may be read as the "
            "result. Drawn flat rather than isometric on purpose: the roll is UI "
            "shown over the board (§8), not a thing standing on a node, so its "
            "anchor is the sprite centre, unlike the ground-contact anchors on "
            "the terrain and POI sheets."
        ),
        "sprites": sprites,
    }
    with open(os.path.join(art_dir, "Dice_d6_atlas.json"), "w") as fh:
        json.dump(atlas, fh, indent=2)
        fh.write("\n")


# --- the road brush ---------------------------------------------------------

BRUSH_W = 256
BRUSH_H = 64
BRUSH_VARIANTS = [
    ("Track", 0.62, 5),  # a worn cart track: widest, most pebbles
    ("Path", 0.44, 3),  # a footpath
    ("Trail", 0.28, 2),  # a faint trail
]


def build_brush(art_dir: str) -> None:
    width, height = BRUSH_W, BRUSH_H * len(BRUSH_VARIANTS)
    canvas = Canvas(width, height)
    sprites = []

    for row, (name, thickness, pebbles) in enumerate(BRUSH_VARIANTS):
        oy = row * BRUSH_H
        mid = oy + BRUSH_H / 2
        half = BRUSH_H * thickness / 2

        # Every wobble is a sum of sines with integer periods over BRUSH_W, so
        # the tile is exactly periodic and abuts itself with no seam.
        k = 2 * math.pi / BRUSH_W

        def wobble(x: float, phase: float) -> float:
            return (
                math.sin(k * x + phase)
                + 0.45 * math.sin(2 * k * x + phase * 1.7)
                + 0.2 * math.sin(3 * k * x + phase * 2.3)
            ) / 1.65

        # The centreline stays almost flat on purpose: a renderer rotates this
        # tile to the edge's bearing and lays it node to node, so a drifting
        # centre would make a straight edge draw as a snake. The organic look
        # comes from the *width* varying, not the middle moving.
        def centre(x: float) -> float:
            return mid + BRUSH_H * 0.012 * wobble(x, 0.0)

        def halfwidth(x: float) -> float:
            return half * (1.0 + 0.2 * wobble(x, 1.3))

        def band(x: float, y: float, grow: float) -> float:
            return abs(y - centre(x)) - (halfwidth(x) + grow)

        box = (0, oy, width, oy + BRUSH_H)
        # Outline and fill share one centre and one width, so the black edge is
        # an even thickness all the way along instead of pooling and vanishing.
        canvas.fill_sdf(box, lambda x, y: band(x, y, 3.0), BLACK)
        canvas.fill_sdf(box, lambda x, y: band(x, y, 0.0), DIRT)
        # A lighter crown down the middle, so the path reads as worn.
        canvas.fill_sdf(
            box,
            lambda x, y: abs(y - centre(x)) - halfwidth(x) * 0.42,
            DIRT_LIGHT,
        )

        # Pebbles, placed on a fixed lattice and drawn wrapped so they survive
        # the tile boundary.
        for i in range(pebbles):
            u = (i + 0.5) / pebbles
            px = u * BRUSH_W
            py = centre(px) + math.sin(u * math.pi * 4 + row) * half * 0.55
            pr = 2.0 + 1.4 * ((i * 7 + row * 3) % 3)
            for dx in (-BRUSH_W, 0, BRUSH_W):
                x = px + dx
                if -pr - 2 < x < width + pr + 2:
                    canvas.fill_sdf(
                        (int(x - pr - 2), int(py - pr - 2), int(x + pr + 3), int(py + pr + 3)),
                        disc(x, py, pr),
                        DIRT_DARK if i % 2 else PEBBLE,
                    )

        sprites.append(
            {
                "id": f"Roads_{name}",
                "x": 0,
                "y": oy,
                "width": BRUSH_W,
                "height": BRUSH_H,
                # The stroke is laid along the path's centreline, so the anchor
                # is the left end of that line rather than a ground contact.
                "anchor": {"x": 0, "y": BRUSH_H // 2},
                "tiles": "horizontal",
                "centerline_y": BRUSH_H // 2,
            }
        )

    write_png(os.path.join(art_dir, "Roads_Brush_sheet.png"), width, height, canvas.downsample())
    atlas = {
        "sheet": "Roads_Brush_sheet.png",
        "cell_width": BRUSH_W,
        "cell_height": BRUSH_H,
        "placeholder": True,
        "notes": (
            "Placeholder for GDD.md §10's road/path brush pattern — the edges "
            "§2 describes as 'road/path-styled'. Each sprite is one tile of a "
            "stroke: repeat it along an edge to any length. Every wobble in it "
            "has an integer period over `cell_width`, so a tile abuts a copy of "
            "itself with no seam. `anchor` is the left end of the centreline and "
            "`centerline_y` is where that line sits, so a renderer rotates the "
            "tile to the edge's bearing and lays it from node to node. Three "
            "widths are supplied to tell a main route from a faint one; nothing "
            "in the design assigns them yet, so picking per edge is open. "
            "The brown wagon wheel in `Art/Icons/plains_move.png` is NOT this: "
            "it is §4.1's plains-movement reward icon."
        ),
        "sprites": sprites,
    }
    with open(os.path.join(art_dir, "Roads_Brush_atlas.json"), "w") as fh:
        json.dump(atlas, fh, indent=2)
        fh.write("\n")


# --- the terrain textures ---------------------------------------------------

TEXTURE_SIZE = 256


def hash01(*values: int) -> float:
    """A portable integer hash to [0, 1), so the textures never depend on a
    library's random stream."""
    h = 0x811C9DC5
    for v in values:
        h ^= v & 0xFFFFFFFF
        h = (h * 0x01000193) & 0xFFFFFFFF
        h ^= h >> 15
        h = (h * 0x2C1B3C6D) & 0xFFFFFFFF
        h ^= h >> 12
    return h / 2**32


def tile_noise(x: float, y: float, period: int, seed: int) -> float:
    """Value noise in [0, 1] that repeats every TEXTURE_SIZE pixels, because
    its lattice has `period` cells across the tile and wraps."""
    fx = x / TEXTURE_SIZE * period
    fy = y / TEXTURE_SIZE * period
    ix, iy = int(math.floor(fx)), int(math.floor(fy))
    tx, ty = fx - ix, fy - iy
    tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)

    def at(i: int, j: int) -> float:
        return hash01(i % period, j % period, seed)

    top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx
    bottom = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx
    return top * (1 - ty) + bottom * ty


def fbm(x: float, y: float, seed: int) -> float:
    """Four octaves, each with an integer period, so the sum still tiles."""
    total, weight = 0.0, 0.0
    for octave, period in enumerate((4, 8, 16, 32)):
        amp = 0.55**octave
        total += amp * tile_noise(x, y, period, seed + octave * 101)
        weight += amp
    return total / weight


def capsule(ax: float, ay: float, bx: float, by: float, radius: float):
    """Signed distance to a line segment with round ends."""

    def sdf(x: float, y: float) -> float:
        px, py = x - ax, y - ay
        vx, vy = bx - ax, by - ay
        t = max(0.0, min(1.0, (px * vx + py * vy) / (vx * vx + vy * vy)))
        return math.hypot(px - vx * t, py - vy * t) - radius

    return sdf


def ellipse(cx: float, cy: float, rx: float, ry: float, angle: float):
    """Approximate signed distance to a rotated ellipse (fine at these sizes)."""
    ca, sa = math.cos(-angle), math.sin(-angle)

    def sdf(x: float, y: float) -> float:
        dx, dy = x - cx, y - cy
        lx, ly = dx * ca - dy * sa, dx * sa + dy * ca
        k = math.hypot(lx / rx, ly / ry)
        return (k - 1.0) * min(rx, ry)

    return sdf


def shade(color, amount: float):
    r, g, b = color[:3]
    return (
        max(0, min(255, int(r + amount))),
        max(0, min(255, int(g + amount))),
        max(0, min(255, int(b + amount))),
        255,
    )


def stamp_wrapped(canvas: Canvas, cx: float, cy: float, reach: float, make_sdf, color) -> None:
    """Draw a feature and its copies across the tile edges, so it survives the
    wrap and the texture still abuts itself with no seam."""
    size = TEXTURE_SIZE
    for dx in (-size, 0, size):
        for dy in (-size, 0, size):
            x, y = cx + dx, cy + dy
            if -reach <= x <= size + reach and -reach <= y <= size + reach:
                box = (int(x - reach) - 1, int(y - reach) - 1, int(x + reach) + 2, int(y + reach) + 2)
                canvas.fill_sdf(box, make_sdf(x, y), color)


# Colours are GDD.md §2's: plains light brown, forests green, mountains grey.
TEXTURES = {
    "Plains": {"base": (198, 170, 116), "amp": 30, "seed": 11},
    "Forest": {"base": (86, 124, 62), "amp": 34, "seed": 23},
    "Mountains": {"base": (142, 140, 134), "amp": 44, "seed": 37},
}


def texture_base(spec) -> Canvas:
    size = TEXTURE_SIZE
    canvas = Canvas(size, size)
    base, amp, seed = spec["base"], spec["amp"], spec["seed"]
    for y in range(size):
        for x in range(size):
            n = fbm(x + 0.5, y + 0.5, seed) - 0.5
            color = shade(base, n * amp)
            for sy in range(y * SS, y * SS + SS):
                row = sy * canvas.sw
                for sx in range(x * SS, x * SS + SS):
                    i = (row + sx) * 4
                    canvas.px[i : i + 4] = bytes(color)
    return canvas


def draw_plains(canvas: Canvas, seed: int) -> None:
    grass = (116, 132, 60, 255)
    grass_light = (150, 160, 78, 255)
    pebble = (160, 140, 108, 255)
    for i in range(46):
        cx, cy = hash01(seed, i, 1) * TEXTURE_SIZE, hash01(seed, i, 2) * TEXTURE_SIZE
        colour = grass if i % 3 else grass_light
        for blade in range(3):
            lean = (blade - 1) * 0.45 + (hash01(seed, i, blade, 3) - 0.5) * 0.3
            length = 5 + hash01(seed, i, blade, 4) * 4
            bx, by = cx + blade * 2 - 2, cy
            tx, ty = bx + math.sin(lean) * length, by - math.cos(lean) * length
            stamp_wrapped(
                canvas, bx, by, length + 2,
                lambda x, y, tx=tx - bx, ty=ty - by: capsule(x, y, x + tx, y + ty, 0.9),
                colour,
            )
    for i in range(26):
        cx, cy = hash01(seed, i, 7) * TEXTURE_SIZE, hash01(seed, i, 8) * TEXTURE_SIZE
        r = 1.2 + hash01(seed, i, 9) * 1.6
        stamp_wrapped(canvas, cx, cy, r + 1, lambda x, y, r=r: disc(x, y, r), pebble)


def draw_forest(canvas: Canvas, seed: int) -> None:
    dark = (58, 92, 44, 255)
    light = (112, 150, 78, 255)
    for i in range(90):
        cx, cy = hash01(seed, i, 1) * TEXTURE_SIZE, hash01(seed, i, 2) * TEXTURE_SIZE
        rx = 3 + hash01(seed, i, 3) * 4
        ry = rx * (0.45 + hash01(seed, i, 4) * 0.3)
        angle = hash01(seed, i, 5) * math.pi
        stamp_wrapped(
            canvas, cx, cy, rx + 1,
            lambda x, y, rx=rx, ry=ry, a=angle: ellipse(x, y, rx, ry, a),
            dark if i % 4 else light,
        )


def draw_mountains(canvas: Canvas, seed: int) -> None:
    crack = (96, 94, 90, 255)
    speck = (176, 174, 168, 255)
    for i in range(14):
        x, y = hash01(seed, i, 1) * TEXTURE_SIZE, hash01(seed, i, 2) * TEXTURE_SIZE
        heading = hash01(seed, i, 3) * math.pi * 2
        for seg in range(4):
            heading += (hash01(seed, i, seg, 4) - 0.5) * 1.2
            length = 6 + hash01(seed, i, seg, 5) * 8
            nx, ny = x + math.cos(heading) * length, y + math.sin(heading) * length
            stamp_wrapped(
                canvas, x, y, length + 2,
                lambda px, py, dx=nx - x, dy=ny - y: capsule(px, py, px + dx, py + dy, 0.8),
                crack,
            )
            x, y = nx, ny
    for i in range(60):
        cx, cy = hash01(seed, i, 7) * TEXTURE_SIZE, hash01(seed, i, 8) * TEXTURE_SIZE
        r = 0.8 + hash01(seed, i, 9) * 1.4
        stamp_wrapped(canvas, cx, cy, r + 1, lambda x, y, r=r: disc(x, y, r), speck)


def build_textures(art_dir: str) -> None:
    features = {"Plains": draw_plains, "Forest": draw_forest, "Mountains": draw_mountains}
    for name, spec in TEXTURES.items():
        canvas = texture_base(spec)
        features[name](canvas, spec["seed"])
        stem = f"{name}_Texture"
        write_png(os.path.join(art_dir, f"{stem}_sheet.png"), TEXTURE_SIZE, TEXTURE_SIZE, canvas.downsample())
        atlas = {
            "sheet": f"{stem}_sheet.png",
            "cell_width": TEXTURE_SIZE,
            "cell_height": TEXTURE_SIZE,
            "placeholder": True,
            "notes": (
                f"Placeholder for GDD.md §10's {name.lower()} terrain texture. Drawn "
                "top-down and seamless in both directions: the renderer repeats it "
                "across every node of this terrain and lays it on the ground plane, "
                "which is what foreshortens it into the isometric view. A "
                "replacement must tile the same way, and should stay quiet enough "
                "for POI images, dressing and roads to read on top of it."
            ),
            "sprites": [
                {
                    "id": stem,
                    "x": 0,
                    "y": 0,
                    "width": TEXTURE_SIZE,
                    "height": TEXTURE_SIZE,
                    "anchor": {"x": 0, "y": 0},
                    "tiles": "both",
                }
            ],
        }
        with open(os.path.join(art_dir, f"{stem}_atlas.json"), "w") as fh:
            json.dump(atlas, fh, indent=2)
            fh.write("\n")


# --- the prospective-move markers --------------------------------------------

MARKER = 128
# GDD.md §7.1's path colours, one per state the rules engine reports.
PROSPECT_STATES = [
    ("Free", (76, 175, 80, 255)),  # green: covered by this turn's skill allowance
    ("Stamina", (244, 204, 44, 255)),  # yellow: costs stamina
    ("Unreachable", (196, 196, 196, 255)),  # grey: not reachable this turn
]
FLAG = (66, 128, 222, 255)
RING = (255, 232, 120, 255)


def build_markers(art_dir: str) -> None:
    width, height = 4 * MARKER, 2 * MARKER
    canvas = Canvas(width, height)
    sprites = []

    def sprite(sid, col, row, anchor, **extra):
        entry = {
            "id": sid,
            "x": col * MARKER,
            "y": row * MARKER,
            "width": MARKER,
            "height": MARKER,
            "anchor": anchor,
        }
        entry.update(extra)
        sprites.append(entry)

    centre = {"x": MARKER // 2, "y": MARKER // 2}
    for col, (state, colour) in enumerate(PROSPECT_STATES):
        # Row 0: the dot the thick dotted path is made of.
        ox, oy = col * MARKER, 0
        cx, cy = ox + MARKER / 2, oy + MARKER / 2
        box = (ox, oy, ox + MARKER, oy + MARKER)
        canvas.fill_sdf(box, disc(cx, cy, 40), BLACK)
        canvas.fill_sdf(box, disc(cx, cy, 32), colour)
        canvas.fill_sdf(box, disc(cx - 9, cy - 9, 9), shade(colour, 40))
        sprite(f"Prospect_Dot_{state}", col, 0, centre, role="dot", state=state.lower())

        # Row 1: the destination cross.
        oy = MARKER
        cy = oy + MARKER / 2
        box = (ox, oy, ox + MARKER, oy + MARKER)
        arm = 40
        for grow, fill in ((8, BLACK), (0, colour)):
            for sign in (1, -1):
                canvas.fill_sdf(
                    box,
                    capsule(cx - arm, cy - sign * arm, cx + arm, cy + sign * arm, 11 + grow),
                    fill,
                )
        sprite(f"Prospect_Cross_{state}", col, 1, centre, role="cross", state=state.lower())

    # The waypoint marker stands up on its node, so it anchors at the foot of
    # its pole like every figure on the POI sheets.
    ox, oy = 3 * MARKER, 0
    box = (ox, oy, ox + MARKER, oy + MARKER)
    foot_x, foot_y = ox + 44, oy + 117
    canvas.fill_sdf(box, ellipse(foot_x, foot_y, 16, 6, 0.0), BLACK)
    canvas.fill_sdf(box, capsule(foot_x, foot_y, foot_x, oy + 14, 6), BLACK)
    canvas.fill_sdf(box, capsule(foot_x, foot_y - 2, foot_x, oy + 16, 2.5), (120, 90, 60, 255))

    def pennant(grow: float):
        ax, ay, bx, by, tx, ty = foot_x, oy + 14, foot_x, oy + 62, ox + 112, oy + 38

        def sdf(x: float, y: float) -> float:
            # Inside test for a triangle, as a distance-like value.
            def side(px, py, qx, qy):
                return ((x - px) * (qy - py) - (y - py) * (qx - px)) / math.hypot(qx - px, qy - py)

            return max(-side(ax, ay, bx, by), -side(bx, by, tx, ty), -side(tx, ty, ax, ay)) - grow

        return sdf

    canvas.fill_sdf(box, pennant(6), BLACK)
    canvas.fill_sdf(box, pennant(0), FLAG)
    sprite("Prospect_Waypoint", 3, 0, {"x": foot_x - ox, "y": foot_y - oy}, role="waypoint")

    # The active player's ring, laid on the ground under their figurine.
    ox, oy = 3 * MARKER, MARKER
    cx, cy = ox + MARKER / 2, oy + MARKER / 2
    box = (ox, oy, ox + MARKER, oy + MARKER)
    canvas.fill_sdf(box, lambda x, y: abs(math.hypot(x - cx, y - cy) - 46) - 12, BLACK)
    canvas.fill_sdf(box, lambda x, y: abs(math.hypot(x - cx, y - cy) - 46) - 6, RING)
    sprite("Prospect_ActiveRing", 3, 1, centre, role="active")

    write_png(os.path.join(art_dir, "Prospect_Markers_sheet.png"), width, height, canvas.downsample())
    atlas = {
        "sheet": "Prospect_Markers_sheet.png",
        "cell_width": MARKER,
        "cell_height": MARKER,
        "placeholder": True,
        "notes": (
            "Placeholder for GDD.md §10's visual elements for a prospective move, "
            "coloured per §7.1: green where this turn's skill allowance covers the "
            "step, yellow where it costs stamina, grey where it is out of reach this "
            "turn. The dots make the thick dotted line and the crosses mark the "
            "destination; both, and the active player's ring, are drawn top-down "
            "and laid on the ground by the renderer, which is what turns the flat X "
            "into the isometric cross §7.1 asks for. The waypoint flag stands up on "
            "its node instead, so it is drawn upright and anchored at its foot."
        ),
        "sprites": sprites,
    }
    with open(os.path.join(art_dir, "Prospect_Markers_atlas.json"), "w") as fh:
        json.dump(atlas, fh, indent=2)
        fh.write("\n")


def main() -> None:
    art_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
    art_dir = os.path.normpath(art_dir)
    build_die(art_dir)
    build_brush(art_dir)
    build_textures(art_dir)
    build_markers(art_dir)
    print(f"wrote Dice_d6, Roads_Brush, the terrain textures and Prospect_Markers into {art_dir}")


if __name__ == "__main__":
    main()
