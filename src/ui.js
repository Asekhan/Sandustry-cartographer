// UI, saving and encoder setup. CartoLogic, CartoCapture, LOGIC_SRC and WORKER_SRC come
// from the build (tools/build.cjs).
const api = sandkit.api;
const h = sandkit.react.createElement;
const TAG = "cartographer", HOTKEY = "F7", STORE_KEY = "cartographer.options.v4";
// The two looks. Floors are minimum brightness for open space (caves, tunnels, buildings) and for
// solid ground; 0 = exactly the game's lighting.
const LOOKS = {
  explorer: { floorOpen: 0.3, floorRock: 0.2, xray: true },
  game: { floorOpen: 0, floorRock: 0, xray: false },
};
const DEFAULTS = { look: "explorer", area: "map", background: "filled", scale: 1, hidePlayer: true, trimSky: true, whiteLights: false };
const SCALES = [[1, "Full", "4 px per cell"], [2, "Half", "2 px per cell"], [4, "Small", "1 px per cell"]];
// Areas centred on the view, in cells (x 4 px at full size).
const AREA_CELLS = { large: [1488, 1080], local: [496, 360] };
const AREAS = [["map", "Whole map"], ["large", "Large area"], ["local", "Around you"]];

const log = (o) => {
  const s = typeof o === "string" ? o : JSON.stringify(o);
  try { window.electron.log("info", TAG, s); } catch (e) {}
  try { console.log("[" + TAG + "]", s); } catch (e) {}
};
const toast = (msg, ms) => { try { api.ui.toast(msg, { duration: ms || 6000 }); } catch (e) {} };
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const mb = (b) => b < 1048576 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + " MB";

let opts = Object.assign({}, DEFAULTS);
try { const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); if (s) opts = Object.assign(opts, s); } catch (e) {}
if (!LOOKS[opts.look]) opts.look = DEFAULTS.look;
if (opts.area !== "map" && !AREA_CELLS[opts.area]) opts.area = "map";
const saveOpts = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(opts)); } catch (e) {} };
// Area around the centre of the view, shifted to stay inside the world.
function areaAroundCamera(kind) {
  const st = sandkit.state, s = st.session, W = st.store.world.size.width, H = st.store.world.size.height;
  const [w, hh] = AREA_CELLS[kind];
  const cx = Math.floor((s.camera.x + s.resolution.width / 2) / 4), cy = Math.floor((s.camera.y + s.resolution.height / 2) / 4);
  const x0 = Math.max(0, Math.min(W - w, cx - w / 2)), y0 = Math.max(0, Math.min(H - hh, cy - hh / 2));
  return { x0, y0, x1: Math.min(W, x0 + w), y1: Math.min(H, y0 + hh) };
}
const captureConfig = (o) => Object.assign({}, o, LOOKS[o.look] || LOOKS.explorer, AREA_CELLS[o.area] ? { region: areaAroundCamera(o.area) } : {});

let panelOpen = false, running = false, cancelFlag = false, lastMsg = null, refreshUi = () => {};
let scanCache = null;

function inGame() {
  const st = sandkit.state, Scene = sandkit.enums && sandkit.enums.Scene;
  if (!st || !st.store || !st.store.scene) return false;
  if (Scene && Scene.Game !== undefined) return st.store.scene.active === Scene.Game;
  return !!(st.session && st.session.rendering && st.session.rendering.pixi);
}
function worldScan() {
  const st = sandkit.state, now = performance.now();
  if (scanCache && now - scanCache.at < 15000 && scanCache.size === st.store.world.size) return scanCache.scan;
  const W = st.store.world.size.width, H = st.store.world.size.height;
  const scan = CartoLogic.scanWorld(st.shared.mapData.data, st.shared.wallData && st.shared.wallData.data, W, H);
  scanCache = { at: now, size: st.store.world.size, scan };
  return scan;
}

