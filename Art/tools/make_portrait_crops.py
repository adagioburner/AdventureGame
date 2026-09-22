#!/usr/bin/env python3
"""Derive temporary head-and-shoulders portrait boxes from the player sheet.

GDD section 2 shows an avatar beside each player's name in the stats panel, and
section 10 asks for character figurines to pick at setup. The figurines exist
(Art/player_avatars_sheet.png); the avatar set does not yet. Until it arrives
the same six figures stand in, "enlarged and shifted so that only their head
and shoulders fit into the frame".

A single enlarge-and-shift will not do that. The six heads start between row 24
and row 155 of a 698-row cell, because the figures differ in height and posture,
so one uniform transform frames the knight's forehead and the halfling's chest.
This writes one box per figure instead, and the renderer scales each into the
avatar frame.

Everything here is measured from the sheet's alpha channel, so re-running it
after the art changes re-derives the boxes:

  python3 Art/tools/make_portrait_crops.py

Boxes are square and cell-relative, like the atlas `anchor`, so they survive a
repack. Delete this file and its output once the real avatar set lands.

No third-party imports, matching Art/tools/make_placeholders.py — the PNG is
decoded with zlib alone.
"""

import json
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.dirname(HERE)
ATLAS = os.path.join(ART, "player_avatars_atlas.json")
OUT = os.path.join(ART, "player_avatars_portraits.json")

# Portrait side as a fraction of the figure's height from the top of the head to
# its feet. 0.32 was picked by eye over all six: it takes the head and both
# shoulders without reaching the waist on the tall figures.
SIDE_FRACTION = 0.32
# Headroom above the hair, as a fraction of the portrait side.
HEADROOM = 0.06
ALPHA_FLOOR = 8


def read_rgba(path):
    """Decode a non-interlaced 8-bit RGBA PNG into (width, height, pixels)."""
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG: %s" % path)
    pos, idat, width, height = 8, b"", None, None
    while pos < len(data):
        length, = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if (depth, colour, interlace) != (8, 6, 0):
                raise ValueError("expected 8-bit RGBA, non-interlaced")
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length

    raw = zlib.decompress(idat)
    stride = width * 4
    out = bytearray(stride * height)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        filt = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if filt == 1:
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 255
        elif filt == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif filt == 3:
            for i in range(stride):
                left = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif filt == 4:
            for i in range(stride):
                left = line[i - 4] if i >= 4 else 0
                up_left = prev[i - 4] if i >= 4 else 0
                up = prev[i]
                pa, pb, pc = abs(up - up_left), abs(left - up_left), abs(left + up - 2 * up_left)
                nearest = left if (pa <= pb and pa <= pc) else (up if pb <= pc else up_left)
                line[i] = (line[i] + nearest) & 255
        elif filt != 0:
            raise ValueError("bad filter %d" % filt)
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return width, height, bytes(out)


def content_box(px, w, sprite):
    """Opaque bounds of one cell, cell-relative."""
    x0, y0, cw, ch = sprite["x"], sprite["y"], sprite["width"], sprite["height"]
    min_x, min_y, max_x, max_y = cw, ch, -1, -1
    for y in range(y0, y0 + ch):
        row = y * w
        for x in range(x0, x0 + cw):
            if px[(row + x) * 4 + 3] > ALPHA_FLOOR:
                if x - x0 < min_x:
                    min_x = x - x0
                if x - x0 > max_x:
                    max_x = x - x0
                if y - y0 < min_y:
                    min_y = y - y0
                if y - y0 > max_y:
                    max_y = y - y0
    return min_x, min_y, max_x, max_y


def head_top(px, w, sprite, body_cx, content_w):
    """First row of the head, cell-relative.

    Scanning the whole cell finds whatever the figure holds highest — an axe
    blade, a bow, a staff, arrow fletchings. Those are thin and off to one side,
    so the scan is restricted to a narrow band on the body's centre line and
    wants the width sustained over ten rows before it calls it a head.
    """
    x0, y0, cw, ch = sprite["x"], sprite["y"], sprite["width"], sprite["height"]
    half = max(30, int(content_w * 0.15))
    lo, hi = x0 + body_cx - half, x0 + body_cx + half + 1
    run = 0
    for y in range(y0, y0 + ch):
        row = y * w
        wide = sum(1 for x in range(lo, hi) if px[(row + x) * 4 + 3] > ALPHA_FLOOR) >= 12
        run = run + 1 if wide else 0
        if run == 10:
            return y - y0 - 9
    raise ValueError("no head found in %s" % sprite["id"])


def head_centre(px, w, sprite, body_cx, top, side):
    """Horizontal centre of the head itself, cell-relative.

    Not the figure's bounding-box centre: a held axe or staff drags that sideways
    by up to 76px here, which is enough to push a face out of frame. Measured a
    little below the crown, where the head is widest and the hair has started.
    """
    x0, cw = sprite["x"], sprite["width"]
    lo = max(0, body_cx - int(side * 0.55))
    hi = min(cw, body_cx + int(side * 0.55))
    edges = []
    for y in range(sprite["y"] + top + 8, sprite["y"] + top + 8 + max(24, side // 4)):
        row = y * w
        run = [x - x0 for x in range(x0 + lo, x0 + hi) if px[(row + x) * 4 + 3] > ALPHA_FLOOR]
        if run:
            edges.append(run[0])
            edges.append(run[-1])
    return (min(edges) + max(edges)) // 2 if edges else body_cx


def main():
    atlas = json.load(open(ATLAS))
    sheet = os.path.join(ART, atlas["sheet"])
    w, _, px = read_rgba(sheet)

    portraits = []
    for sprite in atlas["sprites"]:
        min_x, _, max_x, max_y = content_box(px, w, sprite)
        body_cx = (min_x + max_x) // 2
        top = head_top(px, w, sprite, body_cx, max_x - min_x)
        side = int(SIDE_FRACTION * (max_y - top))
        cx = head_centre(px, w, sprite, body_cx, top, side)

        x = max(0, min(cx - side // 2, sprite["width"] - side))
        y = max(0, min(top - int(HEADROOM * side), sprite["height"] - side))
        portraits.append({
            "id": sprite["id"],
            "x": x,
            "y": y,
            "width": side,
            "height": side,
            "head_top": top,
        })
        print("%s: head top %d, centre %d (body centre %d), box %dx%d at %d,%d"
              % (sprite["id"], top, cx, body_cx, side, side, x, y))

    doc = {
        "sheet": atlas["sheet"],
        "temporary": True,
        "note": ("Head-and-shoulders crops of the figurine sheet, standing in until the "
                 "real avatar set arrives. Boxes are cell-relative, like the atlas anchor: "
                 "add the sprite's x and y to reach the sheet. Regenerate with "
                 "Art/tools/make_portrait_crops.py."),
        "portraits": portraits,
    }
    with open(OUT, "w") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")
    print("wrote %s" % os.path.relpath(OUT, ART))


if __name__ == "__main__":
    main()
