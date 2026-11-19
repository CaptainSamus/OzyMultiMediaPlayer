// What serving a media file over HTTP needs, shared by the main process's localvideo:// handler
// (the fallback) and the media server process (lib/mediaserver.js): the content types, and how a
// Range header maps onto a file of a given size.
{
  const MIME = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
    '.ogg': 'video/ogg', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
    '.jpg': 'image/jpeg', // cached thumbnails and image tiles
    '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  };
  // a cached playable / smaller copy (the cache trim leaves alone what a tile is reading)
  const PROXY_FILE = /[\\/][0-9a-f]{40}(-half|-quarter)?\.mp4$/;
  const MediaHttp = {
    MIME,
    PROXY_FILE,
    typeOf(ext) { return MIME[String(ext || '').toLowerCase()] || 'application/octet-stream'; },
    // -> { status: 200 | 206, start, end } (end inclusive), or { status: 416 } for a range the file
    // cannot satisfy. No header, or one we don't understand, means the whole file.
    range(header, size) {
      let start = 0, end = size - 1;
      const m = /bytes=(\d*)-(\d*)/.exec(header || '');
      if (!m || (m[1] === '' && m[2] === '')) return { status: 200, start, end };
      if (m[1] !== '') {
        start = parseInt(m[1], 10);
        if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
      } else {
        start = Math.max(0, size - parseInt(m[2], 10)); // the last N bytes
      }
      if (start > end || start >= size) return { status: 416 };
      return { status: 206, start, end };
    },
    // the path a media URL names: /m/<token>/<base64url of the absolute path>
    pathFromUrl(urlPath, token) {
      const m = /^\/m\/([^/]+)\/([A-Za-z0-9_-]+)$/.exec(String(urlPath || ''));
      if (!m || !token || m[1] !== token) return null;
      try { return Buffer.from(m[2], 'base64url').toString('utf8') || null; } catch { return null; }
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = MediaHttp;
}
