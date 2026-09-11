// Read yt-dlp's `--flat-playlist -J` output, and recognise "yt-dlp is out of date" errors.
const Playlist = {
  parseFlat(text) {
    let j; try { j = JSON.parse(text); } catch { return null; }
    if (!j || !Array.isArray(j.entries)) return null;
    const items = j.entries.filter((e) => e && e.id).map((e) => ({
      id: e.id, url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title || e.id,
      duration: Number.isFinite(e.duration) ? e.duration : null,
      thumbUrl: (e.thumbnails && e.thumbnails[0] && e.thumbnails[0].url) || `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    }));
    return { id: j.id || '', title: j.title || j.id || 'Playlist', items };
  },
  isOutdatedError(stderr) { return /unable to extract|unsupported url|please report this issue|signature/i.test(String(stderr)); },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Playlist;
else window.Playlist = Playlist;
