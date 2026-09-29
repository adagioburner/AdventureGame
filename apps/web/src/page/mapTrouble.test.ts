import { describe, expect, it } from 'vitest';
import { MAP_TROUBLE_WINDOW_MS, noteMapTrouble } from './mapTrouble.ts';

describe('noteMapTrouble', () => {
  it('builds the map again after a first and a second trouble', () => {
    const first = noteMapTrouble([], 1_000);
    expect(first).toEqual({ times: [1_000], rebuild: true });
    const second = noteMapTrouble(first.times, 3_000);
    expect(second).toEqual({ times: [1_000, 3_000], rebuild: true });
  });

  it('gives up on the third trouble within half a minute', () => {
    expect(noteMapTrouble([1_000, 3_000], 5_000)).toEqual({ times: [1_000, 3_000, 5_000], rebuild: false });
  });

  it('forgets troubles older than half a minute', () => {
    const later = 1_000 + MAP_TROUBLE_WINDOW_MS;
    expect(noteMapTrouble([1_000, 3_000], later)).toEqual({ times: [3_000, later], rebuild: true });
  });
});