// ---------- styles (one <style> tag; the panel and overlay use these classes) ----------
const CSS = `
.carto-panel{position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:99000;width:560px;box-sizing:border-box;color:#e9eef6;
 background:linear-gradient(180deg,rgba(25,31,46,.97),rgba(14,18,28,.97));border:1px solid rgba(255,204,51,.22);border-radius:14px;
 box-shadow:0 22px 60px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05);font:13px/1.4 "Noto Sans",system-ui,"Segoe UI",sans-serif;padding:18px 20px 14px;user-select:none}
.carto-panel *{box-sizing:border-box}
.carto-head{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.carto-title{font-size:19px;font-weight:800;letter-spacing:.4px;line-height:1.1}
.carto-sub{color:#8a94a8;font-size:12px}
.carto-x{margin-left:auto;width:30px;height:30px;border-radius:8px;border:1px solid #2c3446;background:#121826;color:#8a94a8;font-size:18px;line-height:1;cursor:pointer}
.carto-x:hover{color:#fff;border-color:#4a5672}
.carto-label{text-transform:uppercase;font-size:10.5px;font-weight:700;letter-spacing:1.4px;color:#76819a;margin:14px 0 7px}
.carto-looks{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.carto-look{display:flex;flex-direction:column;justify-content:flex-start;border:1px solid #2a3243;border-radius:11px;padding:8px 8px 10px;background:#121825;cursor:pointer;text-align:left;color:inherit;font:inherit;transition:border-color .12s,box-shadow .12s}
.carto-look:hover{border-color:#47536d}
.carto-look.on{border-color:#ffcc33;box-shadow:inset 0 0 0 1px #ffcc33,0 0 22px rgba(255,204,51,.12)}
.carto-look svg{display:block;width:100%;height:70px;border-radius:7px;margin-bottom:8px}
.carto-look b{display:block;font-size:14px;margin:0 2px}
.carto-look span{display:block;color:#8a94a8;font-size:12px;margin:1px 2px 0}
.carto-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px}
.carto-seg{display:inline-flex;background:#0d121c;border:1px solid #2a3243;border-radius:9px;padding:3px;gap:3px}
.carto-seg button{border:0;background:transparent;color:#a9b2c3;padding:6px 12px;border-radius:7px;cursor:pointer;font:inherit;font-weight:600}
.carto-seg button:hover:not(.on){color:#fff}
.carto-seg button.on{background:#2b3652;color:#fff;box-shadow:inset 0 0 0 1px #3d4b6e}
.carto-checks{display:flex;gap:20px;margin-top:12px}
.carto-check{display:inline-flex;align-items:center;gap:7px;cursor:pointer;color:#c7cfdc}
.carto-check input{accent-color:#ffcc33;width:15px;height:15px;margin:0;cursor:pointer}
.carto-foot{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:16px;padding-top:14px;border-top:1px solid #222a3a}
.carto-est b{display:block;color:#fff;font-size:15px}
.carto-est span{color:#76819a;font-size:12px}
.carto-go{background:linear-gradient(180deg,#ffd84d,#f0b10f);color:#1d1504;font:inherit;font-weight:800;font-size:15px;border:0;border-radius:10px;padding:11px 26px;cursor:pointer;box-shadow:0 6px 20px rgba(240,177,15,.28)}
.carto-go:hover{filter:brightness(1.07)}
.carto-msg{margin-top:10px;font-size:12.5px}
.carto-msg.ok{color:#8fe08a}.carto-msg.err{color:#ffa37a}
.carto-hint{color:#5f6a7e;font-size:11px;margin-top:10px}
.carto-hint kbd,.carto-card kbd{font:inherit;font-size:10.5px;color:#c7cfdc;background:#1b2232;border:1px solid #303a50;border-bottom-width:2px;border-radius:4px;padding:0 5px}
.carto-hud{width:46px;height:46px;display:grid;place-items:center;padding:0;border-radius:11px;cursor:pointer;
 background:rgba(14,18,28,.82);border:1px solid rgba(255,204,51,.35);box-shadow:0 4px 14px rgba(0,0,0,.35);transition:border-color .12s,transform .12s}
.carto-hud:hover{border-color:#ffcc33;transform:translateY(-1px)}
.carto-hud.on{border-color:#ffcc33;box-shadow:0 0 0 1px #ffcc33,0 4px 14px rgba(0,0,0,.35)}
.carto-hud svg{display:block}
.carto-ov{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;color:#e9eef6;
 background:radial-gradient(ellipse at center,rgba(16,21,33,.9),rgba(5,7,12,.97));font:14px/1.4 "Noto Sans",system-ui,"Segoe UI",sans-serif}
.carto-card{width:440px;text-align:center}
.carto-card .carto-title{margin:10px 0 4px}
.carto-phase{color:#a9b2c3;margin-bottom:16px}
.carto-bar{height:10px;background:#161c2a;border:1px solid #2a3245;border-radius:6px;overflow:hidden}
.carto-fill{height:100%;width:0;background:linear-gradient(90deg,#f0b10f,#ffd84d);transition:width .15s}
.carto-meta{display:flex;justify-content:space-between;color:#76819a;font-size:12px;margin-top:7px}
.carto-cancel{margin-top:22px;background:transparent;color:#a9b2c3;border:1px solid #2f384c;border-radius:8px;padding:7px 18px;font:inherit;cursor:pointer}
.carto-cancel:hover{color:#fff;border-color:#55627f}
`;
try {
  if (!document.getElementById("cartographer-style")) {
    const style = document.createElement("style");
    style.id = "cartographer-style";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
} catch (e) {}

// ---------- artwork (inline SVG) ----------
const svg = (props, ...kids) => h("svg", Object.assign({ xmlns: "http://www.w3.org/2000/svg" }, props), ...kids);
const r = (x, y, w, hh, fill, extra) => h("rect", Object.assign({ x, y, width: w, height: hh, fill }, extra || {}));
const p = (d, fill, extra) => h("path", Object.assign({ d, fill }, extra || {}));
function Logo(props) {
  const size = (props && props.size) || 38;
  return svg({ viewBox: "0 0 40 40", width: size, height: size },
    r(0, 0, 40, 40, "#1a2133", { rx: 9 }),
    p("M8 11l8-3 8 3 8-3v21l-8 3-8-3-8 3z", "#f0b10f"),
    p("M16 8v21l8 3V11z", "#ffd84d"),
    p("M11 22c3-1 4-5 7-5s4 4 7 3 3-4 5-4", "none", { stroke: "#1d1504", strokeWidth: 1.6, strokeLinecap: "round", strokeDasharray: "2 2.2" }),
    h("circle", { cx: 29, cy: 15, r: 2.2, fill: "#d9412b" }));
}
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="46" height="46"><rect width="40" height="40" rx="9" fill="#1a2133"/>' +
  '<path d="M8 11l8-3 8 3 8-3v21l-8 3-8-3-8 3z" fill="#f0b10f"/><path d="M16 8v21l8 3V11z" fill="#ffd84d"/>' +
  '<path d="M11 22c3-1 4-5 7-5s4 4 7 3 3-4 5-4" fill="none" stroke="#1d1504" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="2 2.2"/>' +
  '<circle cx="29" cy="15" r="2.2" fill="#d9412b"/></svg>';
// Little stylised world slices for the two looks.
const GROUND = "M0 26 C14 22 22 28 34 24 S58 20 70 25 S98 27 120 23 V70 H0Z";
const sky = (id) => [h("defs", { key: "d" }, h("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, h("stop", { offset: 0, stopColor: "#2a6fb0" }), h("stop", { offset: 1, stopColor: "#9fd4f0" }))),
  r(0, 0, 120, 70, `url(#${id})`, { key: "s" })];
function ThumbExplorer() {
  return svg({ viewBox: "0 0 120 70", preserveAspectRatio: "none" },
    ...sky("carto-sky-a"),
    p(GROUND, "#4a3a28"),
    p("M0 52 C20 48 40 56 62 50 S100 48 120 52 V70 H0Z", "#3c3d40"),
    p("M18 36 c6-5 16-4 20 1 s-4 9-11 8 -13-4-9-9z", "#6e6a3c"),
    p("M70 40 c7-4 15-2 17 3 s-6 7-12 6 -9-5-5-9z", "#2f78c8"),
    p("M92 55 c5-3 11-2 12 2 s-5 5-9 4 -6-3-3-6z", "#d4471d"),
    p("M40 33 h34 v4 h-30 v10 h-4z", "#8c8452"),
    r(52, 14, 3, 12, "#f0b10f"), r(64, 10, 3, 16, "#f0b10f"), r(50, 12, 20, 3, "#f0b10f"));
}
function ThumbGame() {
  return svg({ viewBox: "0 0 120 70", preserveAspectRatio: "none" },
    ...sky("carto-sky-b"),
    p(GROUND, "#07090d"),
    p("M40 33 h34 v4 h-30 v10 h-4z", "#8c8452"),
    h("ellipse", { cx: 58, cy: 36, rx: 22, ry: 9, fill: "#f7d27a", opacity: 0.18 }),
    h("ellipse", { cx: 42, cy: 44, rx: 7, ry: 5, fill: "#f7d27a", opacity: 0.16 }),
    r(52, 14, 3, 12, "#f0b10f"), r(64, 10, 3, 16, "#f0b10f"), r(50, 12, 20, 3, "#f0b10f"));
}

// ---------- saving ----------
async function openSink(name) {
  if (typeof window.showSaveFilePicker === "function") {
    const t0 = performance.now();
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "PNG image", accept: { "image/png": [".png"] } }] });
      const w = await handle.createWritable();
      return { kind: "file", name: handle.name, write: (b) => w.write(b), close: () => w.close(), abort: () => w.abort().catch(() => {}) };
    } catch (e) {
      const quick = performance.now() - t0 < 400;
      log({ savePicker: String(e && e.name), message: String(e && e.message), quick });
      if (e && e.name === "AbortError" && !quick) return null; // the player closed the dialog
    }
  }
  const parts = [];
  return {
    kind: "download", name,
    write: (b) => { parts.push(new Blob([b])); },
    close: () => {
      const url = URL.createObjectURL(new Blob(parts, { type: "image/png" })), a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    },
    abort: () => { parts.length = 0; },
  };
}

