// Shape and pure updates for userData/settings.json (global, not per session).
const Settings = {
  defaults() { return { sidebar: { open: false, width: 300, tab: 'local' }, sources: { folders: [], playlists: [] } }; },
  merge(saved) {
    const d = Settings.defaults();
    const s = saved && typeof saved === 'object' ? saved : {};
    const sb = s.sidebar || {};
    const src = s.sources || {};
    return {
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
