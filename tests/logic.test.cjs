"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/logic.js");

const { decodePng } = require("./png.cjs");

// Premultiplied test image: 4x4 "cells", some transparent sky, some partial alpha.
function makeImage(w, h) {
  const img = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cx = x >> 2, cy = y >> 2, o = (y * w + x) * 4;
    if (cy < 3) continue; // sky
    const a = (cx + cy) % 7 === 0 ? 128 : 255;
    const r = (cx * 37 + cy * 11) & 255, g = (cx * 5 + cy * 53) & 255, b = (x ^ y) & 255;
    img[o] = Math.round(r * a / 255); img[o + 1] = Math.round(g * a / 255); img[o + 2] = Math.round(b * a / 255); img[o + 3] = a;
  }
  return img;
}

async function encode(img, w, h, k, mode, bg, stripH) {
  const parts = [];
  const enc = L.createPngEncoder({ width: w / k, height: h / k, k, mode, bg }, async (b) => { parts.push(Buffer.from(b)); });
  for (let y = 0; y < h; y += stripH) {
    const sh = Math.min(stripH, h - y);
    const strip = new Uint8Array(w * stripH * 4); // larger than needed on the last strip, like the runtime
    strip.set(img.subarray(y * w * 4, (y + sh) * w * 4));
    await enc.addStrip(strip, w, sh);
  }
  await enc.finish();
  return Buffer.concat(parts);
}

test("plan covers the region exactly once and every tile fits its frame", () => {
  const cases = [
    { x0: 0, y0: 0, x1: 15360, y1: 15360, worldW: 15360, worldH: 15360, frameW: 1920, frameH: 1088, margin: 32 },
    { x0: 0, y0: 4096, x1: 4096, y1: 3072 * 4, worldW: 4096, worldH: 3072 * 4, frameW: 1920, frameH: 1088, margin: 32 },
    { x0: 0, y0: 0, x1: 1200, y1: 800, worldW: 1200, worldH: 800, frameW: 1920, frameH: 1088, margin: 32 },
    { x0: 0, y0: 0, x1: 4096, y1: 3072, worldW: 4096, worldH: 3072, frameW: 960, frameH: 544, margin: 32 },
  ];
  for (const c of cases) {
    const plan = L.planTiles(c), W = c.x1 - c.x0, H = c.y1 - c.y0, seen = new Uint8Array((W / 4) * (H / 4));
    assert.equal(plan.sy % 4, 0);
    for (const row of plan.rows) for (const t of row.tiles) {
      assert.ok(L.tileOffset(t, t.camX, t.camY, c.frameW, c.frameH), JSON.stringify(t));
      assert.ok(t.camX >= 0 && t.camY >= 0 && t.camX <= Math.max(0, c.worldW - c.frameW) && t.camY <= Math.max(0, c.worldH - c.frameH));
      for (let y = t.y; y < t.y + t.h; y += 4) for (let x = t.x; x < t.x + t.w; x += 4) seen[((y - c.y0) / 4) * (W / 4) + (x - c.x0) / 4]++;
    }
    assert.ok(seen.every((v) => v === 1), "each cell exactly once");
  }
  assert.equal(L.planTiles(cases[0]).count, 9 * 15);
});

test("copyTileToStrip flips GL rows", () => {
  const fw = 8, fh = 6, frame = new Uint8Array(fw * fh * 4);
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) frame[((fh - 1 - y) * fw + x) * 4] = y * 10 + x; // top-down value y*10+x
  const strip = new Uint8Array(5 * 2 * 4);
  L.copyTileToStrip(frame, fw, fh, 2, 3, 3, 2, strip, 5, 1);
  assert.equal(strip[(0 * 5 + 1) * 4], 32); assert.equal(strip[(0 * 5 + 3) * 4], 34); assert.equal(strip[(1 * 5 + 1) * 4], 42);
});

test("PNG round trip: transparent, native scale", async () => {
  const w = 64, h = 48, img = makeImage(w, h);
  const d = decodePng(await encode(img, w, h, 1, "transparent", null, 20));
  assert.equal(d.w, 64); assert.equal(d.h, 48); assert.equal(d.ct, 6);
  const ref = L.unpremultiply(img.slice());
  assert.deepEqual([...d.px], [...ref]);
});

