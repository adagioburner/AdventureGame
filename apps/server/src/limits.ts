import { DEFAULT_RULESET } from '@adventure/config';
import { setupLimitsFor } from '@adventure/session';
import figurines from '../../../Art/player_avatars_atlas.json' with { type: 'json' };

/**
 * What setup is checked against. The figure ids come from the same atlas the
 * page draws the figurines from (`Art/manifest.json` names its sheet), so the
 * server accepts exactly the figures a player can pick.
 */
export const SETUP_LIMITS = setupLimitsFor(
  DEFAULT_RULESET,
  figurines.sprites.map((sprite) => sprite.id),
);
