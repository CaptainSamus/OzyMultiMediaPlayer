// Geometry for the unified timeline: time <-> pixels over the group's extent.
const Timeline = {
  xFor(t, end, width) { return end > 0 ? Math.min(width, Math.max(0, t / end * width)) : 0; },
  tFor(x, end, width) { return width > 0 ? Math.min(end, Math.max(0, x / width * end)) : 0; },
  lanes(members) { return members.map((m) => ({ start: m.start, duration: m.duration, end: m.start + m.duration })); },
  clampRange(r, end) {
    if (!r || !isFinite(r.in) || !isFinite(r.out)) return { in: 0, out: end };
    let a = Math.min(end, Math.max(0, r.in)), b = Math.min(end, Math.max(0, r.out));
    if (a > b) [a, b] = [b, a];
    return { in: a, out: b };
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Timeline;
else window.Timeline = Timeline;
