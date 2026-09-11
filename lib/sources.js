// Folder listing helpers for the Sources sidebar.
const MEDIA_EXTS = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv', '.ogg', '.avi', '.mp3', '.wav', '.m4a', '.flac']);
const Sources = {
  MEDIA_EXTS,
  filterMedia(names) {
    return names.filter((n) => MEDIA_EXTS.has(n.slice(n.lastIndexOf('.')).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  },
  parentDir(p) { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i > 0 ? p.slice(0, i) : p; },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Sources;
else window.Sources = Sources;
