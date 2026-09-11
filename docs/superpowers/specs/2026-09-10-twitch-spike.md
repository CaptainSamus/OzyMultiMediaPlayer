# Twitch / YouTube embed spike — findings

Date: 2026-09-10. Task 10 of the v1 plan. All spike code has been reverted
(`git checkout -- main.js index.html`); this file is the only output.

## Result

**Serve the UI from a loopback http server (`http://127.0.0.1:<random port>/index.html`)
and embed with `parent=127.0.0.1`.** Twitch live streams and YouTube both play from
that origin. The custom-scheme origin works for neither.

| Page origin | Twitch `parent` | Twitch | YouTube (`youtube.com` / `youtube-nocookie.com` embed) |
|---|---|---|---|
| `app://ozy` (privileged custom scheme) | `ozy` | blank — refused | **Error 153 "Video player configuration error"** |
| `app://ozy` | `localhost` | blank — refused | (same) |
| `http://127.0.0.1:<port>` | `127.0.0.1` | **plays** (live stream, ads, offline card) | **plays** (muted autoplay works) |
| `http://127.0.0.1:<port>` | `localhost` | blank — refused (origin mismatch) | plays |
| `http://localhost:<port>` | `localhost` | **plays** | **plays** |

`localvideo://` still streams local files from both http origins (tile reached
`readyState` 4, no error), and `window.api` / the preload work unchanged.

## Why

- Twitch turns `parent=X` into the response header
  `Content-Security-Policy: frame-ancestors https://X` (for a bare name) or
  `frame-ancestors http://X:* https://X:*` (for `localhost` / `127.0.0.1`).
  An `app://` origin can never match an `http(s)://` source, so no `parent` value
  makes a custom scheme work. The file:// origin has the same problem.
- YouTube now refuses embeds that don't come from a real http(s) origin/referrer
  (Error 153). **This means YouTube tiles also need the loopback origin**; the spec's
  assumption that YouTube works regardless of the Twitch outcome no longer holds.

## What Task 11 needs to change (beyond the plan as written)

1. **Main process serves the UI over http on loopback.**
   - `http.createServer` bound to `127.0.0.1`, port `0` (random), serving only files
     under the app directory (`__dirname`; Electron's fs reads from the asar when
     packaged). Normalise the path and refuse anything outside the app folder.
   - `win.loadURL('http://127.0.0.1:' + port + '/index.html')` instead of `loadFile`.
   - Nothing in the renderer uses localStorage / IndexedDB (checked), so the origin
     changing port every launch loses nothing. Settings stay in `settings.json` via main.
   - Works fully offline: the server is local; nothing else changes for local features.
2. **`parent=127.0.0.1`** for every Twitch embed URL (clips and channels). Build it
   from `location.hostname` so it always matches the page.
3. **Network allowlist** (the `onBeforeRequest` block becomes an allowlist). Hosts the
   embeds actually used in the spike (logged request by request):
   - Page itself: `http://127.0.0.1:<port>` (loopback only, that port).
   - Twitch: `twitch.tv` (`player.`, `clips.`, `www.`, `gql.`, `assets.`, `spade.`,
     `hermes.`), `ttvnw.net` (`usher.`, `*.playlist.`, `*.hls.`), `jtvnw.net`
     (`static-cdn.`), `twitchcdn.net` (`k.`), **`live-video.net`** (Amazon IVS: player
     config, stats, and the video segments `*.hls.live-video.net` — without it streams
     don't play). `twitchsvc.net` was allowed but not seen; keep it out unless needed.
   - YouTube: `youtube.com`, `youtube-nocookie.com`, `ytimg.com` (`i.`),
     `googlevideo.com`, **`ggpht.com`** (`yt3.` channel avatars), **`google.com`**
     (`www.`), **`gstatic.com`** (`www.`, `fonts.`), **`googleapis.com`**
     (`jnn-pa.` — YouTube's player integrity check).
   - Left blocked with no visible effect on playback: `s.amazon-adsystem.com`,
     `compliance.iabtechnologylab.com`, `reporting.cdndex.io`. Twitch's own ads still
     show (served through the hosts above).
   - `k.twitchcdn.net` (Kasada bot check) answered 429 once; playback was unaffected.
4. **CSP** gains `frame-src https://player.twitch.tv https://clips.twitch.tv
   https://www.youtube.com https://www.youtube-nocookie.com`. `default-src 'self'`
   now means the loopback origin, which is what we want. `media-src localvideo:` is
   unchanged. (Task 13's `img-src` for `i.ytimg.com` thumbnails still applies.)
5. The spec's network list (feature 6) should add `live-video.net`, `google.com`,
   `gstatic.com`, `googleapis.com`, `ggpht.com`, and the README line about network use
   should mention them.

## Not verified

- **Twitch clip playback.** The plan's sample clip slug is dead ("This clip is no
  longer available"); the clip player itself loaded and responded from 127.0.0.1, and
  clips use the same player and hosts as streams, but a live clip slug should be
  checked in Task 11's manual test.
- Packaged build (asar) serving through the http server — mechanism is the same fs
  call, but check it once in Task 11.

## Choice between 127.0.0.1 and localhost

Both work. Prefer **127.0.0.1**: it doesn't depend on how `localhost` resolves on the
machine (IPv4 vs IPv6 `::1`, hosts-file edits), and binding the server to the literal
address guarantees it is never reachable from the network.
