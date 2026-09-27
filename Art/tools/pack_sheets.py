#!/usr/bin/env python3
"""Pack the artist's sheets in Art/originals/ into the game's sheets and atlases.

The artist draws a sheet as a loose grid of pictures on a square canvas, each
with its own soft grey drop shadow. The game wants what every other pair in
Art/ is: a `<Name>_sheet.png` of equal cells, four to a row, one picture per
cell, and a `<Name>_atlas.json` saying where each cell is and where its picture
stands. This makes the one from the other:

  python3 Art/tools/pack_sheets.py

It reads each original named in SHEETS below, and for every picture on it:

1. finds the picture: the rows of the canvas holding anything visible, then
   within each such band the columns holding anything visible. Pictures on a
   sheet are spaced apart by transparent canvas, but two can come within a few
   pixels of each other across a whole sheet while not in any one row, so the
   columns are measured row by row. A speck too small to be a picture is joined
   to the picture it lies against, or dropped if it lies against none;
2. makes its shadow dark and see-through (Q59, detail 89). The shadow is a
   run of grey that touches the clear canvas and lies mostly in the lower half
   of the picture: see-through grey, sometimes tinted by what casts it, or on
   sheets that draw their shadows solid, neutral grey near the sheet's own
   shadow grey. It becomes black, at SHADOW_OPACITY where it was most solid
   and fading out as it did, so its shape and soft edge stay as drawn. Nothing
   in a picture above that half, no grey that does not reach the canvas edge
   (armour, stone) and no picture's own soft edge is touched. One picture
   defeats this: the amber slime's shadow is tinted by its own glow and ringed
   by it, so it keeps the shadow it was drawn with;
3. stands it in a cell: its solid part (alpha at least SOLID_ALPHA, the same
   threshold the game measures sizes with) centred across the cell, its lowest
   visible pixel PAD above the cell's floor. The atlas `anchor` is the middle
   of that solid part's foot, which is where the game stands it.

Everything else about a picture is left exactly as drawn. The originals stay in
Art/originals/ unchanged, so a new version of a sheet from the artist goes in
by replacing its original and running this again. The same inputs always give
byte-identical output.

No third-party imports, like the other tools here: PNGs are read and written
with zlib alone.
"""

import json
import os
import struct
import zlib
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.dirname(HERE)
ORIGINALS = os.path.join(ART, "originals")

# Target sheet name -> the originals it is packed from, in order, each with the
# number of pictures on it. The count is a check: a sheet that splits into any
# other number stops the tool rather than being packed wrong.
SHEETS = {
    "player_avatars": [("player_avatars.png", 6)],
    "Plains_Dressing": [("Plains_Dressing.png", 25)],
    "Forest_Trees": [("Forest_Trees.png", 12)],
    "Plains_PlainsMovement": [("Plains_PlainsMovement.png", 12)],
    "Plains_ForestMovement": [("Plains_ForestMovement.png", 12)],
    "Forest_MountainMovement": [("Forest_MountainMovement.png", 12)],
    "Plains_Magic": [("Plains_Magic.png", 12)],
    "Forest_Fighting": [("Forest_Fighting.png", 12)],
    "Plains_GoldGuardedByFighting": [("Plains_GoldGuardedByFighting.png", 6)],
    "Mountains_GoldGuardedByFighting": [
        ("Mountains_GoldGuardedByFighting_1.png", 12),
        ("Mountains_GoldGuardedByFighting_2.png", 12),
    ],
    "Mountains_GoldGuardedByMagic": [("Mountains_GoldGuardedByMagic.png", 12)],
}

