import { describe, expect, it } from 'vitest';
import {
  adjustColors,
  keyShadows,
  outlinePictures,
  solidBands,
  solidBounds,
  SOLID_ALPHA,
  standingAnchor,
  typicalSpan,
} from './pixels.ts';

function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels.set(paint(x, y), (y * width + x) * 4);
  }
  return pixels;
}

describe('keyShadows', () => {
  it('turns the flat grey shadow into translucent black and leaves the picture alone', () => {
    // Left column: the baked-in #bbbbbb shadow, one off either way. Right: a
    // figure, whose own grey does not touch the shadow and must survive.
    const figure = (x: number): [number, number, number, number] =>
      x === 0 ? [187, 187, 187, 255] : x === 2 ? [185, 185, 185, 255] : x === 3 ? [60, 40, 30, 255] : [0, 0, 0, 0];
    const pixels = image(4, 3, (x, y) => (x === 0 ? [186 + y, 187, 188 - y, 255] : figure(x)));
    const changed = keyShadows(pixels, 4, ['#bbbbbb'], 0.3);
    expect(changed).toBe(3);
    for (let y = 0; y < 3; y++) {
      expect([...pixels.slice(y * 16, y * 16 + 4)]).toEqual([0, 0, 0, 77]);
      expect([...pixels.slice(y * 16 + 8, y * 16 + 12)]).toEqual([185, 185, 185, 255]);
    }
  });

  it('takes the near-grey rim with the shadow it surrounds, and nothing beyond it', () => {
    // One row, as exported: shadow, a rim of near-greys, clear, then a grey
    // pixel of the picture that the rim does not reach.
    const row: [number, number, number, number][] = [
      [187, 187, 187, 255],
      [185, 185, 185, 255],
      [184, 184, 184, 255],
      [195, 195, 195, 255],
      [0, 0, 0, 0],
      [190, 190, 190, 255],
      [60, 40, 30, 255],
    ];
    const pixels = image(row.length, 1, (x) => row[x] ?? [0, 0, 0, 0]);
    expect(keyShadows(pixels, row.length, ['#bbbbbb'], 0.3)).toBe(4);
    expect(pixels[3 * 4 + 3]).toBe(77);
    expect([...pixels.slice(5 * 4, 6 * 4)]).toEqual([190, 190, 190, 255]);
  });

  it('keys a detached patch of lighter shadow grey, but not grey that belongs to the picture', () => {
    // One row: shadow, clear, a patch of 196 greys with no key pixel in it,
    // clear, then a figure whose own 196 grey touches its darker body.
    const row: [number, number, number, number][] = [
      [187, 187, 187, 255],
      [0, 0, 0, 0],
      [196, 196, 196, 255],
      [197, 197, 197, 255],
      [0, 0, 0, 0],
      [196, 196, 196, 255],
      [60, 40, 30, 255],
    ];
    const pixels = image(row.length, 1, (x) => row[x] ?? [0, 0, 0, 0]);
    expect(keyShadows(pixels, row.length, ['#bbbbbb'], 0.3)).toBe(3);
    expect(pixels[2 * 4 + 3]).toBe(77);
    expect(pixels[3 * 4 + 3]).toBe(77);
    expect([...pixels.slice(5 * 4, 6 * 4)]).toEqual([196, 196, 196, 255]);
  });

  it('does not let a faint edge pixel, its grey skewed by the canvas, save a patch from keying', () => {
    // Read back from a premultiplied canvas, a nearly clear 198 grey comes out
    // as 212: outside the range, but not picture either.
    const row: [number, number, number, number][] = [
      [212, 212, 212, 20],
      [197, 197, 197, 255],
      [196, 196, 196, 190],
    ];
    const pixels = image(row.length, 1, (x) => row[x] ?? [0, 0, 0, 0]);
    keyShadows(pixels, row.length, ['#bbbbbb'], 0.3);
    expect(pixels[1 * 4 + 3]).toBe(77);
    expect(pixels[2 * 4 + 3]).toBe(57);
  });

  it('never keys a shadow solid enough to be measured as picture', () => {
    const pixels = image(1, 1, () => [187, 187, 187, 255]);
    keyShadows(pixels, 1, ['#bbbbbb'], 0.9);
    expect(pixels[3]).toBeLessThan(SOLID_ALPHA);
  });
});

