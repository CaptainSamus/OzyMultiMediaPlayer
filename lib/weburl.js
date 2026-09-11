// Parse YouTube / Twitch links and build their embed URLs.
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const RESERVED_TWITCH = new Set(['directory', 'videos', 'settings', 'downloads', 'p', 'search']);
const WebUrl = {
  parse(input) {
    let u; try { u = new URL(String(input).trim()); } catch { return null; }
    const host = u.hostname.replace(/^www\.|^m\./, '');
    const parts = u.pathname.split('/').filter(Boolean);
    if (host === 'youtu.be') return parts[0] && YT_ID.test(parts[0]) ? { type: 'youtube', kind: 'video', id: parts[0] } : null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const list = u.searchParams.get('list');
      if (list) return { type: 'youtube', kind: 'playlist', id: list };
      if (parts[0] === 'shorts' && YT_ID.test(parts[1] || '')) return { type: 'youtube', kind: 'short', id: parts[1] };
      if (parts[0] === 'embed' && YT_ID.test(parts[1] || '')) return { type: 'youtube', kind: 'video', id: parts[1] };
      const v = u.searchParams.get('v');
      if (parts[0] === 'watch' && v && YT_ID.test(v)) return { type: 'youtube', kind: 'video', id: v };
      return null;
    }
    if (host === 'clips.twitch.tv') return parts[0] ? { type: 'twitch', kind: 'clip', id: parts[0] } : null;
    if (host === 'twitch.tv') {
      if (parts.length === 3 && parts[1] === 'clip') return { type: 'twitch', kind: 'clip', id: parts[2] };
      if (parts.length === 1 && !RESERVED_TWITCH.has(parts[0])) return { type: 'twitch', kind: 'stream', id: parts[0] };
      return null;
    }
    return null;
  },
  embed(p, parent) {
    if (p.type === 'youtube') return `https://www.youtube.com/embed/${p.id}?enablejsapi=1&rel=0`; // playlists never embed; they go to the sidebar
    if (p.kind === 'clip') return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(p.id)}&parent=${parent}&autoplay=false`;
    return `https://player.twitch.tv/?channel=${encodeURIComponent(p.id)}&parent=${parent}&autoplay=false`;
  },
  label(p) {
    if (p.type === 'youtube') return { video: 'YouTube', short: 'YouTube Short', playlist: 'YouTube playlist' }[p.kind] + ' · ' + p.id;
    return (p.kind === 'clip' ? 'Twitch clip · ' : 'Twitch · ') + p.id;
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = WebUrl;
else window.WebUrl = WebUrl;
