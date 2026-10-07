// Naming and command-line details for ffmpeg H.264 proxies: the playable copy ('full', the
// original size) and the playback tiers ('half', 'quarter') Mark asked for so a heavy scene can be
// dropped like Premiere's 1/2 and 1/4. Named ProxyCache so it never shadows the built-in Proxy.
const ProxyCache = {
  TIERS: ['full', 'half', 'quarter'],
  divisor(tier) { return tier === 'half' ? 2 : tier === 'quarter' ? 4 : 1; },
  name(originalPath, size, mtimeMs, tier = 'full') {
    const crypto = require('crypto');
    const base = crypto.createHash('sha1').update(`${originalPath}|${size}|${mtimeMs}`).digest('hex');
    return base + (tier === 'half' || tier === 'quarter' ? `-${tier}` : '') + '.mp4';
  },
  args(input, output, tier = 'full') {
    const d = ProxyCache.divisor(tier);
    if (d === 1) {
      return ['-y', '-i', input, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output];
    }
    return ['-y', '-i', input, '-vf', `scale=trunc(iw/${d}/2)*2:trunc(ih/${d}/2)*2`,
      '-c:v', 'libx264', '-preset', 'faster', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output];
  },
  // One encode per file and tier: asking again while it runs gets the same promise, not a second
  // ffmpeg. `pending` is the caller's Map; a settled job is forgotten so a later ask starts afresh.
  jobKey(filePath, tier = 'full') { return `${filePath}|${ProxyCache.divisor(tier) === 1 ? 'full' : tier}`; },
  once(pending, key, start) {
    const running = pending.get(key);
    if (running) return running;
    const p = start();
    pending.set(key, p);
    const forget = () => { if (pending.get(key) === p) pending.delete(key); };
    p.then(forget, forget);
    return p;
  },
  // A cached copy can vanish under a tile (the cache was trimmed or cleared) or be unreadable.
  // What the tile does when its source fails to load:
  //   'remake-tier'    a half / quarter copy: back to the full file, make the copy again
  //   'original'       the playable copy, and the original can play here: use the original
  //   'offer-playable' the playable copy, and the original can't play: offer Make playable again
  //   'none'           the original itself failed: the tile's own error panel
  lostCopy({ tier, hasProxy, unplayable } = {}) {
    if (tier === 'half' || tier === 'quarter') return 'remake-tier';
    if (!hasProxy) return 'none';
    return unplayable ? 'offer-playable' : 'original';
  },
  // Swapping the file behind a <video> (another tier) must land where it was: same time (never
  // past the new file's end), same speed, and playing only if it was playing.
  restore(state, duration) {
    const s = state && typeof state === 'object' ? state : {};
    const at = Math.max(0, Number(s.time) || 0);
    const d = Number(duration);
    return { time: d > 0 ? Math.min(at, d) : at, rate: Number(s.rate) > 0 ? Number(s.rate) : 1, play: s.paused === false };
  },
  parseTime(chunk) {
    const all = [...String(chunk).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    if (!all.length) return null;
    const [, h, m, s] = all[all.length - 1];
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = ProxyCache;
else window.ProxyCache = ProxyCache;
