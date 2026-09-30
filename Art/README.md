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
| Artist's sheets | `originals/<Name>.png` | Nothing directly: `tools/pack_sheets.py` packs each into `<Name>_sheet.png` and its atlas |
| Sound effect | `Sounds/<name>.wav` | A footstep, a reward picked up, a battle won or lost, a rest, a new message (Q63) |

A sheet is paired with its atlas by file name, `<Name>_sheet.png` with
`<Name>_atlas.json`. The atlas's own `"sheet"` field is not read: five of the
supplied atlases name a file that was renamed after they were written.

The icons are named for the reward kind they stand for (`plains_move.png`,
`forest_move.png`, `mountain_move.png`, `fighting.png`, `magic.png`, `gold.png`,
`stamina.png`). They are matched by picture, not by the names they arrived
with: the wagon wheel is plains movement, the green foot is forest movement,
the black mountain is mountain movement.

## Swapping a picture

0. **A sheet as the artist draws it.** The artist's sheets are a loose grid of
   pictures on a square canvas, each with its own grey drop shadow, and no
   atlas. They are kept as supplied in `originals/`, named for the sheet they
   become, and `python3 Art/tools/pack_sheets.py` packs each into the game's
   four-to-a-row cells, writes its atlas, and makes its shadows dark and
   see-through (Q59). A new version of one goes in by replacing its original
   and running the tool again; a new one by adding a line to the tool's
   `SHEETS` table, saying which original it comes from and how many pictures
   are on it. Pictures are numbered row by row, left to right, as drawn. Then
   carry on from step 1 or 2.
