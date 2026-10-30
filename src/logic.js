// Pure logic: no game, DOM or GL access. Bundled into the mod and the encoder worker,
// and loaded by the node tests (tests/*.test.cjs).
const CartoLogic = (() => {
  const CELL = 4; // world px per cell

  // ---------- tile plan ----------
  // Region and world are in world px. Each tile keeps an inner rect; the camera sits `margin`
  // px before it (clamped to the world) so lights and outlines near the inner edges are right.
  function planTiles(o) {
    const { x0, y0, x1, y1, worldW, worldH, frameW, frameH, margin } = o;
    const align = (v) => Math.floor(v / CELL) * CELL;
    const sx = align(Math.min(frameW - 2 * margin, x1 - x0));
    const sy = align(Math.min(frameH - 2 * margin, y1 - y0));
    if (sx <= 0 || sy <= 0) throw new Error("Frame too small for the margin");
    const camMaxX = Math.max(0, worldW - frameW), camMaxY = Math.max(0, worldH - frameH);
    const rows = [];
    for (let y = y0; y < y1; y += sy) {
      const h = Math.min(sy, y1 - y);
      const camY = Math.min(camMaxY, Math.max(0, y - margin));
      const tiles = [];
      for (let x = x0; x < x1; x += sx) {
        const w = Math.min(sx, x1 - x);
        const camX = Math.min(camMaxX, Math.max(0, x - margin));
        tiles.push({ x, y, w, h, camX, camY });
      }
      rows.push({ y, h, tiles });
    }
    return { sx, sy, rows, count: rows.reduce((n, r) => n + r.tiles.length, 0) };
  }

  // Inner rect position inside the captured frame; null if it does not fit.
  function tileOffset(t, camX, camY, frameW, frameH) {
    const fx = t.x - camX, fy = t.y - camY;
    if (fx < 0 || fy < 0 || fx + t.w > frameW || fy + t.h > frameH) return null;
    return { fx, fy };
  }

  // Copy a tile's inner rect out of a GL frame (bottom-up rows) into a top-down strip.
  function copyTileToStrip(frame, frameW, frameH, fx, fy, w, h, strip, stripW, dstX) {
    for (let r = 0; r < h; r++) {
      const src = ((frameH - 1 - (fy + r)) * frameW + fx) * 4;
      strip.set(frame.subarray(src, src + w * 4), (r * stripW + dstX) * 4);
    }
  }

  // ---------- world scan ----------
  // topRow: first row holding anything (cell or wall). surface[x]: first terrain row per column.
  function scanWorld(mapData, wallData, W, H) {
    let topRow = H;
    const surface = new Int32Array(W).fill(H);
    let left = W;
    for (let y = 0; y < H && left > 0; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const a = mapData[(row + x) * 4 + 3];
        if (topRow === H && (a !== 0 || (wallData && wallData[row + x] !== 0))) topRow = y;
        if (surface[x] === H && a >= 100 && a < 252) { surface[x] = y; left--; }
      }
    }
    return { topRow, surface };
  }

  // ---------- x-ray: fog cells drawn as what they hide ----------
  // kinds: Uint8Array(1001) by terrain type: 0 not fog, 1 hides empty, 2+i hides replacement i.
  // replacements[i] = { material, variants: [[r,g,b,a], ...] }.
  function hash2(x, y) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function fogKindOf(id, kinds, damagedTypes) {
    if (id >= 1 && id <= 1000) return kinds[id];
    if (id >= 1001 && id <= 1000000 && damagedTypes) { const t = damagedTypes[id - 1001]; return t >= 0 && t <= 1000 ? kinds[t] : 0; }
    return 0;
  }
  // Build the colour window the game uploads (tw x th cells at ox, oy), with fog replaced.
  function xrayWindow(out, mapData, cellIds, damagedTypes, W, H, ox, oy, tw, th, kinds, replacements) {
    out.fill(0);
    let patched = 0;
    for (let r = 0; r < th; r++) {
      const y = oy + r;
      if (y < 0 || y >= H) continue;
      const c0 = Math.max(0, ox), c1 = Math.min(W, ox + tw);
      if (c1 <= c0) continue;
      const src = (y * W + c0) * 4, dst = (r * tw + (c0 - ox)) * 4;
      out.set(mapData.subarray(src, src + (c1 - c0) * 4), dst);
      for (let x = c0; x < c1; x++) {
        const k = fogKindOf(cellIds[y * W + x], kinds, damagedTypes);
        if (k === 0) continue;
        const o = (r * tw + (x - ox)) * 4;
        patched++;
        if (k === 1) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
        const rep = replacements[k - 2];
        const v = rep.variants[hash2(x, y) % rep.variants.length];
        out[o] = v[0]; out[o + 1] = v[1]; out[o + 2] = v[2]; out[o + 3] = rep.material;
      }
    }
    return patched;
  }

  // ---------- pixels ----------
  function hashFrame(u8) {
    const n = u8.length >> 2, u32 = new Uint32Array(u8.buffer, u8.byteOffset, n);
    let h = 2166136261;
    for (let i = 0; i < n; i++) h = Math.imul(h ^ u32[i], 16777619);
    return h >>> 0;
  }
  // Box-average premultiplied RGBA by k (w, h multiples of k).
  function downscalePremul(src, w, h, k) {
    if (k === 1) return src;
    const ow = w / k, oh = h / k, out = new Uint8Array(ow * oh * 4), n = k * k, acc = new Uint32Array(ow * 4);
    for (let oy = 0; oy < oh; oy++) {
      acc.fill(0);
      for (let dy = 0; dy < k; dy++) {
        let s = ((oy * k + dy) * w) * 4;
        for (let ox = 0; ox < ow; ox++) {
          const a = ox * 4;
          for (let dx = 0; dx < k; dx++, s += 4) { acc[a] += src[s]; acc[a + 1] += src[s + 1]; acc[a + 2] += src[s + 2]; acc[a + 3] += src[s + 3]; }
        }
      }
      const d = oy * ow * 4, half = n >> 1;
      for (let i = 0; i < ow * 4; i++) out[d + i] = ((acc[i] + half) / n) | 0;
    }
    return out;
  }
  // Premultiplied -> straight alpha, in place.
  function unpremultiply(buf) {
    for (let i = 0; i < buf.length; i += 4) {
      const a = buf[i + 3];
      if (a === 255 || a === 0) { if (a === 0) buf[i] = buf[i + 1] = buf[i + 2] = 0; continue; }
      const f = 255 / a;
      buf[i] = Math.min(255, Math.round(buf[i] * f));
      buf[i + 1] = Math.min(255, Math.round(buf[i + 1] * f));
      buf[i + 2] = Math.min(255, Math.round(buf[i + 2] * f));
    }
    return buf;
  }
  // Premultiplied RGBA over a background -> RGB. surface: output row of the first terrain per
  // output column; above it the sky gradient (sky0 at row 0 -> sky1 at skyEnd), below it cave.
  function compositeRGB(src, w, h, outY0, bg) {
    const out = new Uint8Array(w * h * 3);
    const { surface, sky0, sky1, skyEnd, cave } = bg;
    for (let r = 0; r < h; r++) {
      const y = outY0 + r, t = skyEnd > 0 ? Math.min(1, y / skyEnd) : 1;
      const sr = sky0[0] + (sky1[0] - sky0[0]) * t, sg = sky0[1] + (sky1[1] - sky0[1]) * t, sb = sky0[2] + (sky1[2] - sky0[2]) * t;
      for (let x = 0; x < w; x++) {
        const s = (r * w + x) * 4, d = (r * w + x) * 3, a = src[s + 3];
        if (a === 255) { out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; continue; }
        const under = y >= surface[x];
        const br = under ? cave[0] : sr, bgc = under ? cave[1] : sg, bb = under ? cave[2] : sb, f = (255 - a) / 255;
        out[d] = Math.min(255, Math.round(src[s] + br * f));
        out[d + 1] = Math.min(255, Math.round(src[s + 1] + bgc * f));
        out[d + 2] = Math.min(255, Math.round(src[s + 2] + bb * f));
      }
    }
    return out;
  }

  // ---------- PNG ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes, crc = 0) {
    let c = ~crc;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return ~c >>> 0;
  }
  function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }
  function pngHead(width, height, channels) {
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width); dv.setUint32(4, height);
    ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), c = pngChunk("IHDR", ihdr);
    const out = new Uint8Array(sig.length + c.length); out.set(sig); out.set(c, sig.length);
    return out;
  }
  const pngEnd = () => pngChunk("IEND", new Uint8Array(0));

  // Filter rows (Sub or Up, whichever has the smaller absolute sum). prev: last row of the
  // previous call or null. Returns { data, last }.
  function filterRows(px, width, rows, bpp, prev) {
    const stride = width * bpp, out = new Uint8Array(rows * (stride + 1));
    for (let r = 0; r < rows; r++) {
      const cur = px.subarray(r * stride, (r + 1) * stride), o = r * (stride + 1);
      let sumSub = 0, sumUp = 0;
      for (let i = 0; i < stride; i++) {
        const s = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 255, u = (cur[i] - (prev ? prev[i] : 0)) & 255;
        sumSub += s < 128 ? s : 256 - s; sumUp += u < 128 ? u : 256 - u;
      }
      if (prev && sumUp <= sumSub) {
        out[o] = 2;
        for (let i = 0; i < stride; i++) out[o + 1 + i] = cur[i] - prev[i];
      } else {
        out[o] = 1;
        for (let i = 0; i < stride; i++) out[o + 1 + i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
      }
      prev = cur;
    }
    return { data: out, last: prev ? prev.slice() : null };
  }

  // Streaming PNG encoder over CompressionStream("deflate") (zlib format, which PNG needs).
  // emit(Uint8Array) receives the file in order; it may return a promise (backpressure).
  // Strips arrive as premultiplied RGBA at world scale (width srcW, height multiple of k).
  function createPngEncoder(opts, emit) {
    const { width, height, k, mode, bg } = opts;
    const channels = mode === "filled" ? 3 : 4;
    const cs = new CompressionStream("deflate"), writer = cs.writable.getWriter(), reader = cs.readable.getReader();
    const IDAT_TARGET = 1 << 20;
    let pending = [], pendingLen = 0, prev = null, rowsOut = 0, bytesOut = 0;
    const out = async (bytes) => { bytesOut += bytes.length; await emit(bytes); };
    const flushIdat = async () => {
      if (!pendingLen) return;
      const buf = new Uint8Array(pendingLen); let o = 0;
      for (const p of pending) { buf.set(p, o); o += p.length; }
      pending = []; pendingLen = 0;
      await out(pngChunk("IDAT", buf));
    };
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending.push(value); pendingLen += value.length;
        if (pendingLen >= IDAT_TARGET) await flushIdat();
      }
      await flushIdat();
    })();
    pump.catch(() => {}); // abort() rejects the reader; finish() still awaits and reports real errors
    const head = out(pngHead(width, height, channels));
    return {
      channels,
      async addStrip(strip, srcW, srcH) {
        await head;
        const w = srcW / k, h = srcH / k;
        let px = downscalePremul(strip, srcW, srcH, k);
        if (mode === "filled") px = compositeRGB(px, w, h, rowsOut, bg);
        else { px = px.subarray(0, w * h * 4); unpremultiply(px); }
        const f = filterRows(px, w, h, channels, prev);
        prev = f.last; rowsOut += h;
        await writer.ready;
        await writer.write(f.data);
        return rowsOut;
      },
      async finish() {
        if (rowsOut !== height) throw new Error(`PNG rows ${rowsOut} != height ${height}`);
        await writer.close();
        await pump;
        await out(pngEnd());
        return bytesOut;
      },
      async abort() { try { await writer.abort(); } catch (e) {} },
    };
  }

  return { CELL, planTiles, tileOffset, copyTileToStrip, scanWorld, hash2, fogKindOf, xrayWindow, hashFrame,
    downscalePremul, unpremultiply, compositeRGB, crc32, pngChunk, pngHead, pngEnd, filterRows, createPngEncoder };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CartoLogic;
