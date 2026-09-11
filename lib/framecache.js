// In-memory decoded frames for the frame player: an LRU capped by (estimated) bytes.
// Caches made from one pool share its budget, so many sequence tiles together stay under the cap;
// the least recently used frame of any of them goes first. Evicted bitmaps are closed.
const FrameCache = {
  pool(maxBytes = 2 * 1024 ** 3) { return { maxBytes, bytes: 0, tick: 0, caches: new Set() }; },
  create({ maxBytes, pool } = {}) {
    const P = pool || FrameCache.pool(maxBytes);
    const map = new Map(); // n -> { bmp, bytes, used }
    let own = 0;
    const drop = (n) => {
      const e = map.get(n); if (!e) return;
      map.delete(n); own -= e.bytes; P.bytes -= e.bytes;
      if (e.bmp && typeof e.bmp.close === 'function') { try { e.bmp.close(); } catch {} }
    };
    const evictOne = () => { // the pool's least recently used entry
      let best = null, bestCache = null;
      for (const c of P.caches) { const o = c._oldest(); if (o && (!best || o.used < best.used)) { best = o; bestCache = c; } }
      if (!bestCache) return false;
      bestCache._drop(best.n); return true;
    };
    const cache = {
      get(n) { const e = map.get(n); if (!e) return undefined; e.used = ++P.tick; return e.bmp; },
      has(n) { return map.has(n); },
      set(n, bmp, bytes = 0) {
        drop(n);
        map.set(n, { bmp, bytes, used: ++P.tick }); own += bytes; P.bytes += bytes;
        while (P.bytes > P.maxBytes && evictOne()) { /* keep evicting */ }
      },
      delete(n) { drop(n); },
      ranges() {
        const ns = [...map.keys()].sort((a, b) => a - b); const out = [];
        for (const n of ns) { const last = out[out.length - 1]; if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]); }
        return out;
      },
      clear() { for (const n of [...map.keys()]) drop(n); },
      dispose() { cache.clear(); P.caches.delete(cache); },
      get bytes() { return own; },
      get size() { return map.size; },
      _oldest() { let o = null; for (const [n, e] of map) if (!o || e.used < o.used) o = { n, used: e.used }; return o; },
      _drop: drop,
    };
    P.caches.add(cache);
    return cache;
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = FrameCache;
else window.FrameCache = FrameCache;
