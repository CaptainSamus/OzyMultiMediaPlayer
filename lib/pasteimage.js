// Pasting a picture copied elsewhere (Mark, 2026-11-10): right-click → Copy image in Chrome (Google
// Images) or Discord, then Ctrl+V on the board, as in Miro.
//
// What the clipboard holds after "Copy image" differs by program:
//   - Chrome: the picture as Chrome decoded it (a bitmap) and a bit of HTML, <img src="…">, naming
//     the file it came from. That file is the better copy when it is at least as big: its own
//     format and quality, and a GIF still moves.
//   - Discord and others: often just the bitmap, sometimes a link as text.
// So Ozy takes every candidate (the linked file, a picture written into the HTML itself, the
// bitmap) and keeps the one with the most pixels, the linked file winning a tie. The rules that
// need no Electron live here, where they are tested; main.js does the fetching and the saving.
{
  const PasteImage = {
    // the first picture the copied HTML names: an http(s) link or a data: picture (else null)
    imgSrc(html) {
      const m = String(html || '').match(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (!m) return null;
      const src = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').trim();
      if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) return src;
      return null;
    },
    // copied text that is a single web link (Discord's "Copy link", an address bar): the link
    urlFromText(text) {
      const s = String(text || '').trim();
      return /^https?:\/\/\S+$/i.test(s) && s.length < 4096 ? s : null;
    },
    // A data: picture's bytes and type, or null
    fromDataUrl(src) {
      const m = String(src || '').match(/^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is);
      if (!m) return null;
      try {
        const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'binary');
        return bytes.length ? { bytes, type: m[1].toLowerCase() } : null;
      } catch { return null; }
    },
    // The best of the candidates [{ kind, w, h, ... }]: most pixels, the linked file first on a tie
    // (and a picture whose size could not be read only when there is nothing else).
    best(cands) {
      const known = cands.filter((c) => c && c.w > 0 && c.h > 0);
      const rank = (c) => (c.kind === 'link' ? 2 : c.kind === 'data' ? 1 : 0);
      if (known.length) return known.sort((a, b) => b.w * b.h - a.w * a.h || rank(b) - rank(a))[0];
      return cands.find((c) => c && c.kind === 'link') || cands.find(Boolean) || null;
    },
    EXT: { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif', 'image/svg+xml': '.svg' },
    // the extension for a picture: its type first, then its link
    extFor(type, url) {
      const t = String(type || '').toLowerCase().split(';')[0].trim();
      if (PasteImage.EXT[t]) return PasteImage.EXT[t];
      const m = String(url || '').split(/[?#]/)[0].match(/\.(jpe?g|png|gif|webp|bmp|avif|svg)$/i);
      return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : null;
    },
    // A file name for a pasted picture: the link's own name when it has a sensible one, else
    // "pasted" and the time. Safe on Windows. (No trailing frame number, so Ozy never mistakes a
    // few pasted pictures for an image sequence.)
    fileName(url, ext, now = new Date()) {
      let base = '';
      try {
        const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
        base = last.replace(/\.[a-z0-9]{2,5}$/i, '');
      } catch {}
      base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!/[a-z]{3}/i.test(base) || /^(images?|img|unnamed|download|file|photo|media)$/i.test(base)) base = '';
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`;
      return (base ? `${base} (pasted ${stamp})` : `pasted ${stamp}`) + ext;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PasteImage;
  else window.PasteImage = PasteImage;
}
