// "Line up here": find how two stretches of sound line up (2026-11-18).
// Both soundtracks come in as mono 16-bit PCM (ffmpeg, 8 kHz). Each is boiled down to how loud it
// is every 5 ms, on a log scale, with the slow level taken away, so only the changes are left (a
// door, a word, a beat): that survives a different mix, gain or EQ between two versions of the
// same footage. Then the short stretch from the main video is slid along the longer stretch from
// the other one and the best-correlating place wins. It only ever looks at the stretch you are
// on, so cuts that differ elsewhere in the two videos cannot throw it off.
(function () {
  const AudioSync = {
    RATE: 8000,          // samples a second asked of ffmpeg
    HOP: 40,             // samples per envelope step: 5 ms at 8 kHz
    MAIN_HALF: 8,        // s of the main video's sound each side of where it is
    SEARCH: 40,          // s either way the other video may be off
    // loudness every HOP samples, log scale, minus its own ~0.4 s moving average
    envelope(pcm, hop = AudioSync.HOP) {
      const n = Math.floor(pcm.length / hop);
      const e = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = i * hop, k = j + hop; j < k; j++) { const v = pcm[j]; s += v * v; }
        e[i] = Math.log(1 + Math.sqrt(s / hop));
      }
      const w = 40, out = new Float64Array(n), pre = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + e[i];
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
        out[i] = e[i] - (pre[b] - pre[a]) / (b - a);
      }
      return out;
    },
    // normalised correlation of a against b shifted by lag (a[k] against b[k + lag]), over where
    // they overlap; null when the overlap is shorter than minOverlap or either side is flat
    ncc(a, b, lag, minOverlap) {
      const k0 = Math.max(0, -lag), k1 = Math.min(a.length, b.length - lag);
      const n = k1 - k0;
      if (n < minOverlap) return null;
      let sa = 0, sb = 0;
      for (let k = k0; k < k1; k++) { sa += a[k]; sb += b[k + lag]; }
      const ma = sa / n, mb = sb / n;
      let num = 0, da = 0, db = 0;
      for (let k = k0; k < k1; k++) { const x = a[k] - ma, y = b[k + lag] - mb; num += x * y; da += x * x; db += y * y; }
      if (da < 1e-9 || db < 1e-9) return null;
      return num / Math.sqrt(da * db);
    },
    // the best lag of a inside b, its score, the best score well away from it (how sure), and the
    // lag refined between envelope steps
    best(a, b, { minOverlap = Math.floor(a.length * 0.6), away = 100 } = {}) {
      const lo = -(a.length - minOverlap), hi = b.length - minOverlap;
      const scores = new Map();
      let top = null;
      for (let lag = lo; lag <= hi; lag++) {
        const s = AudioSync.ncc(a, b, lag, minOverlap);
        if (s === null) continue;
        scores.set(lag, s);
        if (!top || s > top.score) top = { lag, score: s };
      }
      if (!top) return null;
      let second = -1;
      for (const [lag, s] of scores) if (Math.abs(lag - top.lag) > away && s > second) second = s;
      // a parabola through the peak and its neighbours: where between two steps it really is
      const l = scores.get(top.lag - 1), r = scores.get(top.lag + 1);
      let frac = 0;
      if (l !== undefined && r !== undefined) { const d = l - 2 * top.score + r; if (d < 0) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / d)); }
      return { lag: top.lag + frac, score: top.score, second };
    },
    // the stretches to read: around the main video's time, and a wider one around the other's
    // how hard to look, in turn: a quiet stretch needs more of it to go on, a big gap a wider search
    // (tried along two cuts of one Hi8 capture: 16 s matched 17 of 22 places, 32 s 20 of 22, none wrong)
    TRIES: [{ half: 8, search: 40 }, { half: 16, search: 40 }, { half: 16, search: 120 }],
    windows(mainT, mainDur, otherT, otherDur, search = AudioSync.SEARCH, half = AudioSync.MAIN_HALF) {
      const H = half, S = search;
      const aStart = Math.max(0, Math.min(mainT - H, mainDur - 2 * H));
      const bStart = Math.max(0, otherT - H - S);
      return {
        main: { start: aStart, dur: Math.max(0, Math.min(2 * H, mainDur - aStart)) },
        other: { start: bStart, dur: Math.max(0, Math.min(2 * H + 2 * S, otherDur - bStart)) },
      };
    },
    // where the other video is when the main one is at mainT, from the two stretches' sound.
    // { time, score, sure } or { time: null, why } when no match is good enough to use.
    match(mainPcm, mainStart, otherPcm, otherStart, mainT) {
      const a = AudioSync.envelope(mainPcm), b = AudioSync.envelope(otherPcm);
      if (a.length < 200) return { time: null, why: 'too little sound to compare here' };
      const r = AudioSync.best(a, b);
      if (!r) return { time: null, why: 'one of them is silent here' };
      const step = AudioSync.HOP / AudioSync.RATE;
      const time = otherStart + (mainT - mainStart) + r.lag * step;
      // (tried on two cuts of the same Hi8 capture: right matches score 0.4-0.5 with the next best
      // 0.15-0.25 away; a wrong place scores under 0.2)
      if (r.score < 0.28 || r.score - r.second < 0.08) return { time: null, why: 'their sound does not match here', score: r.score };
      return { time: Math.max(0, time), score: r.score, second: r.second, sure: r.score >= 0.35 && r.score - r.second >= 0.15 };
    },
    // Where, between two sync points, the two cuts part. Before the cut the other video runs at the
    // first point's offset, after it at the second's. a: the main video's envelope from main time
    // aStart; b: the other's from its time bStart; o1, o2: main time minus other time on each side;
    // gap: seconds of the main video the other lacks there (0 when the other has extra instead).
    // Every 50 ms: how well the two match over the second around it at each offset. The cut is where
    // "first offset before it, second offset after the gap" adds up best.
    // { at: main time of the cut, before, after: how well each side matched } or null when the sound
    // says too little either way.
    // slack: s either way each offset may be off (two copies whose sound sits differently against
    // the picture the offsets come from): each place takes the best within it.
    findCut(a, aStart, b, bStart, o1, o2, gap, step = AudioSync.HOP / AudioSync.RATE, slack = 0) {
      const sl = Math.round(slack / step), ls = Math.max(1, Math.round(0.01 / step));
      // how well a around frame c matches b at offset off, over win frames either side
      const local = (c, off, win) => {
        if (!sl) return local1(c, off, win, 0);
        let m = 0;
        for (let d = -sl; d <= sl; d += ls) { const v = local1(c, off, win, d); if (v > m) m = v; }
        return m;
      };
      const local1 = (c, off, win, d) => {
        const lag = Math.round((aStart - off - bStart) / step) + d; // b index = a index + lag
        const k0 = Math.max(0, c - win, -lag), k1 = Math.min(a.length, c + win, b.length - lag);
        if (k1 - k0 < win) return 0;
        let sa = 0, sb = 0;
        for (let k = k0; k < k1; k++) { sa += a[k]; sb += b[k + lag]; }
        const ma = sa / (k1 - k0), mb = sb / (k1 - k0);
        let num = 0, da = 0, db = 0;
        for (let k = k0; k < k1; k++) { const x = a[k] - ma, y = b[k + lag] - mb; num += x * y; da += x * x; db += y * y; }
        return da < 1e-9 || db < 1e-9 ? 0 : Math.max(0, num / Math.sqrt(da * db));
      };
      // the best cut frame among cand (sorted) with samples every S frames, window win: before it at o1,
      // after cut + gap at o2
      const pick = (from, to, S, win) => {
        const n = Math.floor((to - from) / S);
        if (n < 2) return null;
        const p1 = new Float64Array(n + 1), p2 = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) { const c = from + i * S; p1[i + 1] = p1[i] + local(c, o1, win); p2[i + 1] = p2[i] + local(c, o2, win); }
        const g = Math.min(n, Math.max(0, Math.round(gap / (S * step))));
        let best = -1, at = 0;
        for (let c = 0; c + g <= n; c++) { const s = p1[c] + (p2[n] - p2[c + g]); if (s > best) { best = s; at = c; } }
        return { frame: from + at * S, before: at ? p1[at] / at : 0, after: n - at - g > 0 ? (p2[n] - p2[at + g]) / (n - at - g) : 0 };
      };
      // every 50 ms with a second either side over the whole stretch, then frame by frame near there
      const coarse = pick(0, a.length, Math.max(1, Math.round(0.05 / step)), Math.round(1 / step));
      if (!coarse) return null;
      // (a right match scores about 0.4-0.5 over a second, a wrong one 0.1-0.15)
      if (Math.max(coarse.before, coarse.after) < 0.22) return null;
      const half = Math.round(0.6 / step), gapF = Math.round(gap / step);
      const lo = Math.max(0, coarse.frame - half), hi = Math.min(a.length, coarse.frame + gapF + half);
      const fine = pick(lo, hi, 1, Math.round(0.3 / step));
      const frame = fine ? fine.frame : coarse.frame;
      return { at: aStart + frame * step, before: coarse.before, after: coarse.after };
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AudioSync;
  else window.AudioSync = AudioSync;
})();
