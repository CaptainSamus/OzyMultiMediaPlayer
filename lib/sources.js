// Folder listing helpers for the Sources sidebar.
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv', '.ogg', '.avi']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const MEDIA_EXTS = new Set([...VIDEO_EXTS, ...AUDIO_EXTS]);
const ext = (n) => n.slice(n.lastIndexOf('.')).toLowerCase();
const Sources = {
  MEDIA_EXTS, IMAGE_EXTS,
  kindOf(name) { const e = ext(name); return VIDEO_EXTS.has(e) ? 'video' : AUDIO_EXTS.has(e) ? 'audio' : IMAGE_EXTS.has(e) ? 'image' : null; },
  filterMedia(names, { images = false } = {}) {
    return names.filter((n) => MEDIA_EXTS.has(ext(n)) || (images && IMAGE_EXTS.has(ext(n))))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  },
  parentDir(p) { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i > 0 ? p.slice(0, i) : p; },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Sources;
else window.Sources = Sources;