// ---------- encoders ----------
function workerEncoder(info, write) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      const url = URL.createObjectURL(new Blob([LOGIC_SRC + "\n" + WORKER_SRC], { type: "text/javascript" }));
      worker = new Worker(url);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { reject(e); return; }
    let writes = Promise.resolve(), nextId = 1, failed = null, onDone = null;
    const waits = new Map();
    const fail = (err) => {
      if (failed) return; failed = err;
      for (const w of waits.values()) w.reject(err);
      waits.clear();
      if (onDone) onDone.reject(err);
      try { worker.terminate(); } catch (e) {}
    };
    const timer = setTimeout(() => { fail(new Error("worker did not start")); reject(failed); }, 4000);
    worker.onerror = (e) => { const err = new Error("worker: " + ((e && e.message) || "failed")); clearTimeout(timer); fail(err); reject(err); };
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "ready") {
        clearTimeout(timer);
        resolve({
          kind: "worker",
          addStrip(strip, w, hh) {
            if (failed) return Promise.reject(failed);
            const id = nextId++;
            return new Promise((res, rej) => { waits.set(id, { resolve: res, reject: rej }); worker.postMessage({ type: "strip", id, buf: strip.buffer, w, h: hh }, [strip.buffer]); });
          },
          finish() {
            if (failed) return Promise.reject(failed);
            return new Promise((res, rej) => { onDone = { resolve: res, reject: rej }; worker.postMessage({ type: "finish" }); })
              .then(async (bytes) => { await writes; worker.terminate(); return bytes; });
          },
          async abort() { fail(new Error("aborted")); },
        });
      } else if (m.type === "chunk") {
        writes = writes.then(() => write(m.bytes));
        writes.catch((e) => fail(e));
      } else if (m.type === "stripDone") {
        const w = waits.get(m.id); waits.delete(m.id);
        if (w) writes.then(() => w.resolve(new Uint8Array(m.buf)), w.reject);
      } else if (m.type === "done") {
        if (onDone) onDone.resolve(m.bytes);
      } else if (m.type === "error") {
        fail(new Error("encoder: " + m.message));
      }
    };
    worker.postMessage({ type: "init", opts: info });
  });
}
function mainEncoder(info, write) {
  const enc = CartoLogic.createPngEncoder(info, write);
  return { kind: "main thread", async addStrip(s, w, hh) { await enc.addStrip(s, w, hh); return s; }, finish: () => enc.finish(), abort: () => enc.abort() };
}

