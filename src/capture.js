// Capture engine: drives the camera across the world, reads each rendered frame and feeds
// strips to an encoder. Render-only: it never writes world state. Uses Sandustry 0.5.6 / 0.6.0
// internals (camera, Pixi stage, shared cell arrays) because no stable API covers rendering.
const CartoCapture = (() => {
  const SIM_SET_PAUSED = 54;   // simulation manager message id (0.5.6)
  const MARGIN = 32;           // px kept around each tile's inner rect
  const SETTLE_FRAMES = 2;     // keep the 2nd frame drawn at each camera position (measured in game:
                               // the 1st is right for most tiles, a few lag by one frame)
  const STALL_MS = 6000;       // no rendered frame for this long = abort
  const TRIM_PAD_CELLS = 48;   // sky kept above the highest thing when trimming
  const WATER_MATERIAL = 5, DEFAULT_ELEMENT_MATERIAL = 50;
  const SKY_TOP = [42, 111, 176], SKY_HORIZON = [159, 212, 240];

  let current = null, installedOn = null;

  // With the player's lamp moved away, the lighting shader gives brightness = 1 - 2 * shadow / 255
  // (for shadow <= 127). So "at least this bright" = "shadow at most this byte". A floor of 0 means
  // "leave it": 255 caps nothing.
  function shadowByteFor(light) { return light > 0 ? Math.round(255 * (1 - light) / 2) : 255; }
  // Cap the visible shadow-map window: solid ground (material 100..251) by rRock, the rest by rOpen.
  function lightFloors(shadow, win, n, rOpen, rRock) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const a = win[i * 4 + 3], lim = a >= 100 && a < 252 ? rRock : rOpen;
      if (shadow[i] > lim) { shadow[i] = lim; changed++; }
    }
    return changed;
  }

  // Lamp lights (0.6.0 light buffer): instances of [x, y, size, intensity, r, g, b], x and y in
  // screen px. Only lights for which pick(x, y) is true turn white; white keeps the strongest
  // channel, so a lamp stays as bright as its main colour.
  function whitenLights(data, count, stride, pick) {
    for (let i = 0, o = 4; i < count; i++, o += stride) {
      if (!pick(data[o - 4], data[o - 3])) continue;
      const v = Math.max(data[o], data[o + 1], data[o + 2]);
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  }

  function install(sk) {
    if (installedOn === sk.api) return;
    installedOn = sk.api;
    sk.api.events.on("frame:update", () => { if (current) current.onUpdate(); });
    sk.api.events.on("frame:render", () => { if (current) current.onRender(); });
  }

  function internals(st) {
    const pixi = st && st.session && st.session.rendering && st.session.rendering.pixi, missing = [];
    const need = (ok, name) => { if (!ok) missing.push(name); };
    need(pixi && pixi.app && pixi.app.renderer && pixi.app.renderer.gl && pixi.app.renderer.on, "pixi renderer");
    need(pixi && pixi.foregroundSprite, "lighting sprite");
    need(pixi && pixi.colorBuffer && pixi.colorTexture && pixi.tilemapSize, "map colour window");
    need(pixi && pixi.filter && pixi.filter.uniforms, "lighting filter");
    need(st && st.shared && st.shared.mapData && st.shared.mapData.data, "map data");
    need(st && st.shared && st.shared.sim && st.shared.sim.cellIds, "cell ids");
    need(st && st.session && st.session.camera, "camera");
    need(st && st.store && st.store.world && st.store.world.size, "world size");
    return { pixi, missing };
  }

  // Which terrain types are fog, and what each one hides.
  function xrayTables(sk) {
    const st = sk.state, api = sk.api, enums = sk.enums || {};
    const CT = enums.CellType || {}, ET = enums.ElementType || {};
    const FOG_WATER = CT.FogWater !== undefined ? CT.FogWater : 6, FOG_LAVA = CT.FogLava !== undefined ? CT.FogLava : 13;
    const WATER = ET.Water !== undefined ? ET.Water : 3, LAVA = ET.Lava !== undefined ? ET.Lava : 19;
    const kinds = new Uint8Array(1001), replacements = [], byElement = new Map(), fogTypes = [];
    const scheme = st.session && st.session.colors && st.session.colors.scheme && st.session.colors.scheme.element;
    const repFor = (el) => {
      if (byElement.has(el)) return byElement.get(el);
      let variants = scheme && scheme[el] && Array.isArray(scheme[el].variants) ? scheme[el].variants.filter((v) => v && v.length >= 3) : [];
      if (!variants.length) {
        let meta = null; try { const d = api.elements.getDefinitionByType(el); meta = d && d.metaColor; } catch (e) {}
        variants = [meta != null ? [(meta >> 16) & 255, (meta >> 8) & 255, meta & 255, 255] : [255, 0, 255, 255]];
      }
      const i = replacements.length;
      replacements.push({ element: el, material: el === WATER ? WATER_MATERIAL : DEFAULT_ELEMENT_MATERIAL, variants });
      byElement.set(el, i);
      return i;
    };
    for (let t = 1; t <= 1000; t++) {
      let def = null; try { def = api.terrains.getDefinitionByType(t); } catch (e) {}
      if (!def || !def.fog) continue;
      const el = t === FOG_WATER ? WATER : t === FOG_LAVA ? LAVA : def.fogElementType;
      kinds[t] = el === undefined || el === null ? 1 : 2 + repFor(el);
      fogTypes.push(t);
    }
    return { kinds, replacements, fogTypes };
  }

  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
  }

  // Dimensions for the options panel (cheap except the world scan, which the caller caches).
  function describe(sk, L, cfg, scan) {
    const st = sk.state, W = st.store.world.size.width, H = st.store.world.size.height, C = L.CELL;
    const gl = st.session.rendering.pixi.app.renderer.gl;
    const k = cfg.scale;
    let region;
    if (cfg.region) { // cells; Shift+F7 uses this for the area around the camera
      const r = cfg.region, cl = (v, max) => Math.max(0, Math.min(max, Math.round(v)));
      region = { x0: cl(r.x0, W) * C, y0: cl(r.y0, H) * C, x1: cl(r.x1, W) * C, y1: cl(r.y1, H) * C };
      if (region.x1 <= region.x0 || region.y1 <= region.y0) throw new Error("Empty capture region");
    } else {
      const y0 = cfg.trimSky && scan ? Math.max(0, scan.topRow - TRIM_PAD_CELLS) * C : 0;
      region = { x0: 0, y0, x1: W * C, y1: H * C };
    }
    const plan = L.planTiles(Object.assign({}, region, { worldW: W * C, worldH: H * C, frameW: gl.drawingBufferWidth, frameH: gl.drawingBufferHeight, margin: MARGIN }));
    return { W, H, region, k, outW: (region.x1 - region.x0) / k, outH: (region.y1 - region.y0) / k, plan, frameW: gl.drawingBufferWidth, frameH: gl.drawingBufferHeight };
  }

  // io: { openEncoder(info) -> Promise<{ addStrip(strip, w, h) -> Promise<Uint8Array|undefined>, finish() -> Promise<number>, abort() }>,
  //       onProgress(p), isCancelled(), log(o) }
  async function run(sk, L, cfg, io) {
    const st = sk.state, { pixi, missing } = internals(st);
    if (missing.length) throw new Error("Game internals not found (" + missing.join(", ") + "). This mod targets Sandustry 0.5.6 and 0.6.0.");
    if (st.session.paused) throw new Error("The game is paused. Close the menu, then capture.");
    const zoom = (st.session.view && st.session.view.zoom) || 1;
    if (zoom !== 1) throw new Error("Zoom must be 1x (turn off cinematic zoom-out).");
    if (current) throw new Error("A capture is already running.");
    install(sk);

    const t0 = performance.now(), C = L.CELL;
    const renderer = pixi.app.renderer, gl = renderer.gl;
    const fw = gl.drawingBufferWidth, fh = gl.drawingBufferHeight;
    const W = st.store.world.size.width, H = st.store.world.size.height, md = st.shared.mapData;
    const sim = st.shared.sim, damagedTypes = sim.damagedGround && sim.damagedGround.type;
    const manager = st.environment && st.environment.multithreading && st.environment.multithreading.simulation && st.environment.multithreading.simulation.manager;
    const ctxAttr = (gl.getContextAttributes && gl.getContextAttributes()) || {};
    const bgContainer = pixi.mountainsSprite && pixi.mountainsSprite.parent && pixi.mountainsSprite.parent.parent;
    const player = pixi.sprites && pixi.sprites.player;
    const saved = {
      override: st.session.overrideCamera, camX: st.session.camera.x, camY: st.session.camera.y,
      fg: pixi.foregroundSprite.visible, bg: bgContainer ? bgContainer.visible : null,
      player: player && player.container ? player.container.visible : null,
      trail: player && player.trailContainer ? player.trailContainer.visible : null,
    };
    // Tool previews (grabber box, build ghost) follow the mouse; park it off the map while
    // capturing. The 2D overlay also draws structure parts (heat cannon nozzles), so it stays.
    const mouse = st.session.input && st.session.input.mouse;
    const mouseAt = (m) => m && m.position && m.worldPosition && m.cellPosition
      ? [m.position.x, m.position.y, m.worldPosition.x, m.worldPosition.y, m.cellPosition.x, m.cellPosition.y] : null;
    const setMouse = (m, v) => { [m.position.x, m.position.y, m.worldPosition.x, m.worldPosition.y, m.cellPosition.x, m.cellPosition.y] = v; };
    const savedMouse = mouseAt(mouse), PARKED = [-1e5, -1e5, -1e5, -1e5, -25000, -25000];
    const timeFrozen = st.store.meta.time;
    const uFilterTime = pixi.filter.uniforms.time;
    const uOutlineTime = pixi.outlineElementsFilter && pixi.outlineElementsFilter.uniforms ? pixi.outlineElementsFilter.uniforms.time : undefined;
    const xray = cfg.xray ? xrayTables(sk) : null;
    // Light floors (0..1): minimum brightness for open space (anything that isn't solid ground)
    // and for solid ground. Brighter spots keep the game's own lighting.
    const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
    const legacyFull = cfg.lighting === "fullbright";
    const floorOpen = legacyFull ? 1 : clamp01(cfg.floorOpen), floorRock = legacyFull ? 1 : clamp01(cfg.floorRock);
    const fullbright = floorOpen >= 1 && floorRock >= 1;
    // Solid ground keeps the game's shadow map: fully shadowed rock (255) takes the shader's flat
    // branch (no lamp light, brightness = minLightAmount), which is the crisp black outline. So rock
    // gets its floor through minLightAmount, and only open space is capped in the shadow map.
    const floors = !fullbright && floorOpen > floorRock && !!(pixi.shadowMapTilemap && pixi.shadowMapTexture);
    const rOpen = shadowByteFor(floorOpen), rRock = 255;
    const xwin = xray || floors ? new Uint8Array(pixi.colorBuffer.length) : null, noFog = new Uint8Array(1001);
    // White lamps: only the player's Light structures (4 x 4 cells, light at the centre); glowing
    // ores and other natural lights keep their colour. The game fills the light batches and draws
    // them into the light textures before frame:render, so the batches are recoloured there and
    // those textures drawn again.
    const lampCells = new Set();
    const structs = sk.engine && sk.engine.api && sk.engine.api.structures; // engine API (takes the state), not sk.api
    if (cfg.whiteLights && structs && structs.forEachOfType) {
      const LIGHT = sk.enums && sk.enums.StructureType && sk.enums.StructureType.Light !== undefined ? sk.enums.StructureType.Light : "Light";
      structs.forEachOfType(st, LIGHT, (s) => {
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) lampCells.add((s.x + dx) * 65536 + s.y + dy);
      });
    }
    const lightPasses = lampCells.size && pixi.lightBuffer
      ? [pixi.lightBuffer.clamped, pixi.lightBuffer.unclamped].filter((p) => p && p.batch && p.instanceBuffer && p.geometry && p.targets)
      : [];
    const isLamp = (x, y) => lampCells.has(Math.floor((x + st.session.camera.x) / C) * 65536 + Math.floor((y + st.session.camera.y) / C));
    const whiteLights = () => {
      for (const pass of lightPasses) {
        const b = pass.batch, attr = pass.geometry.attributes && pass.geometry.attributes.aLight;
        const stride = attr && attr.stride ? attr.stride / 4 : 7;
        if (!b.count || pass.instanceBuffer.data !== b.data) continue;
        whitenLights(b.data, b.count, stride, isLamp);
        pass.instanceBuffer.update(b.count * stride * 4);
        pass.geometry.instanceCount = b.count;
        for (const t of pass.targets) renderer.render({ container: t.root, target: t.texture, clear: true, clearColor: [0, 0, 0, 0] });
      }
    };

    let simPaused = false;
    if (manager && typeof manager.postMessage === "function") { manager.postMessage([SIM_SET_PAUSED, true]); simPaused = true; }

    const scan = L.scanWorld(md.data, st.shared.wallData && st.shared.wallData.data, W, H);
    const info = describe(sk, L, cfg, scan);
    const { region, plan, k, outW, outH } = info;
    const mode = cfg.background === "filled" ? "filled" : "transparent";
    let bg = null;
    if (mode === "filled") {
      // The gradient reaches the horizon colour at the median ground line.
      const vals = [];
      for (let ox = 0; ox < outW; ox++) {
        const cx = Math.min(W - 1, Math.floor((region.x0 + ox * k) / C)), s = scan.surface[cx];
        if (s < H) vals.push(Math.round((s * C - region.y0) / k));
      }
      vals.sort((a, b) => a - b);
      bg = { sky0: SKY_TOP, sky1: SKY_HORIZON, skyEnd: vals.length ? vals[vals.length >> 1] : outH };
    }

    const stats = { tiles: plan.count, frames: 0, xrayCells: 0, litCells: 0, camRetries: 0 };
    io.log({ start: { cfg, world: [W, H], frame: [fw, fh], resolution: [st.session.resolution.width, st.session.resolution.height],
      region, out: [outW, outH], tiles: plan.count, step: [plan.sx, plan.sy], premultipliedAlpha: ctxAttr.premultipliedAlpha,
      simPaused, fogTypes: xray ? xray.fogTypes : null, xrayElements: xray ? xray.replacements.map((r) => r.element) : null } });

    // ---- per-frame hooks ----
    const frameBuf = new Uint8Array(fw * fh * 4);
    let waiter = null, lastFrameAt = performance.now();
    const job = {
      onUpdate() { st.store.meta.time = timeFrozen; if (savedMouse) setMouse(mouse, PARKED); },
      onRender() {
        if (cfg.hidePlayer && player) {
          if (player.container) player.container.visible = false;
          if (player.trailContainer) player.trailContainer.visible = false;
        }
        if (pixi.edgeMist && pixi.edgeMist.sprite) pixi.edgeMist.sprite.renderable = false;
        pixi.foregroundSprite.visible = !fullbright;
        if (bgContainer) bgContainer.visible = false;
        pixi.filter.uniforms.lightPosition = [-1e6, -1e6]; // the player's lamp sits at screen centre
        pixi.filter.uniforms.uDisableRaycastStepping = false; // "disable shadows" would skip the shadow map
        pixi.filter.uniforms.minLightAmount = floorRock;      // the game resets it to 0 every update
        if (uFilterTime !== undefined) pixi.filter.uniforms.time = uFilterTime;
        if (uOutlineTime !== undefined) pixi.outlineElementsFilter.uniforms.time = uOutlineTime;
        if (lightPasses.length) whiteLights();
        if (xwin) {
          const ox = Math.floor(st.session.camera.x / C), oy = Math.floor(st.session.camera.y / C), ts = pixi.tilemapSize;
          const n = L.xrayWindow(xwin, md.data, sim.cellIds, damagedTypes, md.width, md.height, ox, oy, ts.width, ts.height, xray ? xray.kinds : noFog, xray ? xray.replacements : []);
          if (xray && n > 0) { pixi.colorBuffer.set(xwin); pixi.colorTexture.update(); stats.xrayCells += n; }
          if (floors) { stats.litCells += lightFloors(pixi.shadowMapTilemap, xwin, ts.width * ts.height, rOpen, rRock); pixi.shadowMapTexture.update(); }
        }
      },
    };
    // 0.5.6 (Pixi 7) emits one postrender event per frame. 0.6.0 (Pixi 8) has no such event: it
    // calls the postrender runner after every render pass (three a frame, two into textures), so
    // only the pass drawn to the screen counts.
    const runner = renderer.runners && renderer.runners.postrender;
    const offscreen = () => { const t = renderer.renderTarget && renderer.renderTarget.renderTarget; return !!t && t.isRoot === false; };
    const hook = { postrender: () => { if (!offscreen()) onPostRender(); } };
    const onPostRender = () => {
      lastFrameAt = performance.now();
      if (!waiter) return;
      const w = waiter; waiter = null;
      try {
        let fb = null;
        if (w.read) {
          fb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
          if (fb) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, fw, fh, gl.RGBA, gl.UNSIGNED_BYTE, frameBuf);
          if (fb) gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        }
        stats.frames++;
        w.resolve({ camX: st.session.camera.x, camY: st.session.camera.y, read: w.read, boundFb: !!fb });
      } catch (e) { w.reject(e); }
    };
    // Resolves after the next drawn frame; with read = true the frame is copied into frameBuf.
    const frame = (read) => new Promise((resolve, reject) => {
      const me = { resolve, reject, read };
      waiter = me;
      const check = () => {
        if (waiter !== me) return;
        if (performance.now() - lastFrameAt > STALL_MS) { waiter = null; reject(new Error("The game stopped rendering (paused or minimised?).")); return; }
        setTimeout(check, 500);
      };
      setTimeout(check, 500);
    });
    const setCam = (x, y) => {
      st.session.overrideCamera = { x, y };
      st.session.lerpCamera = false;
      st.session.camera.x = x; st.session.camera.y = y;
    };
    const cancelled = () => { if (io.isCancelled()) { const e = new Error("Cancelled"); e.cancelled = true; throw e; } };

    current = job;
    if (runner) runner.add(hook); else renderer.on("postrender", onPostRender);
    let encoder = null, pending = null, warnedFb = false;
    try {
      encoder = await io.openEncoder({ width: outW, height: outH, k, mode, bg });
      const stripW = region.x1 - region.x0, pool = [];
      const acquire = () => pool.pop() || new Uint8Array(stripW * plan.sy * 4);
      let done = 0;
      const captureStart = performance.now();
      let encodeWait = 0;
      for (const row of plan.rows) {
        const strip = acquire();
        for (const t of row.tiles) {
          setCam(t.camX, t.camY);
          let n = 0, wrongCam = 0;
          for (;;) {
            cancelled();
            const f = await frame(n >= SETTLE_FRAMES - 1);
            if (f.boundFb && !warnedFb) { warnedFb = true; io.log({ note: "a framebuffer was bound at postrender; read from the screen anyway" }); }
            if (f.camX !== t.camX || f.camY !== t.camY) {
              stats.camRetries++;
              if (++wrongCam > 4) throw new Error(`Camera did not move (wanted ${t.camX},${t.camY}, got ${f.camX},${f.camY}).`);
              setCam(t.camX, t.camY);
              n = 0;
              continue;
            }
            if (++n >= SETTLE_FRAMES && f.read) break;
          }
          const off = L.tileOffset(t, t.camX, t.camY, fw, fh);
          if (!off) throw new Error("Tile outside its frame: " + JSON.stringify(t));
          L.copyTileToStrip(frameBuf, fw, fh, off.fx, off.fy, t.w, t.h, strip, stripW, t.x - region.x0);
          io.onProgress({ phase: "capture", done: ++done, total: plan.count });
        }
        if (pending) { const w0 = performance.now(); const back = await pending; encodeWait += performance.now() - w0; if (back && back.buffer && back.buffer.byteLength) pool.push(back); }
        pending = encoder.addStrip(strip, stripW, row.h);
      }
      stats.captureMs = Math.round(performance.now() - captureStart);
      // Capture is over: give the game back before the encoder finishes.
      restore();
      io.onProgress({ phase: "encode" });
      const w0 = performance.now();
      if (pending) await pending;
      pending = null;
      const bytes = await encoder.finish();
      encodeWait += performance.now() - w0;
      stats.encodeWaitMs = Math.round(encodeWait);
      stats.totalMs = Math.round(performance.now() - t0);
      const result = { outW, outH, bytes, stats };
      io.log({ done: result });
      return result;
    } catch (e) {
      if (encoder) { try { await encoder.abort(); } catch (e2) {} }
      throw e;
    } finally {
      restore();
    }

    function restore() {
      if (current !== job) return;
      current = null;
      try { if (runner) runner.remove(hook); else renderer.off("postrender", onPostRender); } catch (e) {}
      st.session.overrideCamera = saved.override || false;
      st.session.lerpCamera = false;
      if (!saved.override) { st.session.camera.x = saved.camX; st.session.camera.y = saved.camY; }
      pixi.foregroundSprite.visible = saved.fg;
      if (bgContainer && saved.bg !== null) bgContainer.visible = saved.bg;
      if (player && player.container && saved.player !== null) player.container.visible = saved.player;
      if (player && player.trailContainer && saved.trail !== null) player.trailContainer.visible = saved.trail;
      if (savedMouse) setMouse(mouse, savedMouse);
      if (simPaused && !st.session.paused) { try { manager.postMessage([SIM_SET_PAUSED, false]); } catch (e) {} }
      if (waiter) { const w = waiter; waiter = null; w.reject(new Error("Capture stopped")); }
    }
  }

  return { run, describe, internals, xrayTables, stamp, shadowByteFor, lightFloors, whitenLights, MARGIN, TRIM_PAD_CELLS };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CartoCapture;