describe('solidBounds and typicalSpan', () => {
  it('measures the solid part of a cell, not its padding or its shadow', () => {
    // A 10×10 cell with a 3×4 figure at (2, 1) and a faint shadow beside it.
    const pixels = image(10, 10, (x, y) => {
      if (x >= 2 && x < 5 && y >= 1 && y < 5) return [200, 50, 50, 255];
      if (y === 6) return [0, 0, 0, 77];
      return [0, 0, 0, 0];
    });
    expect(solidBounds(pixels, 10, { x: 0, y: 0, width: 10, height: 10 })).toEqual({ x: 2, y: 1, width: 3, height: 4 });
    expect(solidBounds(pixels, 10, { x: 6, y: 0, width: 4, height: 4 })).toBeNull();
  });

  it('takes the median of the larger side, ignoring empty cells', () => {
    const box = (width: number, height: number) => ({ x: 0, y: 0, width, height });
    expect(typicalSpan([box(10, 4), box(3, 30), box(20, 20), null], 99)).toBe(20);
    expect(typicalSpan([null], 99)).toBe(99);
  });
});

describe('solidBands', () => {
  it('says where the picture is in each band of its extent, and which bands hold none of it', () => {
    // A 4-wide roof over a 2-wide trunk, an empty row between, in an 8×8 cell.
    const pixels = image(8, 8, (x, y) => {
      if (y < 2 && x >= 1 && x < 5) return [200, 50, 50, 255];
      if (y >= 3 && y < 6 && x >= 2 && x < 4) return [90, 60, 30, 255];
      if (y === 6) return [0, 0, 0, 77];
      return [0, 0, 0, 0];
    });
    const extent = solidBounds(pixels, 8, { x: 0, y: 0, width: 8, height: 8 });
    expect(extent).toEqual({ x: 1, y: 0, width: 4, height: 6 });
    if (extent === null) return;
    expect(solidBands(pixels, 8, extent, 3)).toEqual([{ left: 1, right: 5 }, { left: 2, right: 4 }, { left: 2, right: 4 }]);
    expect(solidBands(pixels, 8, extent, 6)).toEqual([
      { left: 1, right: 5 },
      { left: 1, right: 5 },
      null,
      { left: 2, right: 4 },
      { left: 2, right: 4 },
      { left: 2, right: 4 },
    ]);
  });
});

describe('standingAnchor', () => {
  // A sprite in the second cell of a row, 100 wide and 120 tall.
  const sprite = { x: 100, y: 0, width: 100, height: 120, anchor: { x: 50, y: 110 } };

  it('stands a figure on its feet when the atlas anchor is down in its baked shadow', () => {
    expect(standingAnchor(sprite, { x: 130, y: 10, width: 40, height: 70 })).toEqual({ x: 50, y: 80 });
  });

  it('keeps an anchor that is already inside the picture', () => {
    expect(standingAnchor(sprite, { x: 110, y: 5, width: 80, height: 112 })).toEqual({ x: 50, y: 110 });
    expect(standingAnchor(sprite, null)).toEqual({ x: 50, y: 110 });
  });
});

describe('adjustColors', () => {
  it('lifts darks more than lights, keeps white and black, and leaves alpha alone', () => {
    const row: [number, number, number, number][] = [
      [64, 64, 64, 255],
      [191, 191, 191, 200],
      [255, 255, 255, 255],
      [0, 0, 0, 77],
    ];
    const pixels = image(4, 1, (x) => row[x] ?? [0, 0, 0, 0]);
    adjustColors(pixels, 2, 1);
    // sqrt(0.25) = 0.5 and sqrt(0.75) = 0.866: the dark grey gains 64, the light one 30.
    expect([...pixels]).toEqual([128, 128, 128, 255, 221, 221, 221, 200, 255, 255, 255, 255, 0, 0, 0, 77]);
  });

  it('pushes a colour away from its own grey, and leaves a grey as it is', () => {
    const pixels = image(2, 1, (x) => (x === 0 ? [100, 150, 100, 255] : [120, 120, 120, 255]));
    adjustColors(pixels, 1, 2);
    const grey = 0.299 * 100 + 0.587 * 150 + 0.114 * 100;
    expect([...pixels.slice(0, 3)]).toEqual([100, 150, 100].map((c) => Math.round(grey + (c - grey) * 2)));
    expect([...pixels.slice(4, 8)]).toEqual([120, 120, 120, 255]);
  });

  it('does nothing at 1 and 1', () => {
    const pixels = image(1, 1, () => [10, 200, 30, 255]);
    adjustColors(pixels, 1, 1);
    expect([...pixels]).toEqual([10, 200, 30, 255]);
  });
});