// ---------- progress overlay (DOM: never part of the captured frames) ----------
let overlay = null, overlayT0 = 0;
function showOverlay(title) {
  overlay = document.createElement("div");
  overlay.className = "carto-ov";
  overlay.innerHTML = '<div class="carto-card">' + LOGO_SVG + '<div class="carto-title">Cartographer</div><div class="carto-phase" data-m></div>' +
    '<div class="carto-bar"><div class="carto-fill" data-b></div></div><div class="carto-meta"><span data-l></span><span data-r></span></div>' +
    '<button class="carto-cancel" data-c>Cancel <kbd>Esc</kbd></button></div>';
  overlay.querySelector("[data-m]").textContent = title;
  overlay.querySelector("[data-c]").onclick = () => { cancelFlag = true; };
  for (const ev of ["mousedown", "mouseup", "click", "pointerdown", "wheel", "contextmenu"]) overlay.addEventListener(ev, (e) => e.stopPropagation());
  document.body.appendChild(overlay);
  overlayT0 = performance.now();
}
function updateOverlay(pr) {
  if (!overlay) return;
  const q = (s) => overlay.querySelector(s), secs = Math.floor((performance.now() - overlayT0) / 1000);
  if (pr.phase === "capture") {
    q("[data-b]").style.width = (92 * pr.done / pr.total).toFixed(1) + "%";
    q("[data-l]").textContent = `Tile ${pr.done} of ${pr.total}`;
  } else {
    q("[data-m]").textContent = "Writing the PNG…";
    q("[data-b]").style.width = "97%";
    q("[data-l]").textContent = "Almost there";
  }
  q("[data-r]").textContent = secs + " s";
}
function hideOverlay() { if (overlay) { overlay.remove(); overlay = null; } }

