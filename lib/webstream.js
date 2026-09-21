// yt-dlp command lines and helpers for playing YouTube videos and Twitch clips as real <video>
// tiles. Three modes per tile: 'stream' (a direct combined URL, up to 720p, resolved fresh because
// the URLs expire), 'player' (the iframe embed, for quality above 720p) and 'download' (yt-dlp
// merges the best video+audio into the cache, then the tile plays that file).
{
  // one file that already has sound: that means 720p or less, which is what a <video> can play as is
  const FMT_STREAM = 'best[ext=mp4][vcodec^=avc1][acodec!=none]/best[ext=mp4]/best';
  const FMT_DOWNLOAD = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
  const EXPIRY_MS = 4 * 60 * 60 * 1000; // Google's URLs last about 6 h; re-resolve after 4

  const WebStream = {
    FMT_STREAM, FMT_DOWNLOAD, EXPIRY_MS,
    MODES: ['stream', 'player', 'download'],
    // What a newly added YouTube video / Twitch clip starts as. Player: it costs nothing, plays
    // straight away and syncs to the timeline, and nothing is downloaded until the user asks for
    // Local. Stream is not an option any more - the web client offers no combined audio+video
    // format at all, and the one android_vr still lists is bound to yt-dlp's own request and 403s
    // from anywhere else.
    DEFAULT_MODE: 'player',
    mode(m) {
      /* DISABLED (Mark, 2026-09-21): Stream is broken until Task 35; Player + timeline sync covers
         the need. Restore this line (and the <option> in index.html) when Stream works again.
      return WebStream.MODES.includes(m) ? m : WebStream.DEFAULT_MODE;
      */
      if (m === 'stream') return 'player'; // a session saved in Stream mode opens as Player
      return WebStream.MODES.includes(m) ? m : WebStream.DEFAULT_MODE;
    },
    // YouTube hands out formats per "player client". With the bundled JS runtime the default web
    // client works again and lists the full DASH ladder, so it goes first; android_vr stays next
    // because it is the one client that needs no runtime, so a build with a missing or broken
    // qjs still gets something; ios / tv / mweb are long-standing fallbacks. '' is yt-dlp's own
    // default. Tried in order until one resolves.
    CLIENTS: ['', 'android_vr', 'ios', 'tv', 'mweb'],
    // YouTube's URLs carry a challenge that has to be solved by running JavaScript from the player
    // page. yt-dlp delegates that to an external runtime and auto-detects only Deno, so the
    // bundled QuickJS-NG has to be named explicitly. No binary: no flag, and yt-dlp does what it
    // can without one.
    runtimeArgs(qjsPath) {
      return qjsPath ? ['--js-runtimes', 'quickjs:' + String(qjsPath)] : [];
    },
    // -j gives one JSON blob, so the direct URL and its height come from a single run
    resolveArgs(url, client = '', { qjs = '' } = {}) {
      const args = ['-j', '--no-playlist', ...WebStream.runtimeArgs(qjs)];
      if (client) args.push('--extractor-args', `youtube:player_client=${client}`);
      args.push('-f', FMT_STREAM, String(url));
      return args;
    },
    downloadArgs(url, out, ffmpegDir, client = '', { qjs = '' } = {}) {
      const args = ['--no-playlist', ...WebStream.runtimeArgs(qjs)];
      // the same client story as resolveArgs: the default one may have no formats to offer
      if (client) args.push('--extractor-args', `youtube:player_client=${client}`);
      args.push('-f', FMT_DOWNLOAD, '--merge-output-format', 'mp4');
      if (ffmpegDir) args.push('--ffmpeg-location', String(ffmpegDir)); // the bundled ffmpeg does the merge
      args.push('-o', String(out), String(url));
      return args;
    },
    // "[download]  45.3% of 10.00MiB" -> 0.453 (the last percentage in the chunk), null if there is none
    parseProgress(chunk) {
      const all = [...String(chunk).matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/g)];
      if (!all.length) return null;
      return Math.min(1, Math.max(0, Number(all[all.length - 1][1]) / 100));
    },
    isExpired(resolvedAt, now = Date.now()) { return !(Number(resolvedAt) > 0) || now - Number(resolvedAt) > EXPIRY_MS; },
    // what the tile's mode button shows
    labelFor(mode, height) {
      if (mode === 'player') return 'Player';
      if (mode === 'download') return 'Local';
      return Number(height) > 0 ? `${Math.round(Number(height))}p` : 'Stream';
    },
    // the downloaded file's name in the proxies cache (id comes from WebUrl.parse, so it is already tame)
    downloadName(type, id) { return `${type === 'twitch' ? 'tw' : 'yt'}-${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.mp4`; },
    // yt-dlp -j output -> what the renderer needs
    parseResolved(stdout) {
      const line = String(stdout).split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
      if (!line) return null;
      try {
        const j = JSON.parse(line);
        if (!j || typeof j.url !== 'string' || !j.url) return null;
        return { url: j.url, height: Number(j.height) || 0, title: typeof j.title === 'string' ? j.title : '' };
      } catch { return null; }
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = WebStream;
  else window.WebStream = WebStream;
}
