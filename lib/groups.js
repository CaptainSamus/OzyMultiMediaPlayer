// Group time model. Every synced member sits on one shared timeline ("group
// time" g). A member with `start` s and duration d plays from g = s to g = s + d;
// before s it waits on frame 0, after s + d it holds its last frame.
const Groups = {
  DRIFT: 0.08,
  DRIFT_WEB: 0.35, // YouTube reports its time about 4x a second, so its followers get more slack
  PALETTE: { blue: '#4f8cff', pink: '#ff6ad5', yellow: '#ffd166', green: '#6ee7b7', orange: '#f97316', purple: '#a78bfa', red: '#ff5c5c', white: '#ffffff' },
  starts(times) { const m = Math.max(...times); return times.map((t) => m - t); },
  memberTime(g, start, duration) { return Math.min(duration, Math.max(0, g - start)); },
  groupTime(memberTime, start) { return memberTime + start; },
  end(members) { return members.reduce((e, m) => Math.max(e, Groups.extent(m).to), 0); },

  // ---- sync points (2026-11-18) ----
  // A member (m = { start, duration, points }) may carry sync points, pairs { g, t }: "at group
  // time g this member is at its own time t". Between two points it plays on from the first. If
  // the next point comes sooner in its own time (the main video has a part this cut does not), it
  // holds there until the next point; if later (this cut has a part the main video does not), it
  // jumps at the next point. Before the first point and after the last it keeps that point's
  // offset. No points: one point { g: start, t: 0 }, the plain offset everything used before.
  pts(m) { return m.points && m.points.length ? m.points : [{ g: m.start || 0, t: 0 }]; },
  seg(pts, g) { let i = 0; while (i + 1 < pts.length && pts[i + 1].g <= g) i++; return i; },
  // the member's own time at group time g, not clamped to its length, and whether it is holding
  raw(m, g) {
    const pts = Groups.pts(m), i = Groups.seg(pts, g), p = pts[i], n = pts[i + 1];
    let t = p.t + (g - p.g), hold = false;
    if (n && g >= p.g && n.t >= p.t && t > n.t) { t = n.t; hold = true; }
    return { t, hold };
  },
  at(m, g) { return Math.min(m.duration, Math.max(0, Groups.raw(m, g).t)); },
  // playing at g: inside its length and not holding for a part it does not have
  plays(m, g) { const r = Groups.raw(m, g); return !r.hold && r.t >= 0 && r.t < m.duration; },
  holding(m, g) { return Groups.raw(m, g).hold; },
  // the group time its own time t stands for (its own bar, its keys)
  toGroup(m, t) {
    const pts = Groups.pts(m);
    if (t < pts[0].t) return pts[0].g + (t - pts[0].t);
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], n = pts[i + 1];
      if (n.t < p.t) { if (t >= p.t && t < p.t + (n.g - p.g)) return p.g + (t - p.t); continue; }
      const len = Math.min(n.t - p.t, n.g - p.g);
      if (t >= p.t && t < p.t + len) return p.g + (t - p.t);
      if (t >= p.t + len && t < n.t) return n.g; // a part only this cut has: where it jumps past it
    }
    const p = pts[pts.length - 1];
    return p.g + (t - p.t);
  },
  // where on the group timeline it begins (its frame 0) and ends (its last frame)
  extent(m) {
    const pts = Groups.pts(m), a = pts[0], z = pts[pts.length - 1];
    return { from: a.g - a.t, to: z.g + ((m.duration || 0) - z.t) };
  },
  // a clean list: finite, t >= 0, in group-time order, no two at the same moment
  cleanPoints(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const p of list) {
      if (!p || !isFinite(Number(p.g)) || !isFinite(Number(p.t))) continue;
      const q = { g: Math.round(Number(p.g) * 1e4) / 1e4, t: Math.max(0, Math.round(Number(p.t) * 1e4) / 1e4) };
      const same = out.findIndex((o) => Math.abs(o.g - q.g) < 1e-3);
      if (same >= 0) out[same] = q; else out.push(q);
    }
    out.sort((a, b) => a.g - b.g);
    return out.length ? out : null;
  },
  // a new list with { g, t } in it; a point within `near` s of g is the one being re-done, so it goes
  addPoint(list, g, t, near = 0) {
    const keep = (list || []).filter((p) => Math.abs(p.g - g) > near);
    return Groups.cleanPoints([...keep, { g, t }]);
  },
  removePoint(list, g, near = 0.05) {
    return Groups.cleanPoints((list || []).filter((p) => Math.abs(p.g - g) > near));
  },
  shiftPoints(list, d) { return list ? list.map((p) => ({ g: p.g + d, t: p.t })) : list; },
  // two members trade roles: the follower's points re-expressed with it as the main video.
  // In: the main's start and the follower's points; out: the old main's points, with group time
  // now the old follower's own time (start 0 for the new main).
  swapPoints(mainStart, points) {
    return Groups.cleanPoints((points || []).map((p) => ({ g: p.t, t: p.g - mainStart })));
  },

  loopEnd(mode, members, range) {
    if (mode === 'shortest') return members.reduce((e, m) => Math.min(e, Groups.extent(m).to), Infinity);
    if (mode === 'longest') return Groups.end(members);
    if (mode === 'range') return range && isFinite(range.out) ? range.out : Groups.end(members);
    return null;
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Groups;
else window.Groups = Groups;
