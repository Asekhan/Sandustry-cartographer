"use strict";
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const L = require("../src/logic.js");

// Minimal PNG decoder for checking the encoder (8-bit RGB/RGBA, all five filters).
function decodePng(buf) {
  buf = Buffer.from(buf);
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let off = 8, w = 0, h = 0, ct = 0; const idat = []; let ended = false;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len), crc = buf.readUInt32BE(off + 8 + len);
    assert.equal(L.crc32(buf.subarray(off + 4, off + 8 + len)), crc, "crc " + type);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; assert.equal(data[8], 8); }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") ended = true;
    off += 12 + len;
  }
  assert.ok(ended, "IEND");
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, h * (stride + 1));
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0, b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? px[(y - 1) * stride + i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + i] = v & 255;
    }
  }
  return { w, h, ct, px };
}

module.exports = { decodePng };
