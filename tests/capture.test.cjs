"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/logic.js");
const Cap = require("../src/capture.js");
const { makeGame, CELL } = require("./fake-game.cjs");
const { decodePng } = require("./png.cjs");

async function capture(game, cfg, io = {}) {
  const parts = [];
  const write = async (b) => { parts.push(Buffer.from(b)); };
  const logs = [], progress = [];
  const result = await game.runFrames(Cap.run(game.sandkit, L, cfg, {
    openEncoder: async (info) => { const e = L.createPngEncoder(info, write); return { addStrip: async (s, w, h) => { await e.addStrip(s, w, h); return s; }, finish: () => e.finish(), abort: () => e.abort() }; },
    onProgress: (p) => progress.push(p), isCancelled: io.isCancelled || (() => false), log: (o) => logs.push(o),
  }));
  return { result, png: Buffer.concat(parts), logs, progress };
}
const base = { lighting: "lit", xray: false, background: "transparent", scale: 1, hidePlayer: true, trimSky: false };

test("stitched native capture equals the world pixel for pixel", async () => {
  const game = makeGame({ W: 256, H: 192, frameW: 320, frameH: 192, skyRows: 40 });
  const { result, png } = await capture(game, base);
  const d = decodePng(png);
  assert.equal(d.w, 1024); assert.equal(d.h, 768);
  for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
    const want = game.worldPixel(x, y), o = (y * d.w + x) * 4;
    if (d.px[o] !== want[0] || d.px[o + 1] !== want[1] || d.px[o + 2] !== want[2] || d.px[o + 3] !== want[3])
      assert.fail(`pixel ${x},${y}: got ${[...d.px.subarray(o, o + 4)]} want ${want}`);
  }
  assert.equal(result.stats.tiles, Math.ceil(1024 / 256) * Math.ceil(768 / 128));
  assert.equal(result.stats.frames, 2 * result.stats.tiles);
});

test("0.6.0 (Pixi 8): reads only the pass drawn to the screen, and unhooks the runner", async () => {
  const game = makeGame({ W: 128, H: 96, frameW: 320, frameH: 192, skyRows: 20, pixi8: true });
  const { result, png } = await capture(game, base);
  const d = decodePng(png);
  for (const [x, y] of [[0, 0], [300, 200], [511, 383], [100, 90]]) {
    const o = (y * d.w + x) * 4;
    assert.deepEqual([...d.px.subarray(o, o + 4)], game.worldPixel(x, y), `pixel ${x},${y}`);
  }
  assert.equal(result.stats.frames, 2 * result.stats.tiles, "one counted frame per screen pass");
  assert.equal(game.postrenderHandlers, 0);
});

test("restores camera, visibility and simulation; freezes game time while capturing", async () => {
  const game = makeGame({});
  const t0 = game.state.store.meta.time;
  await capture(game, Object.assign({}, base, { lighting: "fullbright" }));
  const s = game.state.session, p = game.pixi;
  assert.equal(s.overrideCamera, false);
  assert.deepEqual([s.camera.x, s.camera.y], [100, 60]);
  assert.equal(p.foregroundSprite.visible, true);
  assert.equal(p.mountainsSprite.parent.parent.visible, true);
  assert.equal(p.sprites.player.container.visible, true);
  assert.deepEqual(game.posted, [[54, true], [54, false]]);
  assert.equal(game.postrenderHandlers, 0);
  assert.ok(game.timesWhileCapturing.length > 10);
  assert.ok(game.timesWhileCapturing.every((t) => t === t0), "game time frozen while capturing");
});

test("keeps the 2nd frame at each camera position, so a one-frame lag after the jump is harmless", async () => {
  const game = makeGame({ staleFirstFrame: true });
  const { png, result } = await capture(game, base);
  const d = decodePng(png);
  for (const [x, y] of [[900, 700], [10, 10], [1023, 767], [500, 130]]) {
    const o = (y * d.w + x) * 4;
    assert.deepEqual([...d.px.subarray(o, o + 4)], game.worldPixel(x, y), `pixel ${x},${y}`);
  }
  assert.equal(result.stats.frames, 2 * result.stats.tiles, "exactly two frames per tile");
});

