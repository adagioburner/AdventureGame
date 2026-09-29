/**
 * [Q71] Andrei's rulebook, distilled from GDD.md, is a Claude Docs page
 * of his own. [223] It opens in a new tab, in front of the game, which stays
 * where it was in its own tab.
 */
export const RULES_URL = 'https://claude.ai/code/artifact/9a233211-bc03-4a3d-af5c-ca9ade3eaca0';

/**
 * [Q71, 220, 221 and 231] Rules in a bar button's style: last in the top bar,
 * and last in the Menu on a phone held upright. Not on the screens before a
 * game starts (the setup on this device, login, and an online game's setup).
 */
export function RulesButton() {
  return (
    <a className="btn" href={RULES_URL} target="_blank" rel="noopener noreferrer">
      Rules
    </a>
  );
}
