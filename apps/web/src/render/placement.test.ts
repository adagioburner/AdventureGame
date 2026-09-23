import { describe, expect, it } from 'vitest';
import { asNodeId } from '@adventure/core';
import { distance } from './geometry.ts';
import {
  boxTouchesOval,
  footTouching,
  grow,
  PICTURE_DIRECTIONS,
  pictureBands,
  type PoiPicture,
  type SpriteShape,
} from './placement.ts';

const oval = { at: { x: 0, y: 0 }, rx: 20, ry: 10 };
const picture = (shape: SpriteShape): PoiPicture => ({
  node: asNodeId(0),
  oval,
  sprite: { sheet: 'Test', index: 0 },
  size: 100,
  onNode: false,
});
const touches = (shape: SpriteShape, at: { x: number; y: number }, by = 0) =>
  pictureBands(at, 100, shape).some((band) => boxTouchesOval(grow(band, by), oval));

describe('footTouching', () => {
  // A tower on a narrow base: its box's lower corners are empty.
  const tower: SpriteShape = {
    left: -0.5,
    top: -1,
    right: 0.5,
    bottom: 0,
    bands: [
      { left: -0.5, top: -1, right: 0.5, bottom: -0.5 },
      { left: -0.1, top: -0.5, right: 0.1, bottom: 0 },
    ],
  };

  it('brings a picture in until the picture itself, not its box, touches the node', () => {
    // Andrei, 2026-09-23: "place POI images closer to the POIs themselves,
    // close to or touching the node".
    for (const angle of PICTURE_DIRECTIONS) {
      const foot = footTouching(picture(tower), angle, tower);
      expect(touches(tower, foot)).toBe(false);
      expect(touches(tower, foot, 0.5)).toBe(true);
    }
    const { bands: _, ...box } = tower;
    const byBox = footTouching(picture(box), 30, box);
    const byBands = footTouching(picture(tower), 30, tower);
    expect(distance(byBands, oval.at)).toBeLessThan(distance(byBox, oval.at) - 5);
  });

  it('never stands a picture with a gap in it over the node, showing it through the gap', () => {
    // A roof held well clear of its base: centred on the node, the node
    // would sit in the gap and touch neither.
    const arch: SpriteShape = {
      left: -0.5,
      top: -1,
      right: 0.5,
      bottom: 0,
      bands: [
        { left: -0.5, top: -1, right: 0.5, bottom: -0.7 },
        { left: -0.5, top: -0.2, right: 0.5, bottom: 0 },
      ],
    };
    const foot = footTouching(picture(arch), 90, arch);
    expect(touches(arch, foot)).toBe(false);
    // Straight behind the node, its base on the node's far rim.
    expect(foot.y).toBeCloseTo(oval.at.y - oval.ry, 0);
  });
});
