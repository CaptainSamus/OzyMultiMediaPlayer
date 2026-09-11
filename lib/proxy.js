// Naming and command-line details for ffmpeg H.264 proxies.
// Named ProxyCache so it never shadows the built-in Proxy constructor.
const ProxyCache = {
  name(originalPath, size, mtimeMs) {
    const crypto = require('crypto');
    return crypto.createHash('sha1').update(`${originalPath}|${size}|${mtimeMs}`).digest('hex') + '.mp4';
  },
  args(input, output) {
    return ['-y', '-i', input, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output];
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
