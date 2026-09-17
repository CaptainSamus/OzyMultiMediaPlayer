// The rules for reading a .mvp session file, kept pure so every historical shape stays covered by
// tests. Sessions go back to format 3 (no type field, no groups, bookmarks without colour) and
// files are often hand-edited, so nothing here may throw: anything unreadable becomes a default,
// and anything unusable is dropped rather than taking the whole load down with it.
{
  const LIMITS = {
    minH: 60, maxH: 1200,            // a tile's gallery height
    minZoom: 0.05, maxZoom: 4,       // board zoom
    minScale: 0.25, maxScale: 4,     // gallery scale-all
    minTimelineH: 60, maxTimelineH: 320,
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, isFinite(v) ? v : lo));
  const positive = (v) => (Number(v) > 0 ? Number(v) : null);

  const Session = {
    FORMAT: 'multi-video-player-session',
    VERSION: 4,
    LIMITS,
    // what openSession accepts at all
    isSession(data) { return !!data && typeof data === 'object' && Array.isArray(data.videos); },
    // layout with every field defaulted. rowHeight null means the file didn't say, so the caller
    // keeps its own default and fits the view once the videos are in.
    layout(raw, limits = LIMITS) {
      const lay = raw && typeof raw === 'object' ? raw : {};
      const bv = lay.board;
      const board = bv && typeof bv === 'object' && isFinite(Number(bv.panX)) && isFinite(Number(bv.panY)) && Number(bv.zoom) > 0
        ? { panX: Number(bv.panX), panY: Number(bv.panY), zoom: clamp(Number(bv.zoom), limits.minZoom, limits.maxZoom) }
        : null;
      const rowHeight = positive(lay.rowHeight);
      return {
        mode: lay.mode === 'board' ? 'board' : 'gallery',
        rowHeight: rowHeight === null ? null : clamp(rowHeight, limits.minH, limits.maxH),
        galleryScale: positive(lay.galleryScale) === null ? 1 : clamp(Number(lay.galleryScale), limits.minScale, limits.maxScale),
        timeDisplay: ['clock', 'frames', 'timecode'].includes(lay.timeDisplay) ? lay.timeDisplay : 'clock',
        timelineExpanded: lay.timelineExpanded === true,
        timelineHeight: positive(lay.timelineHeight) === null ? 140 : clamp(Number(lay.timelineHeight), limits.minTimelineH, limits.maxTimelineH),
        board,
        linked: lay.linked !== false, // v3 files without the field default to linked
      };
    },
    masterVolume(raw, fallback = 1) { const v = Number(raw); return isFinite(v) ? clamp(v, 0, 1) : fallback; },
    // which tile a record asks for, or null when there isn't enough to build one
    videoKind(v) {
      if (!v || typeof v !== 'object') return null;
      if (v.type === 'youtube' || v.type === 'twitch') return typeof v.url === 'string' && v.url ? 'web' : null;
      if (v.type === 'sequence') return typeof v.dir === 'string' && v.seq && typeof v.seq.name === 'string' ? 'sequence' : null;
      if (typeof v.path !== 'string' || !v.path) return null;
      return v.type === 'image' ? 'image' : 'file'; // v3 records have no type at all
    },
    // groups worth restoring: at least two members that actually loaded
    groups(list, isKnownIndex = () => true) {
      const out = [];
      for (const sg of Array.isArray(list) ? list : []) {
        if (!sg || typeof sg !== 'object') continue; // a null entry must not stop the load
        const members = (Array.isArray(sg.members) ? sg.members : []).filter((i) => Number.isInteger(i) && isKnownIndex(i));
        if (members.length < 2) continue;
        const range = sg.range && typeof sg.range === 'object' && isFinite(Number(sg.range.in)) && isFinite(Number(sg.range.out))
          ? { in: Number(sg.range.in), out: Number(sg.range.out) } : null;
        out.push({
          id: Number.isInteger(sg.id) ? sg.id : null,
          name: typeof sg.name === 'string' ? sg.name : '',
          color: typeof sg.color === 'string' ? sg.color : '',
          members,
          sync: sg.sync === true,
          sticky: sg.sticky !== false,
          loop: ['off', 'shortest', 'longest', 'range'].includes(sg.loop) ? sg.loop : 'off',
          range,
          volume: isFinite(Number(sg.volume)) ? clamp(Number(sg.volume), 0, 1) : 1,
          muted: sg.muted === true,
          rate: Number(sg.rate) > 0 ? Number(sg.rate) : 1,
        });
      }
      return out;
    },
    // a member's saved offset on the group timeline
    syncStart(v) {
      const s = v && v.sync;
      return s && isFinite(Number(s.start)) ? Number(s.start) : 0;
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Session;
  else window.Session = Session;
}
