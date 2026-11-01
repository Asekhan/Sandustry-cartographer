# Cartographer

A Sandustry mod that saves your whole world as one PNG, at up to the game's own detail (4 px per
cell: a 3840-cell world is 15,360 px wide). Sandustry 0.5.6 and 0.6.0.

## Use

The **map button** (top right) or **F7** opens the panel; **Esc** cancels a capture.

- **Explorer** look: reveals caves and terrain hidden in the dark. **Game** look: what the game shows.
- **Area:** whole map, a large area (1488 × 1080 cells) or around you (496 × 360), centred on the view.
- **Size:** full, half or small. **Background:** sky or transparent.
- **White lamps:** lamps you built light in white; glowing ores and other natural lights keep their colour (0.6.0).

Only takes pictures: the world is never changed. The game pauses during the capture.

## Build

```bash
node tools/build.cjs && node --test tests/*.test.cjs
```

Copy `mod/` to `%APPDATA%\sandustry\mods\asekhan.cartographer\` and restart the game.

## How it works

- The mod moves `session.overrideCamera` tile by tile and reads each frame with `gl.readPixels`
  after it is drawn: the renderer's `postrender` event on 0.5.6 (Pixi 7), and on 0.6.0 (Pixi 8)
  `renderer.runners.postrender`, keeping only the pass drawn to the screen.
- Before each frame (`frame:render`) it hides the player and edge mist, moves the player's lamp
  away and freezes shader time; game time is frozen and the mouse parked off the map (no tool
  previews) on `frame:update`. For Explorer it rewrites the visible colour window (fog cells drawn
  as what they hide) and caps the shadow window so open space is at least 30 % lit.
- White lamps recolour the lights that sit on a `Light` structure in the 0.6.0 light batches
  (`pixi.lightBuffer`) and redraw the light textures.
- The simulation is paused through the simulation manager (`session.paused` would stop rendering too).
- PNG strips are encoded in a worker (`CompressionStream("deflate")`) and written straight to the
  file from `showSaveFilePicker`; a download is the fallback.

## License

MIT
