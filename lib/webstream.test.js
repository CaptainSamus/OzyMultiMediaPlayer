const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('./webstream');

test('resolveArgs asks for one combined mp4 as JSON', () => {
  const a = W.resolveArgs('https://youtu.be/abc');
  assert.ok(a.includes('-j') && a.includes('--no-playlist'));
  assert.equal(a[a.indexOf('-f') + 1], W.FMT_STREAM);
  assert.match(W.FMT_STREAM, /acodec!=none/); // a stream that already has sound
  assert.equal(a[a.length - 1], 'https://youtu.be/abc');
});
test('resolveArgs can ask for a particular YouTube player client', () => {
  assert.ok(!W.resolveArgs('u').includes('--extractor-args')); // the default client has no flag
  const a = W.resolveArgs('u', 'android_vr');
  assert.equal(a[a.indexOf('--extractor-args') + 1], 'youtube:player_client=android_vr');
  assert.ok(a.indexOf('--extractor-args') < a.indexOf('-f'));
  assert.equal(W.CLIENTS[0], ''); // yt-dlp's own choice first
  assert.ok(W.CLIENTS.includes('android_vr'));
});
test('downloadArgs merges the best video and audio with the bundled ffmpeg', () => {
  const a = W.downloadArgs('https://youtu.be/abc', 'C:/c/yt-abc.mp4', 'C:/bin');
  assert.equal(a[a.indexOf('-f') + 1], W.FMT_DOWNLOAD);
  assert.equal(a[a.indexOf('--merge-output-format') + 1], 'mp4');
  assert.equal(a[a.indexOf('--ffmpeg-location') + 1], 'C:/bin');
  assert.equal(a[a.indexOf('-o') + 1], 'C:/c/yt-abc.mp4');
  assert.ok(!W.downloadArgs('u', 'o').includes('--ffmpeg-location')); // optional
  assert.ok(!W.downloadArgs('u', 'o', 'C:/bin').includes('--extractor-args')); // default client
  const c = W.downloadArgs('u', 'o', 'C:/bin', 'android_vr');
  assert.equal(c[c.indexOf('--extractor-args') + 1], 'youtube:player_client=android_vr');
  assert.ok(c.indexOf('--extractor-args') < c.indexOf('-f'));
});
test('parseProgress reads the last percentage', () => {
  assert.ok(Math.abs(W.parseProgress('[download]  45.3% of 10.00MiB') - 0.453) < 1e-6);
  assert.ok(Math.abs(W.parseProgress('[download]   1.0% of 1MiB\n[download]  99.9% of 1MiB') - 0.999) < 1e-6);
  assert.equal(W.parseProgress('[download] 100% of 1MiB'), 1);
  assert.equal(W.parseProgress('nothing here'), null);
});
test('isExpired: four hours', () => {
  const now = 10 * 3600 * 1000;
  assert.equal(W.isExpired(now - 3 * 3600 * 1000, now), false);
  assert.equal(W.isExpired(now - 5 * 3600 * 1000, now), true);
  assert.equal(W.isExpired(0, now), true);        // never resolved
  assert.equal(W.isExpired(undefined, now), true);
});
test('labelFor names each mode', () => {
  assert.equal(W.labelFor('stream', 720), '720p');
  assert.equal(W.labelFor('stream', 0), 'Stream');
  assert.equal(W.labelFor('player', 1080), 'Player');
  assert.equal(W.labelFor('download', 0), 'Local');
});
test('mode falls back to the default, downloadName stays a tame filename', () => {
  assert.equal(W.mode('player'), 'player');
  assert.equal(W.mode('nonsense'), W.DEFAULT_MODE);
  assert.ok(W.MODES.includes(W.DEFAULT_MODE));
  assert.equal(W.downloadName('youtube', 'aqz-KE-bpKQ'), 'yt-aqz-KE-bpKQ.mp4');
  assert.equal(W.downloadName('twitch', 'Clip/../x'), 'tw-Clipx.mp4');
});
test('parseResolved picks the JSON line, and refuses junk', () => {
  const r = W.parseResolved('WARNING: something\n{"url":"https://rr1.googlevideo.com/x","height":720,"title":"Big Buck Bunny"}\n');
  assert.deepEqual(r, { url: 'https://rr1.googlevideo.com/x', height: 720, title: 'Big Buck Bunny' });
  assert.equal(W.parseResolved('ERROR: Private video'), null);
  assert.equal(W.parseResolved('{"height":720}'), null); // no url
  assert.equal(W.parseResolved('{not json}'), null);
  assert.equal(W.parseResolved(''), null);
});

