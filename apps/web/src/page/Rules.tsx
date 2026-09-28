/**
 * [Q71] Andrei's rulebook, distilled from GDD.md, is a Claude Docs page
 * of his own. [223] It opens in a new tab, in front of the game, which stays
 * where it was in its own tab.
 */
export const RULES_URL = 'https://claude.ai/code/artifact/9a233211-bc03-4a3d-af5c-ca9ade3eaca0';

/** [Q71, 220 and 221] Rules in a bar button's style: last in the top bar, and last in the Menu on a phone held upright. */
export function RulesButton() {
  return (
    <a className="btn" href={RULES_URL} target="_blank" rel="noopener noreferrer">
      Rules
    </a>
  );
}

/**
 * [Q71, 221 and 228 to 230] Before a game starts (the setup on this device,
 * login, and an online game's setup) "Rules" is in the style of the word
 * Adventure, at the right end of the bar. `besideTitle`: where the bar takes
 * more than one row on a narrow phone, it stays on the title's row, at its
 * right end; without it, it is at the right end of the last row (230).
 */
export function RulesTitle({ besideTitle = false }: { readonly besideTitle?: boolean }) {
  return (
    <a className={`rules-title${besideTitle ? ' beside-title' : ''}`} href={RULES_URL} target="_blank" rel="noopener noreferrer">
      Rules
    </a>
  );
}
