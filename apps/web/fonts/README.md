# The game's fonts

The page loads these from here, never from a font service, so everything the
game shows comes from this repository. `index.html` declares them.

| Font | Used for | Files | Licence |
| --- | --- | --- | --- |
| Public Sans (variable, weights 400 to 700) | words: buttons, cards, messages, the rulebook | `public-sans-latin.woff2`, `public-sans-latin-ext.woff2`, `public-sans-vietnamese.woff2` | [OFL-public-sans.txt](OFL-public-sans.txt) |
| IM Fell English SC | headings and player names | `im-fell-english-sc-latin.woff2` | [OFL-im-fell-english-sc.txt](OFL-im-fell-english-sc.txt) |

They are the exact files Google Fonts served on 2026-09-30 (Public Sans v21, IM
Fell English SC v16), split by alphabet the same way, so the page looks as it
did when it loaded them from Google. Each `@font-face` in `index.html` carries
the `unicode-range` of its file, so a browser downloads only the alphabets a
page uses. Both fonts are under the SIL Open Font License 1.1, which allows
bundling them with the game as long as the licence text travels with them.