COLUMNS = 4
# Transparent margin round the pictures in a cell, as on the sheets already in Art/.
PAD = 12
# The sheets carry a faint haze of alpha 1 to 8 across the canvas; anything
# above this is part of a picture.
VISIBLE = 8
# A band of visible rows or columns narrower than this is a speck, not a picture.
SPECK = 20
# A speck this close to a picture belongs to it.
SPECK_REACH = 4
# The game's own threshold (apps/web/src/art/pixels.ts SOLID_ALPHA): anything at
# least this opaque is picture rather than shadow when sizes are measured.
SOLID_ALPHA = 128
# How dark a shadow is where it was drawn most solid: the strength the manifest's
# `shadows.opacity` gives the older sheets' shadows.
SHADOW_OPACITY = 0.3
# A shadow pixel is at least SHADOW_FLOOR opaque and either see-through (alpha
# at most SEE_THROUGH) and a grey, perhaps tinted (channels within SHADOW_TINT
# of each other, brightest channel between SHADOW_DARKEST and SHADOW_LIGHTEST),
# or a neutral grey (channels within GREY_TINT) within SHADOW_GREY_REACH of the
# sheet's shadow grey, for sheets whose shadows are drawn solid. It lies in a
# run of more than SHADOW_MIN_PIXELS that touches the clear canvas, more than
# EDGE_WIDTH from the rest of the picture except where it meets it.
SHADOW_FLOOR = 16
SEE_THROUGH = 250
SHADOW_TINT = 36
SHADOW_DARKEST = 40
SHADOW_LIGHTEST = 185
GREY_TINT = 10
SHADOW_GREY_REACH = 24
SHADOW_MIN_PIXELS = 60
EDGE_WIDTH = 2


# --- PNG ---------------------------------------------------------------------

def read_png(path):
    """Decode a non-interlaced 8-bit RGBA PNG into (width, height, bytearray)."""
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
                raise ValueError("%s: expected 8-bit RGBA, non-interlaced" % path)
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
    return width, height, out


def write_png(path, width, height, rgba):
    """Encode RGBA bytes, each row filtered by `up` (most rows here are clear)."""
    stride = width * 4
    raw = bytearray()
    prev = bytes(stride)
    for y in range(height):
        line = rgba[y * stride:(y + 1) * stride]
        raw.append(2)
        raw += bytes((line[i] - prev[i]) & 255 for i in range(stride))
        prev = line

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


# --- finding the pictures -----------------------------------------------------

def runs(flags):
    """[start, end) of each run of true values."""
    out, start = [], None
    for i, flag in enumerate(flags):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            out.append([start, i])
            start = None
    if start is not None:
        out.append([start, len(flags)])
    return out


def bands(flags, where, dropped):
    """Runs of visible rows or columns, each speck joined to a picture it touches."""
    found = runs(flags)
    big = [r for r in found if r[1] - r[0] >= SPECK]
    for speck in (r for r in found if r[1] - r[0] < SPECK):
        near = [b for b in big if speck[0] - b[1] <= SPECK_REACH and b[0] - speck[1] <= SPECK_REACH]
        if near:
            near[0][0] = min(near[0][0], speck[0])
            near[0][1] = max(near[0][1], speck[1])
        else:
            dropped.append("%s %d-%d" % (where, speck[0], speck[1] - 1))
    return big


def pictures(width, height, px, name):
    """Boxes (x0, y0, x1, y1) of the pictures on a canvas, row by row, left to right."""
    alpha = px[3::4]
    visible = bytes(1 if a > VISIBLE else 0 for a in alpha)
    rows = [any(visible[y * width:(y + 1) * width]) for y in range(height)]
    dropped, boxes = [], []
    for y0, y1 in bands(rows, "%s rows" % name, dropped):
        columns = [any(visible[y * width + x] for y in range(y0, y1)) for x in range(width)]
        for x0, x1 in bands(columns, "%s rows %d-%d, columns" % (name, y0, y1 - 1), dropped):
            # Tighten to the picture itself: the band is as tall as the tallest in its row.
            top = next(y for y in range(y0, y1) if any(visible[y * width + x0:y * width + x1]))
            bottom = next(y for y in range(y1 - 1, y0 - 1, -1) if any(visible[y * width + x0:y * width + x1]))
            boxes.append((x0, top, x1, bottom + 1))
    for speck in dropped:
        print("  dropped a speck at %s" % speck)
    return boxes


# --- shadows ------------------------------------------------------------------

