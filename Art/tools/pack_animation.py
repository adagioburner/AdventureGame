#!/usr/bin/env python3
"""Pack the figures' idle animations in Art/originals/player_avatars_animated/
into one sheet and its atlas (Q305).

Andrei's animations come as one strip per figure: FRAMES frames left to right,
each FRAME_WIDTH x FRAME_HEIGHT, the figure standing on PIVOT in every frame,
with only its head, hands and what it holds moving. This lays the strips one
under another, in the figurine sheet's order, and writes:

  Art/player_avatars_animated_sheet.png
  Art/player_avatars_animated_atlas.json

  python3 Art/tools/pack_animation.py

Each frame keeps its place in its cell exactly as drawn, so the figure does not
shift from frame to frame, and its atlas anchor is PIVOT. Its shadow is made
dark and see-through as pack_sheets.py makes every other sheet's (Q59; Q305),
each figure's shadow on its own since each strip draws its shadow a
different grey. A frame's sprite is named for the figure it animates:
`player_avatars_01_frame1` is the first frame of the figurine sheet's
`player_avatars_01`. The strips stay in Art/originals/ unchanged, and the same
inputs always give byte-identical output.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from pack_sheets import ART, ORIGINALS, VISIBLE, darken_shadows, read_png, write_png  # noqa: E402

NAME = "player_avatars_animated"
SOURCE = os.path.join(ORIGINALS, NAME)

# The figurine each strip animates, in the figurine sheet's order.
STRIPS = [
    ("player_avatars_01", "cartographer-strip.png"),
    ("player_avatars_02", "mechanic-strip.png"),
    ("player_avatars_03", "botanist-strip.png"),
    ("player_avatars_04", "fox-musician-strip.png"),
    ("player_avatars_05", "tortoise-traveler-strip.png"),
    ("player_avatars_06", "goblin-courier-strip.png"),
]

FRAMES = 8
FRAME_WIDTH = 256
FRAME_HEIGHT = 320
# Where the figure stands in every frame, as the animations were drawn.
PIVOT = (128, 288)


def visible_box(width, px, x0, x1, height):
    """The box (x0, y0, x1, y1) of everything visible between columns x0 and x1."""
    xs, ys = [], []
    for y in range(height):
        for x in range(x0, x1):
            if px[(y * width + x) * 4 + 3] > VISIBLE:
                xs.append(x)
                ys.append(y)
    if not xs:
        raise SystemExit("a frame between columns %d and %d is empty" % (x0, x1))
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def main():
    sheet_w, sheet_h = FRAMES * FRAME_WIDTH, len(STRIPS) * FRAME_HEIGHT
    out = bytearray(sheet_w * sheet_h * 4)
    sprites = []
    for row, (figurine, strip) in enumerate(STRIPS):
        width, height, px = read_png(os.path.join(SOURCE, strip))
        if (width, height) != (sheet_w, FRAME_HEIGHT):
            raise SystemExit("%s: expected %dx%d, got %dx%d" % (strip, sheet_w, FRAME_HEIGHT, width, height))
        boxes = [visible_box(width, px, k * FRAME_WIDTH, (k + 1) * FRAME_WIDTH, height) for k in range(FRAMES)]
        shaded = darken_shadows(width, px, boxes)
        print("  %s: %d frames, %d shadow pixels darkened" % (strip, FRAMES, shaded))
        stride = width * 4
        out[row * FRAME_HEIGHT * stride:(row + 1) * FRAME_HEIGHT * stride] = px
        for k in range(FRAMES):
            sprites.append({
                "id": "%s_frame%d" % (figurine, k + 1),
                "x": k * FRAME_WIDTH,
                "y": row * FRAME_HEIGHT,
                "width": FRAME_WIDTH,
                "height": FRAME_HEIGHT,
                "anchor": {"x": PIVOT[0], "y": PIVOT[1]},
                "original": "%s/%s" % (NAME, strip),
            })

    write_png(os.path.join(ART, "%s_sheet.png" % NAME), sheet_w, sheet_h, out)
    atlas = {
        "sheet": "%s_sheet.png" % NAME,
        "cell_width": FRAME_WIDTH,
        "cell_height": FRAME_HEIGHT,
        "notes": ("Packed by Art/tools/pack_animation.py from Art/originals/%s/, one row per figure, "
                  "each frame where it was drawn, with each figure's grey shadow made black and "
                  "see-through. Do not edit by hand: replace a strip and run the tool again." % NAME),
        "sprites": sprites,
    }
    with open(os.path.join(ART, "%s_atlas.json" % NAME), "w") as fh:
        json.dump(atlas, fh, indent=2)
        fh.write("\n")
    print("  wrote %s_sheet.png, %d frames of %dx%d" % (NAME, len(sprites), FRAME_WIDTH, FRAME_HEIGHT))


if __name__ == "__main__":
    main()
