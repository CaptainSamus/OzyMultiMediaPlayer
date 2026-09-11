// Frame-accurate stepping and time display. fps may be null (unknown -> 24, marked with ~).
const Frames = {
  DEFAULT_FPS: 24,
  clock(t) {
    if (!isFinite(t) || t < 0) t = 0;
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  },
  // A time inside frame N's interval is frame N: floor, with a nudge for float noise just under a boundary.
  toFrame(t, fps) { return Math.max(0, Math.floor((isFinite(t) ? t : 0) * fps + 1e-6)); },
  step(t, fps, dir) {
    const f = Math.max(0, Frames.toFrame(t, fps) + dir);
    return (f + 0.5) / fps;
  },
  timecode(t, fps) {
    const ifps = Math.round(fps);
    const total = Frames.toFrame(t, fps);
    const ff = total % ifps, secs = Math.floor(total / ifps);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(secs / 3600))}:${p(Math.floor((secs % 3600) / 60))}:${p(secs % 60)}:${p(ff)}`;
  },
  format(t, duration, fps, mode) {
    const known = fps > 0;
    const f = known ? fps : Frames.DEFAULT_FPS;
    const tilde = known ? '' : '~';
    if (mode === 'frames') return `${tilde}${Frames.toFrame(t, f)} / ${tilde}${Frames.toFrame(duration, f)}`;
    if (mode === 'timecode') return `${tilde}${Frames.timecode(t, f)} / ${tilde}${Frames.timecode(duration, f)}`;
    return `${Frames.clock(t)} / ${Frames.clock(duration)}`;
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Frames;
else window.Frames = Frames;