def shadow_grey(width, px, boxes):
    """The sheet's shadow grey: the median neutral grey among its translucent
    pixels, or among all its neutral pixels where the shadows are drawn solid."""
    translucent, neutral = [], []
    for x0, y0, x1, y1 in boxes:
        for y in range(y0, y1):
            for i in range((y * width + x0) * 4, (y * width + x1) * 4, 4):
                r, g, b, a = px[i], px[i + 1], px[i + 2], px[i + 3]
                if a < SHADOW_FLOOR or max(r, g, b) - min(r, g, b) > GREY_TINT:
                    continue
                neutral.append((r + g + b) / 3.0)
                if a <= 245:
                    translucent.append(neutral[-1])
    pool = sorted(translucent if len(translucent) > 500 else neutral)
    return pool[len(pool) // 2] if pool else None


def dilate(mask, w, h, reach):
    """Every cell within `reach` of a set cell, counting diagonals as one step."""
    rows = bytearray(w * h)
    for y in range(h):
        base = y * w
        for x in range(w):
            if mask[base + x]:
                rows[base + max(0, x - reach):base + min(w, x + reach + 1)] = b"\x01" * (min(w, x + reach + 1) - max(0, x - reach))
    out = bytearray(w * h)
    for y in range(h):
        base = y * w
        for x in range(w):
            if rows[base + x]:
                for yy in range(max(0, y - reach), min(h, y + reach + 1)):
                    out[yy * w + x] = 1
    return out


def shadow_of(width, px, box, grey):
    """The pixels of one picture's drop shadow, as sheet indices."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    alpha = bytearray(w * h)
    candidate = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            i = ((y0 + y) * width + x0 + x) * 4
            r, g, b, a = px[i], px[i + 1], px[i + 2], px[i + 3]
            alpha[y * w + x] = a
            if a < SHADOW_FLOOR:
                continue
            tint = max(r, g, b) - min(r, g, b)
            # A see-through grey, perhaps tinted by what casts it; or, where a
            # sheet draws its shadows solid, a neutral grey near the sheet's own.
            if (a <= SEE_THROUGH and tint <= SHADOW_TINT and SHADOW_DARKEST <= max(r, g, b) <= SHADOW_LIGHTEST) or (
                    tint <= GREY_TINT and grey is not None and abs((r + g + b) / 3.0 - grey) <= SHADOW_GREY_REACH):
                candidate[y * w + x] = 1

    # The picture's own soft edge is shadow-coloured too, a pixel or two wide all
    # the way round it. Only candidates clear of the picture by more than that
    # can start a shadow; the edge is then taken back only where the shadow
    # meets it.
    body = bytearray(1 if alpha[p] >= SHADOW_FLOOR and not candidate[p] else 0 for p in range(w * h))
    near_body = dilate(body, w, h, EDGE_WIDTH)
    shadow = bytearray(w * h)
    seen = bytearray(w * h)
    for start in range(w * h):
        if seen[start] or not candidate[start] or near_body[start]:
            continue
        seen[start] = 1
        queue, run, open_edge = deque([start]), [], False
        while queue:
            p = queue.popleft()
            run.append(p)
            py, qx0 = divmod(p, w)
            for qx, qy in ((qx0 + 1, py), (qx0 - 1, py), (qx0, py + 1), (qx0, py - 1)):
                if not (0 <= qx < w and 0 <= qy < h):
                    open_edge = True
                    continue
                q = qy * w + qx
                if alpha[q] < SHADOW_FLOOR:
                    open_edge = True
                elif not seen[q] and candidate[q] and not near_body[q]:
                    seen[q] = 1
                    queue.append(q)
        rows = sorted(p // w for p in run)
        if open_edge and len(run) > SHADOW_MIN_PIXELS and rows[len(rows) // 2] >= h * 0.5:
            for p in run:
                shadow[p] = 1

    frontier = [p for p in range(w * h) if shadow[p]]
    for _ in range(EDGE_WIDTH):
        grown = []
        for p in frontier:
            py, px_ = divmod(p, w)
            for qx, qy in ((px_ + 1, py), (px_ - 1, py), (px_, py + 1), (px_, py - 1)):
                if 0 <= qx < w and 0 <= qy < h and candidate[qy * w + qx] and not shadow[qy * w + qx]:
                    shadow[qy * w + qx] = 1
                    grown.append(qy * w + qx)
        frontier = grown
    return [(y0 + p // w) * width + x0 + p % w for p in range(w * h) if shadow[p]]


def darken_shadows(width, px, boxes):
    """Turn each picture's grey drop shadow black and see-through, in place."""
    grey = shadow_grey(width, px, boxes)
    shadow = []
    for box in boxes:
        shadow.extend(shadow_of(width, px, box, grey))

    # Where the shadow was drawn most solid (its 90th percentile, so a few
    # stray opaque pixels do not set it) becomes SHADOW_OPACITY; fainter parts
    # fade in proportion, which keeps the soft edge.
    strengths = sorted(px[p * 4 + 3] for p in shadow)
    if not strengths:
        return 0
    core = strengths[min(len(strengths) - 1, int(len(strengths) * 0.9))]
    for p in shadow:
        i = p * 4
        px[i] = px[i + 1] = px[i + 2] = 0
        px[i + 3] = int(min(1.0, px[i + 3] / core) * SHADOW_OPACITY * 255)
    return len(strengths)


def solid_box(width, px, box):
    """The part of a picture at least SOLID_ALPHA opaque, (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = box
    xs, ys = [], []
    for y in range(y0, y1):
        for x in range(x0, x1):
            if px[(y * width + x) * 4 + 3] >= SOLID_ALPHA:
                xs.append(x)
                ys.append(y)
    if not xs:
        raise ValueError("a picture at %r has no solid part" % (box,))
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


# --- packing --------------------------------------------------------------------

def pack(name, sources):
    pieces = []
    for original, expected in sources:
        path = os.path.join(ORIGINALS, original)
        width, height, px = read_png(path)
        boxes = pictures(width, height, px, original)
        if len(boxes) != expected:
            raise SystemExit("%s: found %d pictures, expected %d: %r" % (original, len(boxes), expected, boxes))
        shaded = darken_shadows(width, px, boxes)
        print("  %s: %d pictures, %d shadow pixels darkened" % (original, len(boxes), shaded))
        for box in boxes:
            pieces.append((original, width, px, box, solid_box(width, px, box)))

    # One cell size for the sheet, wide enough for every picture centred on its
    # solid part and tall enough for every picture standing on the same floor.
    reach = 0
    tallest = 0
    for _, _, _, (x0, y0, x1, y1), (sx0, _, sx1, _) in pieces:
        centre = (sx0 + sx1) / 2.0
        reach = max(reach, centre - x0, x1 - centre)
        tallest = max(tallest, y1 - y0)
    cell_w = 2 * (int(reach) + 1) + 2 * PAD
    cell_h = tallest + 2 * PAD
    rows = (len(pieces) + COLUMNS - 1) // COLUMNS
    sheet_w, sheet_h = COLUMNS * cell_w, rows * cell_h
    out = bytearray(sheet_w * sheet_h * 4)

    sprites = []
    for index, (original, width, px, box, solid) in enumerate(pieces):
        x0, y0, x1, y1 = box
        sx0, _, sx1, sy1 = solid
        cell_x, cell_y = (index % COLUMNS) * cell_w, (index // COLUMNS) * cell_h
        # Where the picture's top-left lands inside its cell.
        left = cell_w // 2 - (sx0 + sx1) // 2 + x0
        top = cell_h - PAD - (y1 - y0)
        for y in range(y0, y1):
            src = (y * width + x0) * 4
            dst = ((cell_y + top + y - y0) * sheet_w + cell_x + left) * 4
            out[dst:dst + (x1 - x0) * 4] = px[src:src + (x1 - x0) * 4]
        sprites.append({
            "id": "%s_%02d" % (name, index + 1),
            "x": cell_x,
            "y": cell_y,
            "width": cell_w,
            "height": cell_h,
            "anchor": {"x": cell_w // 2, "y": top + (sy1 - y0)},
            "original": original,
            "source_box_in_original": [x0, y0, x1 - x0, y1 - y0],
        })

    write_png(os.path.join(ART, "%s_sheet.png" % name), sheet_w, sheet_h, out)
    atlas = {
        "sheet": "%s_sheet.png" % name,
        "cell_width": cell_w,
        "cell_height": cell_h,
        "notes": ("Packed by Art/tools/pack_sheets.py from Art/originals/, the artist's sheets as "
                  "supplied, with each picture's grey drop shadow made black and see-through. "
                  "Do not edit by hand: replace the original and run the tool again."),
        "sprites": sprites,
    }
    with open(os.path.join(ART, "%s_atlas.json" % name), "w") as fh:
        json.dump(atlas, fh, indent=2)
        fh.write("\n")
    print("  wrote %s_sheet.png, %d cells of %dx%d" % (name, len(sprites), cell_w, cell_h))


def main():
    import sys
    only = set(sys.argv[1:])
    for name, sources in SHEETS.items():
        if only and name not in only:
            continue
        print(name)
        pack(name, sources)


if __name__ == "__main__":
    main()
