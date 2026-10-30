"use strict";
// Loads the built mod/main.js the way the game does (async IIFE with `sandkit`), in a fake
// browser + fake game, and runs a capture through the UI handle.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveObjectURL } = require("node:buffer");
const { makeGame } = require("./fake-game.cjs");
const { decodePng } = require("./png.cjs");

function fakeBrowser({ picker }) {
  const logs = [], clicked = [], keyHandlers = [];
  const el = (tag) => ({ tag, style: {}, children: [], innerHTML: "", appendChild(c) { this.children.push(c); }, remove() {},
    addEventListener() {}, querySelector: () => el("div"), click() { clicked.push(this); } });
  const saved = [];
  globalThis.window = {
    electron: { log: (lvl, tag, msg) => logs.push(JSON.parse(msg)) },
    addEventListener: (type, fn) => { if (type === "keydown") keyHandlers.push(fn); },
  };
  if (picker) window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, createWritable: async () => ({
    write: async (b) => { saved.push(Buffer.from(b)); }, close: async () => {}, abort: async () => {} }) });
  globalThis.document = { createElement: el, body: el("body") };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  return { logs, clicked, saved, keyHandlers };
}

async function load(game) {
  const src = fs.readFileSync(path.join(__dirname, "../mod/main.js"), "utf8");
  await new Function("__sandkit", `"use strict";\nconst sandkit = __sandkit;\nreturn (async () => {\n${src}\n})();`)(game.sandkit);
}

test("built mod loads, opens its panel on F7 and saves a correct PNG through the file picker", async () => {
  const b = fakeBrowser({ picker: true });
  const game = makeGame({});
  await load(game);
  assert.ok(b.logs.some((l) => l.loaded), "logged load");
  for (const k of b.keyHandlers) k({ code: "F7", key: "F7", repeat: false, stopPropagation() {}, preventDefault() {} });
  const tree = window.cartographer.Panel();
  assert.ok(tree && JSON.stringify(tree).includes("Capture"), "panel renders");
  assert.equal(window.cartographer.options.look, "explorer", "defaults to the Explorer look");
  Object.assign(window.cartographer.options, { trimSky: false, background: "transparent", look: "game" });
  await game.runFrames(window.cartographer.capture());
  const d = decodePng(Buffer.concat(b.saved));
  assert.equal(d.w, 1024); assert.equal(d.h, 768);
  const o = (500 * d.w + 777) * 4;
  assert.deepEqual([...d.px.subarray(o, o + 4)], game.worldPixel(777, 500));
  const done = b.logs.find((l) => l.saved);
  assert.equal(done.saved.sink, "file");
  assert.equal(done.saved.encoder, "main thread"); // no Worker in node: the fallback path
  assert.ok(b.logs.some((l) => l.encoderFallback));
});

test("area options capture a fixed-size area centred on the view, kept inside the world", async () => {
  for (const [area, w, hgt] of [["local", 496 * 4, 360 * 4], ["large", 1024 * 4, 768 * 4]]) {
    const b = fakeBrowser({ picker: true });
    const game = makeGame({ W: 1024, H: 768 });
    game.state.session.camera.x = 4 * 1000; game.state.session.camera.y = 4 * 20; // near the top-right corner
    await load(game);
    Object.assign(window.cartographer.options, { area, background: "transparent", look: "game" });
    await game.runFrames(window.cartographer.capture());
    const d = decodePng(Buffer.concat(b.saved));
    assert.deepEqual([d.w, d.h], [w, hgt], area);
    const x0 = 4 * (1024 - Math.min(1024, w / 4)), o = 4 * (5 * d.w + 7); // world pixel (x0 + 7, 5): the area is pushed against the corner
    assert.deepEqual([...d.px.subarray(o, o + 4)], game.worldPixel(x0 + 7, 5), area);
  }
});

test("without a file picker it falls back to a download", async () => {
  const b = fakeBrowser({ picker: false });
  const game = makeGame({});
  await load(game);
  Object.assign(window.cartographer.options, { trimSky: false, scale: 4 }); // Explorer look, filled background
  await game.runFrames(window.cartographer.capture());
  const a = b.clicked.find((x) => x.tag === "a");
  assert.ok(a && a.download.endsWith(".png"));
  const blob = resolveObjectURL(a.href);
  const d = decodePng(Buffer.from(await blob.arrayBuffer()));
  assert.equal(d.w, 256); assert.equal(d.h, 192);
});
