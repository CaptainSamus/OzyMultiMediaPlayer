// Shape and pure updates for userData/settings.json (global, not per session).
const Settings = {
  defaults() { return { sidebar: { open: false, width: 300, tab: 'local' }, sources: { folders: [], playlists: [] }, updates: { auto: true, includePrerelease: true }, wheelZoom: false, hoverPlay: false, ezPlay: false,
    pauseOffscreen: true,
    cacheDir: null,
    cacheCapMB: 20480,
    loadStrip: false,
    loadStripH: 120,
  }; },
  merge(saved) {
    const d = Settings.defaults();
    const s = saved && typeof saved === 'object' ? saved : {};
    const sb = s.sidebar || {};
    const src = s.sources || {};
    const up = s.updates || {};
    return {
      // the update check is the only network call the app makes on its own; both can be turned off
      updates: { auto: up.auto !== false, includePrerelease: up.includePrerelease !== false },
      // wheel zooms instead of scrolling / panning (off by default: it changes how the wheel behaves)
      wheelZoom: s.wheelZoom === true,
      // videos play only while the cursor rests on them (off by default: it changes playback)
      hoverPlay: s.hoverPlay === true,
      // a video scrolled or panned out of view stops decoding until it is back (on by default)
      pauseOffscreen: s.pauseOffscreen !== false,
      // where playable and smaller copies are kept (null = the app's own data folder), and how big that may grow
      cacheDir: typeof s.cacheDir === 'string' && s.cacheDir ? s.cacheDir : null,
      cacheCapMB: Math.max(512, Number(s.cacheCapMB) || d.cacheCapMB),
      // a click anywhere on a tile that is not a control plays or pauses it (off by default)
      ezPlay: s.ezPlay === true,
      // the docked load strip (live memory and CPU bars) and the height it was dragged to
      loadStrip: s.loadStrip === true,
      loadStripH: Math.min(400, Math.max(56, Number(s.loadStripH) || d.loadStripH)),
      sidebar: { open: !!sb.open, width: Math.min(480, Math.max(220, Number(sb.width) || d.sidebar.width)), tab: sb.tab === 'web' ? 'web' : 'local' },
      sources: {
        folders: (Array.isArray(src.folders) ? src.folders : []).filter((f) => f && typeof f.path === 'string')
          .map((f) => ({ path: f.path, pinned: !!f.pinned, recent: !!f.recent && !f.pinned })),
        playlists: (Array.isArray(src.playlists) ? src.playlists : []).filter((p) => p && typeof p.url === 'string')
          .map((p) => ({ url: p.url, id: p.id || '', title: p.title || p.url, items: Array.isArray(p.items) ? p.items : [], fetchedAt: p.fetchedAt || null })),
      },
    };
  },
  upsertRecentFolder(s, dir) {
    const folders = s.sources.folders.filter((f) => !f.recent);
    if (!folders.some((f) => f.path.toLowerCase() === dir.toLowerCase())) folders.push({ path: dir, pinned: false, recent: true });
    return { ...s, sources: { ...s.sources, folders } };
  },
  pinFolder(s, dir, pinned) {
    const folders = s.sources.folders.map((f) => f.path.toLowerCase() === dir.toLowerCase() ? { path: f.path, pinned, recent: !pinned && f.recent } : f);
    if (!folders.some((f) => f.path.toLowerCase() === dir.toLowerCase())) folders.push({ path: dir, pinned, recent: false });
    return { ...s, sources: { ...s.sources, folders } };
  },
  removeFolder(s, dir) {
    return { ...s, sources: { ...s.sources, folders: s.sources.folders.filter((f) => f.path.toLowerCase() !== dir.toLowerCase()) } };
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Settings;
else window.Settings = Settings;
