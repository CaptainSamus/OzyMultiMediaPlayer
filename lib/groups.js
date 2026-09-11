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
  end(members) { return members.reduce((e, m) => Math.max(e, m.start + (m.duration || 0)), 0); },
  loopEnd(mode, members, range) {
    if (mode === 'shortest') return members.reduce((e, m) => Math.min(e, m.start + (m.duration || 0)), Infinity);
    if (mode === 'longest') return Groups.end(members);
    if (mode === 'range') return range && isFinite(range.out) ? range.out : Groups.end(members);
    return null;
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Groups;
else window.Groups = Groups;