describe('outlinePictures', () => {
  // A 3×3 red square in the middle of a 13×13 cell, beside a second cell.
  const cell = (x: number, y: number): [number, number, number, number] =>
    x >= 5 && x < 8 && y >= 5 && y < 8 ? [200, 0, 0, 255] : [0, 0, 0, 0];

  it('draws the contour round the picture, as thick on a diagonal as on a side, and not beyond', () => {
    const pixels = image(13, 13, cell);
    outlinePictures(pixels, 13, [{ x: 0, y: 0, width: 13, height: 13 }], 2, [255, 255, 255]);
    const at = (x: number, y: number) => [...pixels.slice((y * 13 + x) * 4, (y * 13 + x) * 4 + 4)];
    expect(at(6, 6)).toEqual([200, 0, 0, 255]);
    expect(at(4, 6)).toEqual([255, 255, 255, 255]); // the first pixel out
    expect(at(3, 6)).toEqual([255, 255, 255, 255]); // the second
    expect(at(2, 6)[3]).toBe(0);
    // Off the corner the contour rounds: (4, 4) is well inside it, (3, 3)
    // only just reaches its edge, (2, 2) is clear.
    expect(at(4, 4)).toEqual([255, 255, 255, 255]);
    expect(at(3, 3)[3]).toBeGreaterThan(0);
    expect(at(3, 3)[3]).toBeLessThan(64);
    expect(at(2, 2)[3]).toBe(0);
  });

  it('anti-aliases a contour that ends part way through a pixel', () => {
    const pixels = image(13, 13, cell);
    outlinePictures(pixels, 13, [{ x: 0, y: 0, width: 13, height: 13 }], 1.5, [255, 255, 255]);
    expect(pixels[(6 * 13 + 3) * 4 + 3]).toBe(128);
  });

  it('lays the contour over a keyed shadow and under the picture\'s soft edge', () => {
    const pixels = image(13, 13, (x, y) =>
      x === 4 && y === 6 ? [0, 0, 0, 77] : x === 5 && y === 6 ? [100, 0, 0, 128] : cell(x, y),
    );
    outlinePictures(pixels, 13, [{ x: 0, y: 0, width: 13, height: 13 }], 2, [255, 255, 255]);
    const at = (x: number, y: number) => [...pixels.slice((y * 13 + x) * 4, (y * 13 + x) * 4 + 4)];
    expect(at(4, 6)).toEqual([255, 255, 255, 255]);
    // Half-opaque dark red over white: the edge blends into the contour, not the ground.
    expect(at(5, 6)).toEqual([177, 127, 127, 255]);
  });

  it('keeps each sprite\'s contour inside its own cell', () => {
    // The picture touches the right edge of the first cell; the second is empty.
    const pixels = image(20, 5, (x, y) => (x >= 7 && x < 10 && y >= 1 && y < 4 ? [0, 0, 200, 255] : [0, 0, 0, 0]));
    outlinePictures(
      pixels,
      20,
      [
        { x: 0, y: 0, width: 10, height: 5 },
        { x: 10, y: 0, width: 10, height: 5 },
      ],
      2,
      [255, 255, 255],
    );
    expect(pixels[(2 * 20 + 6) * 4 + 3]).toBe(255);
    for (let x = 10; x < 20; x++) expect(pixels[(2 * 20 + x) * 4 + 3], `x ${x}`).toBe(0);
  });

  it('leaves an empty cell empty', () => {
    const pixels = image(4, 4, () => [0, 0, 0, 0]);
    outlinePictures(pixels, 4, [{ x: 0, y: 0, width: 4, height: 4 }], 2, [255, 255, 255]);
    expect(pixels.every((value) => value === 0)).toBe(true);
  });
});
