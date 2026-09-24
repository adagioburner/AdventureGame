import { describe, expect, it } from 'vitest';
import { DEFAULT_RULESET } from '@adventure/config';
import { asNodeId } from '@adventure/core';
import { buildArtCatalog } from '../art/catalog.ts';
import { ART_FILES } from '../art/files.ts';
import { position } from '../render/geometry.ts';
import { pictureBox, ROUGH_SHAPE, type Box } from '../render/placement.ts';
import { previewGame } from '../render/scene.fixture.ts';
import { buildMapScene, buildStateScene, SPACING_PX } from '../render/sceneModel.ts';
import { figureTop, pick, pickCharacters, pickNode, planeToScreen, screenToPlane, TOUCH_SLOP_PX } from './picking.ts';

const catalog = buildArtCatalog(ART_FILES);
const game = previewGame('adventure', DEFAULT_RULESET);
const scene = buildMapScene(game.map, catalog);
const pictures = scene.billboards.filter((item) => item.layer === 'pois');
const screenOf = (node: number) => scene.projection.toScreen(position(game.map.graph, node));

describe('where a click lands', () => {
  it('turns a viewport point into the map’s plane and back', () => {
    const camera = { center: { x: 310, y: -40 }, zoom: 2.5 };
    const viewport = { x: 800, y: 600 };
    const screen = { x: 123, y: 456 };
    const back = planeToScreen(camera, viewport, screenToPlane(camera, viewport, screen));
    expect(back.x).toBeCloseTo(screen.x, 9);
    expect(back.y).toBeCloseTo(screen.y, 9);
    expect(screenToPlane(camera, viewport, { x: 400, y: 300 })).toEqual(camera.center);
  });

  it('finds every node when its own oval is clicked', () => {
    for (const node of game.map.graph.nodes) {
      expect(pickNode(scene, game.map, pictures, ROUGH_SHAPE, screenOf(node.id), 1)).toBe(node.id);
    }
  });

  it('forgives a finger: half a spacing at play zoom, a fingertip on screen when zoomed far out', () => {
    const node = game.map.graph.nodes[0];
    if (node === undefined) throw new Error('empty map');
    const at = screenOf(node.id);
    expect(pickNode(scene, game.map, [], ROUGH_SHAPE, { x: at.x + SPACING_PX * 0.2, y: at.y }, 1)).toBe(node.id);

    // Two spacings left of the leftmost node on screen: too far at zoom 1, but
    // at a zoom where two spacings are a few pixels, it is a fingertip away.
    const leftmost = [...game.map.graph.nodes].sort((a, b) => screenOf(a.id).x - screenOf(b.id).x)[0];
    if (leftmost === undefined) throw new Error('empty map');
    const beside = { x: screenOf(leftmost.id).x - SPACING_PX * 2, y: screenOf(leftmost.id).y };
    expect(pickNode(scene, game.map, [], ROUGH_SHAPE, beside, 1)).toBeNull();
    const zoom = (TOUCH_SLOP_PX / (SPACING_PX * 2)) * 0.9;
    expect(pickNode(scene, game.map, [], ROUGH_SHAPE, beside, zoom)).toBe(leftmost.id);
  });

  it('takes a click on a POI’s picture, away from every node, to mean that POI’s node', () => {
    let checked = 0;
    for (const picture of pictures) {
      const top = { x: picture.foot.x, y: picture.foot.y - picture.size * 0.6 };
      const nearNode = game.map.graph.nodes.some((node) => {
        const at = screenOf(node.id);
        return Math.hypot(top.x - at.x, (top.y - at.y) * 2) <= SPACING_PX * 0.5;
      });
      const inFront = pictures.some(
        (other) => other !== picture && other.depth > picture.depth && inside(pictureBox(other.foot, other.size, ROUGH_SHAPE(other.sprite)), top),
      );
      if (nearNode || inFront) continue;
      expect(pickNode(scene, game.map, pictures, ROUGH_SHAPE, top, 1)).toBe(picture.node);
      checked++;
    }
    expect(checked).toBeGreaterThan(pictures.length / 4);
  });

  it('finds a player’s figure, and says whose it is', () => {
    const characters = buildStateScene(scene, game.state, catalog).characters;
    for (const figure of characters) {
      const chest = { x: figure.foot.x, y: figure.foot.y - figure.size * 0.4 };
      expect(pickCharacters(characters, ROUGH_SHAPE, chest)).toContain(figure.player);
    }
    const start = game.state.players[0]?.position ?? asNodeId(0);
    const tapped = pick(scene, game.map, characters, pictures, ROUGH_SHAPE, screenOf(start), 1);
    expect(tapped.node).toBe(start);
    // Both start on one node, side by side: one click there finds both.
    expect(new Set(tapped.players)).toEqual(new Set(game.state.players.map((player) => player.id)));
    expect(pickCharacters(characters, ROUGH_SHAPE, { x: screenOf(start).x + SPACING_PX * 3, y: screenOf(start).y })).toEqual([]);
  });

  it('finds the top of a player’s figure, where a claim’s notice floats up from', () => {
    const characters = buildStateScene(scene, game.state, catalog).characters;
    for (const figure of characters) {
      if (figure.player === undefined) continue;
      const top = figureTop(characters, ROUGH_SHAPE, figure.player);
      if (top === null) throw new Error('no top');
      const box = pictureBox(figure.foot, figure.size, ROUGH_SHAPE(figure.sprite));
      expect(top.y).toBe(box.minY);
      expect(top.y).toBeLessThan(figure.foot.y);
      expect(top.x).toBeGreaterThan(box.minX);
      expect(top.x).toBeLessThan(box.maxX);
      // Just below the top is the figure itself.
      expect(pickCharacters(characters, ROUGH_SHAPE, { x: top.x, y: top.y + 1 })).toContain(figure.player);
    }
    expect(figureTop([], ROUGH_SHAPE, game.state.players[0]?.id ?? ('nobody' as never))).toBeNull();
  });
});

function inside(box: Box, point: { x: number; y: number }): boolean {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}