1. **Same name.** Drop the new `<Name>_sheet.png` and `<Name>_atlas.json` over
   the old ones. Nothing else changes. The sprites can be any size and any
   count: every sheet is scaled on load so its typical sprite (the median of
   each sprite's larger solid side) comes out at the manifest's `size`,
   measured in node spacings, where one node spacing is the length of a
   typical road. Each sprite's own solid extent is measured too, and decides
   where it can stand without covering a road. A POI's `artVariant` picks
   sprite `variant mod count`, so a sheet of four and a sheet of twelve both
   work.
2. **New name.** Drop the files, then change the one manifest line that names
   the old sheet. A new POI sheet for forest gold, for example, replaces
   `Mountains_GoldGuardedByFighting` in the forest-gold row and drops that
   row's `borrowed` note.
3. **Real art replacing a placeholder.** Delete `"placeholder": true` from the
   new atlas. That flag, and the manifest's `borrowed` notes, are the one
   record of which pictures are not final; the game page no longer lists
   them.
4. **A sheet whose shadow is flat grey.** The first supplied sheets baked
   their drop shadow in as opaque flat grey (`#bbbbbb`); listing a sheet's
   shadow colours under `shadows` in the manifest has the loader turn them
   into translucent black, so they darken the ground they fall on. No sheet in
   use needs it: those packed from `originals/` have their shadows made dark
   as they are packed.
5. **A sheet the game brightens or outlines.** A sheet can be edited as it
   loads rather than in the PNG: brightened, its colours enriched, or given a
   contour, each one line under `adjustments` in the manifest. No sheet in use
   has one: the art is drawn as its artist made it (Q59).
6. **Run the tests.** `pnpm test` checks that every sheet and icon the
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
building or a figure, which the renderer stands on the node. A packed sheet
puts it under the middle of the picture, at its lowest solid pixel. Should an
anchor sit below that pixel, as the first supplied sheets' did at the bottom
of their shadows, the sprite stands on the pixel instead, so its feet and not
its shadow touch the node. Sprite ids must
be unique within a sheet. Optional sprite fields: `tiles` (`"both"` for a
terrain texture, `"horizontal"` for a road stroke), `centerline_y` for where a
stroke's centre runs, and `role`, `state` and `value` labelling marker and die
sprites. A generated sheet also carries `"placeholder": true` at the top
level. Anything else, such as `original` and `source_box_in_original`, is
there for people and ignored by the game.

## How the manifest is organised

- `terrain`: per terrain, its texture and how many node spacings one tile of
  it covers, the colour of its nodes' ovals, and its dressing sheets with a
  size, a relative weight and a density (standing dressing sprites per node).
  A dressing sheet marked `"layer": "backdrop"` (the mountains) is painted
  onto the ground under the roads and nodes and fills its whole terrain
  instead, largest first: sprites of its full `size` go wherever they fit
  over their own terrain, which is the middle of a region, and smaller ones,
  down to `min_size`, fill in round them and along the edges. Whatever still
  reaches past is clipped. Raising `size` makes the big peaks bigger. Without it, dressing
  stands up among the POIs and is kept clear of the nodes and roads, each
  sprite of the sheet equally likely. `"clusters"` names sprites, by id, that
  never stand alone (the bushes): picking one brings `min` to `max` of them,
  the rest picked at random from the list, standing close enough to touch
  and each counted towards the density. `"leave_out"` lists sprites of the
  sheet, by id, that are never drawn. Standing dressing never touches a
  POI's picture or reward.
- `pois`: one row per picture. A row matches a POI on its reward kind; its
  `terrain` is the POI's own or `any`, and a row naming the POI's guard type
  beats one that doesn't. The red or purple on a guarded POI's node always
  comes from the POI's actual guard, never from the row. Rows with a
  `borrowed` note have no sheet of their own yet: forest gold, whichever its
  guard (Q20, Q115), and stamina POIs (Q20). A row with `"on_node": true` (the guardians)
  stands its picture on the POI's node, feet across the back of it; every
  other picture stands beside its node, touching it (Q35).
- `icons`, `guards`, `roads`, `nodes`: reward icons (sized by their picture,
  so the transparent margin round an icon does not matter; `backing` says
  which the map draws on a beige disc with a coloured contour and which get a
  beige disc filling the gaps in them, Q61, while the players' cards show
  the files as they are), the red and
  purple guard colours with the width of the ring round a guarded POI's node
  and the size of the guard's number, the road brush and width, and the node
  ovals.
- `adjustments`: per sheet, edits made as it loads so the PNG stays as
  supplied. `brightness` lifts darks and midtones (each channel `c` from 0 to
  1 becomes `c^(1/brightness)`, so white stays white), `saturation` scales how
  far each colour sits from its own grey, and `outline` draws a contour of
  `color` round every picture on the sheet, behind the picture and over its
  shadow, `width` thick as a share of the sheet's typical sprite. A line for
  a sheet the manifest does not draw is reported as a problem.
- `move_prospect`: which marker sprites draw §7.1's dots, crosses, waypoint
  flag and active-player ring, and their sizes.
- `figurines`, `portraits`, `dice`: the player figures, their portrait crops
  and the die sheet.
- `sounds`: the sound effects (Q63), each a list of `files` under `Art/` and
  a `volume` (1 plays a file as it is, 0.5 at half). `step` is a footstep,
  played each time a walking figure reaches a node; `pickup` a reward taken
  from an unguarded POI; `battle_won` and `battle_lost` a guard beaten or
  not, as the die stops; `rest` a rest as it is shown; `message`, online, a
  message someone else posts. A sound with several files uses them in turn,
  so a walk's footsteps are not all alike.

## Swapping a sound

Drop a new file over the old one, or add it under a new name and change its
line under `sounds` in the manifest. WAV and MP3 play in every browser. Its
level is the file's own, times `volume`: the placeholders are all set to one
loudness as a phone's speaker plays it, the footsteps lower, so a replacement
that sounds louder or quieter than the rest takes a `volume` rather than an
edited file. A real sound replacing a placeholder loses its
`"placeholder": true`. `pnpm test` checks that every file the manifest names
is there.

## Placeholders

`tools/make_placeholders.py` draws every sheet flagged `"placeholder": true`:
the die, the road brush, the three terrain textures and the move markers.
The plains texture's grass is drawn through the inverse of the isometric
projection so it stands up on the map; anything a replacement texture shows
standing up off the ground needs the same treatment, or it leans right. It
writes the same bytes every run, so rerunning it after editing it changes only
what was edited. `tools/make_sounds.py` makes the eight sound files flagged `"placeholder": true`
under `sounds`, from the samples Andrei picked by ear, the same bytes every
run. `tools/make_portrait_crops.py` rederives the portrait boxes,
and `tools/pack_sheets.py` repacks the artist's sheets; both do the same
every run too.
