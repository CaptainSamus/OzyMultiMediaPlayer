// Which cached files to drop to get back under the cap: least recently used first. The caller
// lists the folder and deletes; anything it can't delete (in use) just stays for next time.
// A file marked `busy` (a video is reading it, or it was only just made) still counts toward the
// total but is never picked: better over the cap for a while than a copy pulled from under a tile.
{
  const CachePolicy = {
    evict(files, capBytes) {
      const list = (Array.isArray(files) ? files : []).map((f) => ({ path: f.path, size: Number(f.size) || 0, atimeMs: Number(f.atimeMs) || 0, busy: !!f.busy }));
      let total = list.reduce((s, f) => s + f.size, 0);
      const cap = Number(capBytes) || 0;
      const out = [];
      for (const f of list.sort((a, b) => a.atimeMs - b.atimeMs)) {
        if (total <= cap) break;
        if (f.busy) continue;
        out.push(f.path); total -= f.size;
      }
      return out;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CachePolicy;
  else window.CachePolicy = CachePolicy;
}