test('runtimeArgs points yt-dlp at the bundled QuickJS, or says nothing', () => {
  assert.deepEqual(W.runtimeArgs(''), []);
  assert.deepEqual(W.runtimeArgs(), []);
  assert.deepEqual(W.runtimeArgs(null), []);
  assert.deepEqual(W.runtimeArgs('C:\r\qjs.exe'), ['--js-runtimes', 'quickjs:C:\r\qjs.exe']);
});
test('resolveArgs passes the runtime, before the format selector', () => {
  const a = W.resolveArgs('https://youtu.be/x', '', { qjs: 'Q' });
  assert.equal(a[a.indexOf('--js-runtimes') + 1], 'quickjs:Q');
  assert.ok(a.indexOf('--js-runtimes') < a.indexOf('-f'));
  assert.ok(!W.resolveArgs('https://youtu.be/x').includes('--js-runtimes')); // no runtime, no flag
  assert.ok(!W.resolveArgs('https://youtu.be/x', '', {}).includes('--js-runtimes'));
});
test('downloadArgs passes the runtime alongside everything else', () => {
  const a = W.downloadArgs('u', 'o', 'F', 'ios', { qjs: 'Q' });
  assert.equal(a[a.indexOf('--js-runtimes') + 1], 'quickjs:Q');
  assert.ok(a.indexOf('--js-runtimes') < a.indexOf('-f'));
  assert.equal(a[a.indexOf('--extractor-args') + 1], 'youtube:player_client=ios');
  assert.equal(a[a.indexOf('--ffmpeg-location') + 1], 'F');
  assert.ok(!W.downloadArgs('u', 'o', 'F', 'ios').includes('--js-runtimes'));
});
test('yt-dlp warnings are no longer suppressed: they are the diagnostics', () => {
  assert.ok(!W.resolveArgs('u').includes('--no-warnings'));
  assert.ok(!W.downloadArgs('u', 'o', 'F').includes('--no-warnings'));
  assert.ok(W.resolveArgs('u').includes('--no-playlist'));
  assert.ok(W.downloadArgs('u', 'o', 'F').includes('--no-playlist'));
});
test('Player is what a new YouTube tile starts as, and Stream is not offered', () => {
  assert.equal(W.DEFAULT_MODE, 'player');
  assert.equal(W.mode(undefined), 'player');
  assert.equal(W.mode('nonsense'), 'player');
  // a session saved in Stream mode opens as Player until Stream works again
  assert.equal(W.mode('stream'), 'player');
  assert.equal(W.mode('download'), 'download'); // Local is still a deliberate choice
  assert.ok(W.MODES.includes('stream')); // the mode itself is only hidden, not removed
});

test('runtimeLikely only blames the missing runtime when the error smells of it', () => {
  assert.equal(W.runtimeLikely('WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled'), true);
  assert.equal(W.runtimeLikely('to use another runtime add --js-runtimes RUNTIME[:PATH]'), true);
  assert.equal(W.runtimeLikely('ERROR: [youtube] x: Requested format is not available.'), true);
  assert.equal(W.runtimeLikely('ERROR: [youtube] x: No video formats found!'), true);
  // a video that is simply gone, or a network problem, is not the runtime's fault
  assert.equal(W.runtimeLikely('ERROR: [youtube] x: This video is unavailable'), false);
  assert.equal(W.runtimeLikely('ERROR: [youtube] x: Private video. Sign in if you have been granted access'), false);
  assert.equal(W.runtimeLikely('ERROR: unable to download webpage: getaddrinfo ENOTFOUND'), false);
  assert.equal(W.runtimeLikely(''), false);
  assert.equal(W.runtimeLikely(null), false);
  assert.equal(W.runtimeLikely(undefined), false);
});