test("PNG round trip: downscale 2 and 4 average premultiplied pixels", async () => {
  const w = 64, h = 48, img = makeImage(w, h);
  for (const k of [2, 4]) {
    const d = decodePng(await encode(img, w, h, k, "transparent", null, 16));
    assert.equal(d.w, w / k); assert.equal(d.h, h / k);
    const ref = L.unpremultiply(L.downscalePremul(img, w, h, k).slice());
    assert.deepEqual([...d.px], [...ref]);
  }
});

test("PNG round trip: filled background is RGB with sky above and cave below the surface", async () => {
  const w = 32, h = 32, img = new Uint8Array(w * h * 4);
  // terrain from row 16 down, with a transparent hole at (4..8, 20..24)
  for (let y = 16; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; img.set([100, 50, 25, 255], o); }
  for (let y = 20; y < 24; y++) for (let x = 4; x < 8; x++) img.set([0, 0, 0, 0], (y * w + x) * 4);
  const bg = { surface: new Int32Array(w).fill(16), sky0: [0, 0, 100], sky1: [100, 200, 255], skyEnd: 16, cave: [21, 33, 12] };
  const d = decodePng(await encode(img, w, h, 1, "filled", bg, 12));
  assert.equal(d.ct, 2);
  const at = (x, y) => [...d.px.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
  assert.deepEqual(at(0, 0), [0, 0, 100]);
  assert.deepEqual(at(0, 8), [50, 100, 178]);
  assert.deepEqual(at(5, 21), [21, 33, 12]);
  assert.deepEqual(at(10, 21), [100, 50, 25]);
});

test("encoder handles a big strip without growing the file absurdly", async () => {
  const w = 1024, h = 256, img = makeImage(w, h);
  const png = await encode(img, w, h, 1, "transparent", null, 256);
  assert.ok(png.length < w * h * 4 / 4, "compresses at least 4x: " + png.length);
});

test("x-ray window replaces fog by kind and copies everything else", () => {
  const W = 6, H = 4, map = new Uint8Array(W * H * 4).fill(7), ids = new Uint32Array(W * H);
  ids[1 * W + 1] = 4;    // Fog -> empty
  ids[1 * W + 2] = 6;    // FogWater -> replacement 0
  ids[2 * W + 3] = 1001; // damaged cell whose type is FogLava -> replacement 1
  ids[2 * W + 4] = 2;    // dirt, untouched
  const kinds = new Uint8Array(1001); kinds[4] = 1; kinds[6] = 2; kinds[13] = 3;
  const damaged = new Int32Array(10); damaged[0] = 13;
  const reps = [{ material: 5, variants: [[1, 2, 3, 255]] }, { material: 50, variants: [[9, 8, 7, 255]] }];
  const out = new Uint8Array(4 * 3 * 4);
  const n = L.xrayWindow(out, map, ids, damaged, W, H, 1, 1, 4, 3, kinds, reps);
  assert.equal(n, 3);
  const at = (c, r) => [...out.subarray((r * 4 + c) * 4, (r * 4 + c) * 4 + 4)];
  assert.deepEqual(at(0, 0), [0, 0, 0, 0]);
  assert.deepEqual(at(1, 0), [1, 2, 3, 5]);
  assert.deepEqual(at(2, 1), [9, 8, 7, 50]);
  assert.deepEqual(at(3, 1), [7, 7, 7, 7]);
  assert.deepEqual(at(0, 2), [7, 7, 7, 7]);
  // window hanging off the world edge is zero-filled there
  const out2 = new Uint8Array(4 * 2 * 4);
  L.xrayWindow(out2, map, ids, damaged, W, H, 4, 3, 4, 2, kinds, reps);
  assert.deepEqual([...out2.subarray(0, 4)], [7, 7, 7, 7]);
  assert.deepEqual([...out2.subarray(2 * 4, 3 * 4)], [0, 0, 0, 0]);
  assert.deepEqual([...out2.subarray(4 * 4, 5 * 4)], [0, 0, 0, 0]);
});

test("scanWorld finds the top row and per-column surface", () => {
  const W = 4, H = 6, map = new Uint8Array(W * H * 4), wall = new Uint8Array(W * H);
  map[(3 * W + 0) * 4 + 3] = 150; map[(4 * W + 1) * 4 + 3] = 120; map[(2 * W + 2) * 4 + 3] = 5; // water above col 2
  map[(5 * W + 2) * 4 + 3] = 150; map[(1 * W + 3) * 4 + 3] = 253; // structure cell, not terrain
  wall[2 * W + 1] = 9;
  const s = L.scanWorld(map, wall, W, H);
  assert.equal(s.topRow, 1);
  assert.deepEqual([...s.surface], [3, 4, 5, 6]);
});