// ---------- capture ----------
async function startCapture(override) {
  if (running) return;
  const cfg = Object.assign(captureConfig(opts), override || {});
  const name = `sandustry-map_${CartoCapture.stamp()}${cfg.region ? "_area" : ""}_${opts.look}.png`;
  let sink = null;
  try { sink = await openSink(name); } catch (e) { lastMsg = { err: true, text: "Could not open a save target: " + e.message }; refreshUi(); return; }
  if (!sink) { lastMsg = { err: true, text: "Save cancelled." }; refreshUi(); return; }
  running = true; cancelFlag = false; panelOpen = false; refreshUi();
  showOverlay(cfg.region ? "Snapshot of the area around you" : "Photographing the whole world");
  let encKind = "?";
  const t0 = performance.now();
  try {
    const result = await CartoCapture.run(sandkit, CartoLogic, cfg, {
      openEncoder: async (info) => {
        let enc;
        try { enc = await workerEncoder(info, sink.write); }
        catch (e) { log({ encoderFallback: String(e && e.message) }); enc = mainEncoder(info, sink.write); }
        encKind = enc.kind;
        return enc;
      },
      onProgress: updateOverlay,
      isCancelled: () => cancelFlag,
      log,
    });
    await sink.close();
    const secs = Math.max(1, Math.round((performance.now() - t0) / 1000));
    const text = `Saved ${fmt(result.outW)} × ${fmt(result.outH)} px · ${mb(result.bytes)} · ${secs} s` + (sink.kind === "file" ? ` → ${sink.name}` : "");
    lastMsg = { err: false, text };
    log({ saved: { sink: sink.kind, encoder: encKind, seconds: secs } });
    toast("Map saved: " + text, 8000);
  } catch (e) {
    try { await sink.abort(); } catch (e2) {}
    lastMsg = { err: true, text: e && e.cancelled ? "Capture cancelled." : "Capture failed: " + ((e && e.message) || e) };
    log({ error: String((e && e.stack) || e), sink: sink.kind, encoder: encKind });
    toast(lastMsg.text, 8000);
  } finally {
    running = false;
    hideOverlay();
    refreshUi();
  }
}

