const test = require('node:test');
const assert = require('node:assert/strict');
const AS = require('./audiosync');

// made-up "sound": bursts of noise of random loudness, the same seed giving the same track
function track(seconds, seed) {
  let x = seed >>> 0; // mulberry32
  const rnd = () => { x = (x + 0x6D2B79F5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = Math.round(seconds * AS.RATE), out = new Int16Array(n);
  let level = 0;
  for (let i = 0; i < n; i++) {
    if (i % 400 === 0) level = rnd() < 0.3 ? 0.02 : rnd(); // a new loudness every 50 ms
    out[i] = Math.round((rnd() * 2 - 1) * 12000 * level);
  }
  return out;
}
const cut = (pcm, from, to) => pcm.subarray(Math.round(from * AS.RATE), Math.round(to * AS.RATE));

test('finds where the main stretch is inside the other video, to within a frame', () => {
  const src = track(90, 7);
  // the other video is the same sound starting 3.37 s later (it has 3.37 s more in front)
  const other = new Int16Array(src.length + Math.round(3.37 * AS.RATE));
  other.set(src, Math.round(3.37 * AS.RATE));
  const mainT = 40, otherGuess = 40 + 10; // lined up roughly: 6.6 s out
  const w = AS.windows(mainT, 90, otherGuess, 93.37);
  const r = AS.match(cut(src, w.main.start, w.main.start + w.main.dur), w.main.start, cut(other, w.other.start, w.other.start + w.other.dur), w.other.start, mainT);
  assert.ok(Math.abs(r.time - 43.37) < 0.02, String(r.time));
  assert.equal(r.sure, true);
});
test('a different gain and some hiss in the other version still match', () => {
  const src = track(60, 3);
  const other = new Int16Array(src.length);
  const hiss = track(60, 99);
  for (let i = 0; i < src.length; i++) other[i] = Math.round(src[i] * 0.4 + hiss[i] * 0.03);
  const w = AS.windows(30, 60, 31, 60);
  const r = AS.match(cut(src, w.main.start, w.main.start + w.main.dur), w.main.start, cut(other, w.other.start, w.other.start + w.other.dur), w.other.start, 30);
  assert.ok(Math.abs(r.time - 30) < 0.02, String(r.time));
});
test('unrelated sound, or silence, is not matched', () => {
  const a = track(40, 1), b = track(80, 2);
  const r = AS.match(cut(a, 10, 26), 10, b, 0, 18);
  assert.equal(r.time, null);
  const quiet = new Int16Array(80 * AS.RATE);
  assert.equal(AS.match(cut(a, 10, 26), 10, quiet, 0, 18).time, null);
});
test('windows stay inside both videos', () => {
  const w = AS.windows(3, 100, 2, 50);
  assert.deepEqual(w.main, { start: 0, dur: 16 });
  assert.deepEqual(w.other, { start: 0, dur: 50 });
  const z = AS.windows(99, 100, 49, 50);
  assert.equal(z.main.start, 84);
  assert.equal(z.main.dur, 16);
  assert.ok(z.other.start + z.other.dur <= 50);
});

test('findCut: where the main video has a shot the other cut lacks, and where the other has extra', () => {
  // main: X (0-30) Y (30-50) Z (50-80); other: X (0-30) Z (30-60)
  const X = track(30, 11), Y = track(20, 12), Z = track(30, 13);
  const cat = (...p) => { const o = new Int16Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const main = cat(X, Y, Z), other = cat(X, Z);
  // sync points at main 5 = other 5, and main 70 = other 50: offsets 0 and 20, 20 s the other lacks
  const a = AS.envelope(cut(main, 5, 70)), b = AS.envelope(cut(other, 5, 50));
  const r = AS.findCut(a, 5, b, 5, 0, 20, 20);
  assert.ok(Math.abs(r.at - 30) < 0.15, String(r.at));
  // the other way round: other = X Y Z, main = X Z; points main 5 = other 5, main 50 = other 70
  const a2 = AS.envelope(cut(other, 5, 50)), b2 = AS.envelope(cut(main, 5, 70));
  const r2 = AS.findCut(a2, 5, b2, 5, 0, -20, 0);
  assert.ok(Math.abs(r2.at - 30) < 0.15, String(r2.at));
  // nothing to go on: silence
  assert.equal(AS.findCut(new Float64Array(4000), 0, new Float64Array(4000), 0, 0, 5, 2), null);
});
