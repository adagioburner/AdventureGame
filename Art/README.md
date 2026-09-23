# Art

Everything the game draws comes from this folder, and one file decides which
picture is drawn for what: [`manifest.json`](manifest.json). No code names a
file in here. Swapping a picture is a file drop, sometimes plus one line of the
manifest, and never a code change.

## What is here

| Kind | Files | Drawn as |
| --- | --- | --- |
| Sprite sheet | `<Name>_sheet.png` + `<Name>_atlas.json` | POIs, dressing, figurines, move markers, dice |
| Terrain texture | `<Terrain>_Texture_sheet.png` + atlas, one sprite, `"tiles": "both"` | The ground of every cell of that terrain, tiled |
| Road brush | `Roads_Brush_sheet.png` + atlas, one sprite, `"tiles": "horizontal"` | Every road, stretched along it |
| Reward icon | `Icons/<reward kind>.png` | One icon per reward unit under a POI |
| Portrait crops | `player_avatars_portraits.json` | Head-and-shoulders boxes on the figurine sheet (temporary, Q26) |

A sheet is paired with its atlas by file name, `<Name>_sheet.png` with
`<Name>_atlas.json`. The atlas's own `"sheet"` field is not read: five of the
supplied atlases name a file that was renamed after they were written.

The icons are named for the reward kind they stand for (`plains_move.png`,
`forest_move.png`, `mountain_move.png`, `fighting.png`, `magic.png`, `gold.png`,
`stamina.png`). They are matched by picture, not by the names they arrived
with: the wagon wheel is plains movement, the green foot is forest movement,
the black mountain is mountain movement.

## Swapping a picture

1. **Same name.** Drop the new `<Name>_sheet.png` and `<Name>_atlas.json` over
   the old ones. Nothing else changes. The sprites can be any size and any
   count: every sheet is scaled on load so its typical sprite (the median of
   each sprite's larger solid side) comes out at the manifest's `size`,
   measured in node spacings, where one node spacing is the length of a
   typical road. A POI's `artVariant` picks sprite `variant mod count`, so a
   sheet of four and a sheet of twelve both work.
2. **New name.** Drop the files, then change the one manifest line that names
   the old sheet. A new POI sheet for forest gold, for example, replaces
   `Mountains_GoldGuardedByFighting` in the forest-gold row and drops that
   row's `borrowed` note.
3. **Real art replacing a placeholder.** Delete `"placeholder": true` from the
   new atlas. The viewer's "Art in use" panel lists every picture as
   placeholder, borrowed or supplied, from exactly these flags.
4. **A sheet that draws its own soft shadow.** Most supplied sheets bake their
   drop shadow in as opaque flat grey (`#bbbbbb`), which the loader turns into
   translucent black so it darkens the ground it falls on. A replacement whose
   shadow is already translucent should lose its line under `shadows` in the
   manifest.
5. **Run the tests.** `pnpm test` checks that every sheet and icon the
   manifest names exists, that each PNG is at least as large as its atlas
   says, that every POI kind the rules can produce has a picture, and that
   textures tile. A broken drop fails with one message listing every problem.

## Atlas format

```json
{
  "sheet": "Plains_Magic_sheet.png",
  "cell_width": 457,
  "cell_height": 587,
  "sprites": [
    { "id": "Plains_Magic_01", "x": 0, "y": 0, "width": 457, "height": 587,
      "anchor": { "x": 228, "y": 575 } }
  ]
}
```

`x`, `y`, `width` and `height` place the sprite on the sheet. `anchor` is
where it touches the ground, relative to its own top left: the foot of a
building or a figure, which the renderer stands on the node. Most supplied
sheets put it at the bottom of the baked shadow instead; once the shadow is
keyed, a sprite whose anchor sits below its lowest solid pixel stands on that
pixel, so its feet and not its shadow touch the node. Sprite ids must
be unique within a sheet. Optional sprite fields: `tiles` (`"both"` for a
terrain texture, `"horizontal"` for a road stroke), `centerline_y` for where a
stroke's centre runs, and `role`, `state` and `value` labelling marker and die
sprites. A generated sheet also carries `"placeholder": true` at the top
level. Anything else, such as `source_box_in_original`, is there for people
and ignored by the game.

## How the manifest is organised

- `terrain`: per terrain, its texture and how many node spacings one tile of
  it covers, the colour of its nodes' ovals, and its dressing sheets with a
  size, a relative weight and a density (dressing sprites per node). A
  dressing sheet marked `"layer": "backdrop"` (the mountains) is painted onto
  the ground under the roads and nodes, so it can stand anywhere on its
  terrain; without it, dressing stands up among the POIs and is kept clear of
  the nodes and roads.
- `pois`: one row per picture. A row matches a POI on its reward kind; its
  `terrain` is the POI's own or `any`, and a row naming the POI's guard type
  beats one that doesn't. The red or purple on a guarded POI's node always
  comes from the POI's actual guard, never from the row. Rows with a
  `borrowed` note are the Q20 substitutions: forest gold and stamina POIs have
  no sheet of their own yet.
- `icons`, `guards`, `roads`, `nodes`: reward icons, the red and purple guard
  colours with the size and outline width of a guarded POI's node and the
  size of the guard's number, the road brush and width, and the node ovals.
- `move_prospect`: which marker sprites draw §7.1's dots, crosses, waypoint
  flag and active-player ring, and their sizes.
- `figurines`, `portraits`, `dice`: the player figures, their portrait crops
  and the die sheet.

## Placeholders

`tools/make_placeholders.py` draws every sheet flagged `"placeholder": true`:
the die, the road brush, the three terrain textures and the move markers. It
writes the same bytes every run, so rerunning it after editing it changes only
what was edited. `tools/make_portrait_crops.py` rederives the portrait boxes.
