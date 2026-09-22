#!/usr/bin/env python3
"""Generate the placeholder art assets Claude was asked for: the d6 roll
animation (GDD.md §10 "die-roll animation") and the road/path brush pattern
(§10 "terrain textures (all 3 types) + road/path brush pattern").

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
            "`Art/Icons/roads.png` is NOT this: it is the brown wagon wheel, "
            "i.e. §4.1's plains-movement reward icon."
        ),
        "sprites": sprites,
    }
    with open(os.path.join(art_dir, "Roads_Brush_atlas.json"), "w") as fh:
        json.dump(atlas, fh, indent=2)
        fh.write("\n")


def main() -> None:
    art_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir)
    art_dir = os.path.normpath(art_dir)
    build_die(art_dir)
    build_brush(art_dir)
    print(f"wrote Dice_d6 and Roads_Brush into {art_dir}")


if __name__ == "__main__":
    main()
