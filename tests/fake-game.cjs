"use strict";
// A fake Sandustry 0.5.6 runtime: just the pieces Cartographer touches. The "renderer" draws a
// known world pattern at the current camera, so stitched output can be checked pixel by pixel.
const CELL = 4;

// Premultiplied RGBA of world pixel (x, y): transparent sky above skyRows cells.
function worldPixel(x, y, skyRows) {
  if ((y >> 2) < skyRows) return [0, 0, 0, 0];
  return [(x * 7 + y * 3) & 255, ((x >> 2) ^ (y >> 2)) & 255, ((x + y) >> 3) & 255, 255];
}

// pixi8: the 0.6.0 renderer: no postrender event, a postrender runner called after each of three
// render passes a frame, of which only the last is drawn to the screen (the others read empty).
function makeGame({ W = 256, H = 192, frameW = 320, frameH = 192, skyRows = 40, staleFirstFrame = false, fog = null, pixi8 = false } = {}) {
  const handlers = {}, rHandlers = {}, posted = [];
  const mapData = new Uint8Array(W * H * 4), cellIds = new Uint32Array(W * H), wall = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (y >= skyRows) { mapData[(y * W + x) * 4 + 3] = 150; cellIds[y * W + x] = 2; }
  }
  if (fog) for (let y = fog.y0; y < fog.y1; y++) for (let x = fog.x0; x < fog.x1; x++) cellIds[y * W + x] = fog.type;
  const tw = Math.max(4, Math.floor(frameW / CELL) - (Math.floor(frameW / CELL) % 4)), th = Math.floor(frameH / CELL);
  const timesWhileCapturing = [];
  let renderedCam = { x: 0, y: 0 }, lastCam = { x: 0, y: 0 }, renderCount = 0, colorUpdates = 0, onScreen = true;
  const runner = { items: [], add(o) { this.items.push(o); }, remove(o) { this.items = this.items.filter((x) => x !== o); } };
  const gl = {
    RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, FRAMEBUFFER: 0x8d40, FRAMEBUFFER_BINDING: 0x8ca6,
    drawingBufferWidth: frameW, drawingBufferHeight: frameH,
    getParameter: () => null, getContextAttributes: () => ({ premultipliedAlpha: true }), bindFramebuffer() {},
    readPixels(x0, y0, w, h, f, t, buf) {
      if (!onScreen) { buf.fill(0, 0, w * h * 4); return; }
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const wx = renderedCam.x + c, wy = renderedCam.y + (h - 1 - r); // GL rows are bottom-up
        const p = wx < 0 || wy < 0 || wx >= W * CELL || wy >= H * CELL ? [0, 0, 0, 255] : worldPixel(wx, wy, skyRows);
        buf.set(p, (r * w + c) * 4);
      }
    },
  };
  const renderer = {
    gl,
    on(ev, fn) { (rHandlers[ev] = rHandlers[ev] || []).push(fn); },
    off(ev, fn) { rHandlers[ev] = (rHandlers[ev] || []).filter((f) => f !== fn); },
  };
  if (pixi8) Object.assign(renderer, { runners: { postrender: runner }, renderTarget: { renderTarget: { isRoot: true } } });
  const ctx2d = { canvas: { width: frameW, height: frameH }, save() {}, restore() {}, setTransform() {}, clearRect() {} };
  const pixi = {
    app: { renderer }, foregroundSprite: { visible: true }, colorBuffer: new Uint8Array(tw * th * 4),
    colorTexture: { update() { colorUpdates++; } }, tilemapSize: { width: tw, height: th },
    filter: { uniforms: { time: 1, lightPosition: [0, 0] } }, outlineElementsFilter: { uniforms: { time: 2 } },
    mountainsSprite: { parent: { parent: { visible: true } } },
    sprites: { player: { container: { visible: true }, trailContainer: { visible: true } } },
    edgeMist: { sprite: { renderable: true } }, dynamic2D: { context: ctx2d },
    shadowMapTilemap: new Uint8Array(tw * th), shadowMapTexture: { update() { shadowUpdates++; } },
  };
  let shadowUpdates = 0, lastShadow = null;
  const state = {
    session: {
      camera: { x: 100, y: 60 }, overrideCamera: false, lerpCamera: false, paused: false,
      resolution: { width: frameW, height: frameH }, view: { zoom: 1 }, rendering: { pixi },
      colors: { scheme: { element: { 3: { variants: [[30, 90, 200, 255]] }, 19: { variants: [[220, 70, 10, 255]] } } } },
    },
    store: { world: { size: { width: W, height: H } }, meta: { time: 5000 }, scene: { active: 2 } },
    shared: { mapData: { data: mapData, width: W, height: H }, wallData: { data: wall, width: W, height: H }, sim: { cellIds, damagedGround: { type: new Int32Array(16) } } },
    environment: { multithreading: { simulation: { manager: { postMessage: (m) => posted.push(m) } } } },
  };
  const api = {
    events: { on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); } },
    terrains: { getDefinitionByType: (t) => (t === 4 || t === 6 || t === 13 ? { fog: true } : t === 2 ? { hp: 4 } : undefined) },
    elements: { getDefinitionByType: () => ({ metaColor: 0x123456 }) },
    ui: { inject() {}, toast() {} },
  };
  const sandkit = { state, api, enums: { CellType: { Fog: 4, FogWater: 6, FogLava: 13 }, ElementType: { Water: 3, Lava: 19 }, Scene: { Game: 2 } },
    react: { createElement: (t, p, ...c) => ({ t, p, c }), useState: (v) => [v, () => {}], useEffect: (fn) => fn() } };

  // One game frame: update (frame:update), camera follows the override, render (frame:render
  // fires just before drawing), then Pixi's postrender.
  function tick() {
    state.store.meta.time += 16; // the game advances time before its update
    for (const f of handlers["frame:update"] || []) f({});
    if (state.session.overrideCamera) { state.session.camera.x = state.session.overrideCamera.x; state.session.camera.y = state.session.overrideCamera.y; }
    pixi.shadowMapTilemap.fill(127); // the game re-uploads its shadow window every frame (127 = dark)
    for (const f of handlers["frame:render"] || []) f({});
    if (state.session.overrideCamera) lastShadow = { data: pixi.shadowMapTilemap.slice(), camX: state.session.camera.x, camY: state.session.camera.y, minLight: pixi.filter.uniforms.minLightAmount };
    const cam = { x: state.session.camera.x, y: state.session.camera.y };
    const moved = cam.x !== lastCam.x || cam.y !== lastCam.y;
    renderedCam = staleFirstFrame && moved ? lastCam : cam; // optionally show the old view for one frame
    lastCam = cam;
    renderCount++;
    if (state.session.overrideCamera) timesWhileCapturing.push(state.store.meta.time);
    if (!pixi8) { for (const f of rHandlers.postrender || []) f(); return; }
    for (const root of [false, false, true]) {
      onScreen = root; renderer.renderTarget.renderTarget.isRoot = root;
      for (const o of runner.items.slice()) o.postrender();
    }
    onScreen = true;
  }
  async function runFrames(promise) {
    let done = false, err = null, value;
    promise.then((v) => { done = true; value = v; }, (e) => { done = true; err = e; });
    while (!done) { tick(); await new Promise((r) => setImmediate(r)); }
    if (err) throw err;
    return value;
  }
  return { sandkit, state, pixi, posted, timesWhileCapturing, tick, runFrames, worldPixel: (x, y) => worldPixel(x, y, skyRows), W, H,
    get renderCount() { return renderCount; }, get colorUpdates() { return colorUpdates; }, get shadowUpdates() { return shadowUpdates; }, get lastShadow() { return lastShadow; }, tw, th, skyRows, get postrenderHandlers() { return (rHandlers.postrender || []).length + runner.items.length; } };
}
module.exports = { makeGame, CELL };