test("trim, downscale and filled background give the expected size", async () => {
  const game = makeGame({ W: 256, H: 192, skyRows: 100 });
  const { png } = await capture(game, Object.assign({}, base, { trimSky: true, scale: 2, background: "filled" }));
  const d = decodePng(png);
  const y0 = (100 - Cap.TRIM_PAD_CELLS) * CELL;
  assert.equal(d.ct, 2); assert.equal(d.w, 512); assert.equal(d.h, (768 - y0) / 2);
  assert.deepEqual([...d.px.subarray(0, 3)], [42, 111, 176], "sky colour at the top");
});

test("x-ray patches the colour window when fog is in view", async () => {
  const game = makeGame({ fog: { x0: 10, y0: 50, x1: 60, y1: 80, type: 6 } });
  const { result } = await capture(game, Object.assign({}, base, { xray: true }));
  assert.ok(result.stats.xrayCells > 0);
  assert.ok(game.colorUpdates > 0);
});

test("light floors: open space capped in the shadow map, solid ground untouched and floored by minLightAmount", async () => {
  assert.deepEqual([1, 0.6, 0.3, 0].map(Cap.shadowByteFor), [0, 51, 89, 255]);
  const game = makeGame({ skyRows: 40 });
  const { result } = await capture(game, Object.assign({}, base, { floorOpen: 0.6, floorRock: 0.3 }));
  assert.ok(result.stats.litCells > 0 && game.shadowUpdates > 0);
  const s = game.lastShadow, cy = Math.floor(s.camY / CELL);
  for (let r = 0; r < game.th && cy + r < game.H; r++) assert.equal(s.data[r * game.tw], cy + r < game.skyRows ? 51 : 127, "row " + (cy + r));
  assert.equal(s.minLight, 0.3);
  assert.equal(game.pixi.foregroundSprite.visible, true);
});

test("a rock floor at or above the cave floor needs no shadow edits", async () => {
  const game = makeGame({});
  const { result } = await capture(game, Object.assign({}, base, { floorOpen: 0.3, floorRock: 0.3 }));
  assert.equal(result.stats.litCells, 0); assert.equal(game.shadowUpdates, 0);
  assert.equal(game.lastShadow.minLight, 0.3);
});

test("game look leaves the shadow map alone; 100/100 hides the darkness", async () => {
  const game = makeGame({});
  const { result } = await capture(game, Object.assign({}, base, { floorOpen: 0, floorRock: 0 }));
  assert.equal(result.stats.litCells, 0); assert.equal(game.shadowUpdates, 0);
  const g2 = makeGame({});
  let seenHidden = false;
  g2.sandkit.api.events.on("frame:render", () => {});
  const p = capture(g2, Object.assign({}, base, { floorOpen: 1, floorRock: 1 }));
  const t = setInterval(() => { if (g2.state.session.overrideCamera && g2.pixi.foregroundSprite.visible === false) seenHidden = true; }, 0);
  await p; clearInterval(t);
  assert.ok(seenHidden, "overlay hidden during the capture");
  assert.equal(g2.pixi.foregroundSprite.visible, true, "restored after");
});

test("cancel stops early and still restores", async () => {
  const game = makeGame({ W: 512, H: 512 });
  let n = 0;
  await assert.rejects(capture(game, base, { isCancelled: () => ++n > 20 }), /Cancelled/);
  assert.equal(game.state.session.overrideCamera, false);
  assert.deepEqual(game.posted.at(-1), [54, false]);
});

test("refuses when paused or zoomed out", async () => {
  const game = makeGame({});
  game.state.session.paused = true;
  await assert.rejects(Cap.run(game.sandkit, L, base, {}), /paused/);
  game.state.session.paused = false; game.state.session.view.zoom = 0.5;
  await assert.rejects(Cap.run(game.sandkit, L, base, {}), /Zoom/);
});

test("white lamps: picked lights take their strongest channel, the others keep their colour", () => {
  // [x, y, size, intensity, r, g, b]
  const d = new Float32Array([10, 20, 600, 0.8, 0, 1, 0.5, 99, 20, 200, 1, 1, 0, 0]);
  Cap.whitenLights(d, 2, 7, (x) => x === 10);
  assert.deepEqual(Array.from(d.slice(4, 7)), [1, 1, 1]);
  assert.deepEqual(Array.from(d.slice(11, 14)), [1, 0, 0]);
  assert.deepEqual(Array.from(d.slice(0, 4)), [10, 20, 600, Math.fround(0.8)]);
});