// ---------- panel ----------
function Panel() {
  const [, setTick] = sandkit.react.useState(0);
  sandkit.react.useEffect(() => { refreshUi = () => setTick((v) => v + 1); return () => { refreshUi = () => {}; }; }, []);
  if (!panelOpen || running || !inGame()) return null;
  let est = null, estErr = null;
  try { est = CartoCapture.describe(sandkit, CartoLogic, captureConfig(opts), opts.trimSky && opts.area === "map" ? worldScan() : null); } catch (e) { estErr = String(e.message || e); }
  const set = (patch) => { Object.assign(opts, patch); saveOpts(); refreshUi(); };
  const stop = (e) => e.stopPropagation();
  const look = (key, Thumb, title, text) => h("button", { className: "carto-look" + (opts.look === key ? " on" : ""), onClick: () => set({ look: key }) },
    h(Thumb), h("b", null, title), h("span", null, text));
  const seg = (items, key) => h("div", { className: "carto-seg" },
    ...items.map(([v, label, tip]) => h("button", { className: opts[key] === v ? "on" : "", title: tip || "", onClick: () => set({ [key]: v }) }, label)));
  const check = (key, label) => h("label", { className: "carto-check" },
    h("input", { type: "checkbox", checked: !!opts[key], onChange: (e) => set({ [key]: e.target.checked }) }), label);
  const mp = est ? est.outW * est.outH / 1e6 : 0;
  const scaleNote = (SCALES.find((s) => s[0] === opts.scale) || SCALES[0])[2];
  return h("div", { className: "carto-panel", onMouseDown: stop, onMouseUp: stop, onClick: stop, onPointerDown: stop, onWheel: stop, onContextMenu: stop },
    h("div", { className: "carto-head" },
      h(Logo),
      h("div", null, h("div", { className: "carto-title" }, "Cartographer"), h("div", { className: "carto-sub" }, "Save the whole world as one picture")),
      h("button", { className: "carto-x", title: "Close (" + HOTKEY + ")", onClick: () => { panelOpen = false; refreshUi(); } }, "×")),
    h("div", { className: "carto-label" }, "Look"),
    h("div", { className: "carto-looks" },
      look("explorer", ThumbExplorer, "Explorer", "Reveals caves and terrain."),
      look("game", ThumbGame, "Game", "As the game shows it.")),
    h("div", { className: "carto-label" }, "Area"), seg(AREAS, "area"),
    h("div", { className: "carto-grid" },
      h("div", null, h("div", { className: "carto-label" }, "Size"), seg(SCALES, "scale")),
      h("div", null, h("div", { className: "carto-label" }, "Background"), seg([["filled", "Sky"], ["transparent", "Transparent"]], "background"))),
    h("div", { className: "carto-checks" }, check("hidePlayer", "Hide player"), check("whiteLights", "White lamps"), opts.area === "map" ? check("trimSky", "Trim empty sky") : null),
    h("div", { className: "carto-foot" },
      h("div", { className: "carto-est" }, est
        ? [h("b", { key: "a" }, `${fmt(est.outW)} × ${fmt(est.outH)} px`), h("span", { key: "b" }, `${mp.toFixed(mp < 10 ? 1 : 0)} megapixels · ${scaleNote} · roughly ${Math.max(1, Math.round(mp * 0.2))} MB`)]
        : h("span", null, "Size unavailable: " + estErr)),
      h("button", { className: "carto-go", onClick: () => { startCapture(); } }, "Capture")),
    lastMsg ? h("div", { className: "carto-msg " + (lastMsg.err ? "err" : "ok") }, lastMsg.text) : null,
    h("div", { className: "carto-hint" },
      "Also opens with ", h("kbd", null, HOTKEY), "  ·  ", h("kbd", null, "Esc"), " cancels  ·  the world is never changed"));
}

// HUD button, under the game's menu button (top right).
function HudButton() {
  if (!inGame()) return null; // the region also exists on the main menu
  const stop = (e) => e.stopPropagation();
  return h("button", { className: "carto-hud", title: "Cartographer: save the map as a picture (" + HOTKEY + ")",
    onMouseDown: stop, onMouseUp: stop, onPointerDown: stop,
    onClick: (e) => { e.stopPropagation(); if (!running) { panelOpen = !panelOpen; refreshUi(); } } }, h(Logo, { size: 30 }));
}

window.addEventListener("keydown", (e) => {
  if (running && e.key === "Escape") { cancelFlag = true; e.stopPropagation(); e.preventDefault(); return; }
  if (panelOpen && e.key === "Escape") { panelOpen = false; refreshUi(); e.stopPropagation(); e.preventDefault(); return; }
  if (e.code === HOTKEY && !e.repeat && !e.shiftKey) {
    e.stopPropagation(); e.preventDefault();
    if (running || !inGame()) return;
    panelOpen = !panelOpen;
    refreshUi();
  }
}, true);

api.ui.inject("cartographer:panel", Panel);
try { api.ui.regions.mount("hud.topRight", "button", { render: () => h(HudButton), order: 50 }); }
catch (e) { log({ hudButton: String(e && e.message) }); }
// Console / test handle: cartographer.open(), cartographer.capture(), cartographer.options
window.cartographer = { open() { panelOpen = true; refreshUi(); }, capture: startCapture, cancel() { cancelFlag = true; }, get options() { return opts; }, LOOKS, Panel, HudButton };
log({ loaded: { hotkey: HOTKEY, version: VERSION } });
