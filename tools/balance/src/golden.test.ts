import { describe, expect, it } from 'vitest';

import { DEFAULT_RULESET, withoutSeparateAreas, withRewardsBeforeMove } from '@adventure/config';
import { generateAndReport } from './index.ts';
import { formatMapSummary } from './report.ts';

/**
 * The golden map snapshot.
 *
 * A generated map is an exact function of `(seed, ruleset)`, so this is the
 * loudest possible alarm for a reordered pipeline step or a draw taken out of
 * turn — either of which moves every downstream number without breaking a
 * single hand-written assertion. Read `golden/README.md` before updating it,
 * and note that `golden/rng/` comes first: if the PRNG stream has moved, this
 * file's diff means nothing until that one is explained.
 *
 * It lives here rather than in `packages/mapgen` because `formatMapSummary` is
 * the harness's own record format, and a second copy of it would be one more
 * thing to keep in step.
 */
describe('golden map', () => {
  it('matches the committed snapshot for seed "adventure"', async () => {
    const { map } = generateAndReport('adventure', DEFAULT_RULESET);
    await expect(formatMapSummary(map)).toMatchFileSnapshot('../../../golden/maps/adventure.txt');
  }, 30000);

  // [Q245, 913] A game kept from before the forest and mountains grew in separate areas is
  // drawn again on the map it began on: this file is the snapshot above as it
  // stood until then, and should never need updating for a seed count. [Q250] Its
  // rewards were on the terrains they had before they moved, as the app draws it.
  it('draws the map from before separate areas unchanged for seed "adventure"', async () => {
    const { map } = generateAndReport('adventure', withoutSeparateAreas(withRewardsBeforeMove(DEFAULT_RULESET)));
    await expect(formatMapSummary(map)).toMatchFileSnapshot('../../../golden/maps/adventure-earlier-seeds.txt');
  }, 30000);
});
