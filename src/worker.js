// Encoder worker body. The build prepends logic.js (CartoLogic) and starts it from a Blob URL.
let enc = null, chain = Promise.resolve();
self.onmessage = (ev) => {
  const m = ev.data;
  chain = chain.then(async () => {
    try {
      if (m.type === "init") {
        enc = CartoLogic.createPngEncoder(m.opts, async (bytes) => { self.postMessage({ type: "chunk", bytes }, [bytes.buffer]); });
        self.postMessage({ type: "ready" });
      } else if (m.type === "strip") {
        const rows = await enc.addStrip(new Uint8Array(m.buf), m.w, m.h);
        self.postMessage({ type: "stripDone", id: m.id, rows, buf: m.buf }, [m.buf]);
      } else if (m.type === "finish") {
        const bytes = await enc.finish();
        self.postMessage({ type: "done", bytes });
      } else if (m.type === "abort") {
        if (enc) await enc.abort();
      }
    } catch (e) {
      self.postMessage({ type: "error", id: m.id, message: String((e && e.stack) || e) });
    }
  });
};
