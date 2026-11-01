# Cartographer: whole-map snapshot

A Sandustry mod (0.5.6 and 0.6.0) that saves the whole world as one PNG, up to 4 px per cell
(the game's own resolution: a 3840-cell world is 15,360 px wide).

In a game: the **map button** under the menu button (top right) or **F7** opens the panel;
**Esc** cancels a capture. Areas: whole map, large area (1488 × 1080 cells) or around you
(496 × 360 cells), centred on the view.

Looks:
- **Explorer**: x-ray on; open space (caves, tunnels, buildings) at least 30 % lit, solid ground at
  least 20 %. Brighter spots keep the game's lighting.
- **Game**: the game's lighting, no x-ray.
- **White lamps** (either look, 0.6.0): lamps you built light in white; glowing ores and other
  natural lights keep their colour.

Render-only: the world is never written to. The simulation pauses during the sweep.

## Folders
| Path | What |
|---|---|
| `src/` | `logic.js` (pure: tiling, PNG encoder, x-ray window), `capture.js` (camera sweep, frame hooks), `ui.js` (panel, saving), `worker.js` (encoder worker) |
| `mod/` | Built mod: `main.js`, `modinfo.json`, `preview.png`. This is what gets installed and uploaded. Only `preview.png` is in the repo; the rest comes from the build, and the built package is attached to each GitHub release |
| `tools/build.cjs` | Bundles `src/` into `mod/main.js`, writes `modinfo.json` (name, version, Steam description) |
| `tools/make_art.py` | Builds `mod/preview.png` and `workshop/screenshots/` from real captures |
| `tests/` | `node --test tests/*.test.cjs`: logic, a fake game (stitching, restore, floors, x-ray), the built bundle |
| `workshop/` | Local only (not in the repo): main-picture brief, Workshop screenshots, and the full-size captures they come from |

## Recipes
- **Build and test:** `node tools/build.cjs && node --test tests/*.test.cjs`
- **Install:** copy `mod/main.js`, `mod/modinfo.json` and `mod/preview.png` into
  `%APPDATA%\sandustry\mods\asekhan.cartographer\`, then restart the game (mods load at start).
  Never delete `workshop.json` there: it holds the Workshop item id.
- **Publish or update on the Workshop:** bump `VERSION` in `tools/build.cjs` (it becomes the change
  note), build, install, then press Upload on Cartographer in the game's local mods list. The first
  upload creates an **unlisted** item and writes `workshop.json`; copy that file into `mod/` here.
  On the Steam page: set visibility to Public, accept the Workshop agreement if asked, and add
  `workshop/screenshots/*.png`.
- **Refresh the art:** take an Explorer and a Game capture at full size, then
  `python3 -I tools/make_art.py --explorer EXPLORER.png --game GAME.png --panel PANEL.png`.
- **Steam title and description:** `name` and `DESCRIPTION` in `tools/build.cjs` (plain text; it
  also shows in the game's mod list).

## How it works (0.5.6 / 0.6.0 internals)
- The game draws a fixed 1920 × 1088 frame at 1 world px per px. The mod moves
  `session.overrideCamera` tile by tile and reads the 2nd frame drawn at each position with
  `gl.readPixels` after the frame is drawn (in game the 1st is right for most tiles; a few lag by
  one frame). 0.5.6 (Pixi 7) emits the renderer's `postrender` event once a frame. 0.6.0 (Pixi 8)
  has no such event: the mod adds itself to `renderer.runners.postrender`, which runs after each
  of the frame's three render passes, and reads only the pass drawn to the screen
  (`renderer.renderTarget.renderTarget.isRoot`); the other two draw into textures.
- The panel is injected with `api.ui.inject`; the button is mounted in the `hud.topRight` region
  (`api.ui.regions.mount`). Mountable regions: `hotbar`, `global`, `mainMenu.actions`,
  `hud.topLeft`, `hud.topRight`.
- On `frame:render` (just before drawing) it hides the player and edge mist, moves
  the player's lamp off-screen, freezes shader time (game time is frozen on `frame:update`, where
  the mouse is also parked off the map so tool previews aren't drawn; the 2D overlay they use also
  draws structure parts such as heat cannon nozzles, so it is left alone), and
  for Explorer edits the visible windows the game just uploaded:
  - colour window (`pixi.colorBuffer`): fog cells replaced by what they hide (x-ray);
  - shadow window (`pixi.shadowMapTilemap`): open cells capped so they are at least 30 % lit
    (brightness = 1 − 2·shadow/255);
  - `filter.uniforms.minLightAmount` = rock floor. Fully shadowed rock (255) takes the shader's flat
    branch (no lamp light), which keeps the crisp black outlines.
- White lamps: 0.6.0 fills two light batches (`pixi.lightBuffer.clamped` / `.unclamped`, instances of
  `[x, y, size, intensity, r, g, b]` in screen px) and draws them into light textures before
  `frame:render`. On `frame:render` the mod recolours the lights that sit on a `Light` structure's
  4 × 4 cells, uploads the batch and draws those textures again.
- The simulation is paused with message `[54, true]` to the simulation manager (`session.paused`
  would stop rendering too).
- PNG: strips go to a Blob-URL worker (filter + `CompressionStream("deflate")`) and are written
  straight to the file from `showSaveFilePicker`; a download is the fallback.
