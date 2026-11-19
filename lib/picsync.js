// Lining two videos up by their pictures (2026-11-18).
// Sound gets two cuts of the same footage close, but in a capture the sound can sit a few frames
// off the picture, and by a different amount in the other copy. The picture is what has to line
// up, so this refines it: how much each frame changes from the one before (tiny grey frames, from
// ffmpeg) is put on a 10 ms grid for both videos and the best-correlating offset wins. Different
// frame rates (23.976 against 29.97) do not matter: only the times of the changes count. When both
// have a shot change at that offset, the change itself says exactly where.
(function () {
  const PicSync = {
    CELL: 0.01,          // s per grid cell
    // per-frame change [{ t, v }] on a grid from start, dur s long: each change a short pulse
    grid(sig, start, dur, cell = PicSync.CELL) {
      const n = Math.max(0, Math.round(dur / cell)), g = new Float64Array(n);
      for (const { t, v } of sig) { const i = Math.round((t - start) / cell); if (i >= 0 && i < n) g[i] = Math.max(g[i], Math.log(1 + v)); }
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        if (!g[i]) continue;
        for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < n) out[j] = Math.max(out[j], g[i] * (1 - Math.abs(k) / 3)); }
      }
      return out;
    },
    ncc(a, b, lag) {
      let n = 0, sa = 0, sb = 0;
      const k0 = Math.max(0, -lag), k1 = Math.min(a.length, b.length - lag);
      for (let k = k0; k < k1; k++) { sa += a[k]; sb += b[k + lag]; n++; }
      if (n < a.length * 0.6) return null;
      const ma = sa / n, mb = sb / n;
      let x = 0, y = 0, z = 0;
      for (let k = k0; k < k1; k++) { const p = a[k] - ma, q = b[k + lag] - mb; x += p * q; y += p * p; z += q * q; }
      return y < 1e-9 || z < 1e-9 ? null : x / Math.sqrt(y * z);
    },
    // The offset (main time minus other time) at which the two pictures change together.
    // main / other: { start, dur, sig: [{ t, v }] }, other's stretch the wider. null if nothing fits.
    match(main, other) {
      const a = PicSync.grid(main.sig, main.start, main.dur), b = PicSync.grid(other.sig, other.start, other.dur);
      if (a.length < 100 || b.length < 100) return null;
      let best = null, second = -1;
      const lo = -Math.floor(a.length * 0.4), hi = b.length - Math.floor(a.length * 0.6);
      const scores = [];
      for (let lag = lo; lag <= hi; lag++) { const s = PicSync.ncc(a, b, lag); if (s === null) continue; scores.push([lag, s]); if (!best || s > best.score) best = { lag, score: s }; }
      if (!best) return null;
      for (const [lag, s] of scores) if (Math.abs(lag - best.lag) > 30 && s > second) second = s;
      // a at main.start + k*cell is b at other.start + (k + lag)*cell
      return { offset: main.start - other.start - best.lag * PicSync.CELL, score: best.score, second };
    },
    // Shot changes that agree with offset (within tol s): the offset they give, exactly, or null.
    fromCuts(mainCuts, otherCuts, offset, tol = 0.2) {
      const hits = [];
      for (const c of mainCuts) {
        let near = null;
        for (const d of otherCuts) { const o = c - d; if (Math.abs(o - offset) <= tol && (near === null || Math.abs(o - offset) < Math.abs(near - offset))) near = o; }
        if (near !== null) hits.push(near);
      }
      if (!hits.length) return null;
      hits.sort((x, y) => x - y);
      return { offset: hits[Math.floor(hits.length / 2)], count: hits.length };
    },
    // a time on a frame of fps: the middle of the frame t falls in
    onFrame(t, fps) { return fps > 0 ? (Math.max(0, Math.floor(t * fps + 1e-6)) + 0.5) / fps : t; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PicSync;
  else window.PicSync = PicSync;
})();
