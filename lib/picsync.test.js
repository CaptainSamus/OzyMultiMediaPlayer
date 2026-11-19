const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./picsync');

// made-up footage: shot changes and motion at random moments; the other copy at another frame rate
function footage(seconds, seed) {
  let x = seed >>> 0;
  const rnd = () => { x = (x + 0x6D2B79F5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ev = []; // [time, size] of each change in the scene
  for (let t = 0; t < seconds; t += 0.05 + rnd() * 0.6) ev.push([t, rnd() < 0.08 ? 60 : rnd() * 8]);
  return ev;
}
// what a video at fps sees of those changes, its own time = scene time - shift
function sample(ev, fps, from, to, shift) {
  const sig = [];
  for (let f = Math.ceil(from * fps); f / fps < to; f++) {
    const t = f / fps, t0 = t - 1 / fps;
    let v = 0.5;
    for (const [et, s] of ev) if (et - shift > t0 && et - shift <= t) v += s;
    sig.push({ t, v });
  }
  return sig;
}

test('finds the picture offset between a 23.976 and a 29.97 fps copy, to within a frame', () => {
  const ev = footage(120, 5);
  // main: scene time = main time; other: other time = scene time - 37.4 (so offset 37.4)
  const main = { start: 50, dur: 12, sig: sample(ev, 24000 / 1001, 50, 62, 0) };
  const other = { start: 50 - 37.4 - 7, dur: 26, sig: sample(ev, 30000 / 1001, 50 - 37.4 - 7, 50 - 37.4 + 19, 37.4) };
  const r = P.match(main, other);
  assert.ok(Math.abs(r.offset - 37.4) < 0.034, String(r.offset));
  assert.ok(r.score > 0.4);
});
test('unrelated pictures give a poor score', () => {
  const main = { start: 0, dur: 12, sig: sample(footage(40, 1), 25, 0, 12, 0) };
  const other = { start: 0, dur: 26, sig: sample(footage(40, 2), 25, 0, 26, 0) };
  const r = P.match(main, other);
  assert.ok(r.score - r.second < 0.15, JSON.stringify(r));
});
test('shot changes that agree with the offset give it exactly; others are ignored', () => {
  assert.deepEqual(P.fromCuts([331.248, 340], [27.661, 50], 303.7), { offset: 331.248 - 27.661, count: 1 });
  assert.equal(P.fromCuts([10], [3], 303.7), null);
  assert.equal(P.fromCuts([], [1], 0), null);
});
test('onFrame puts a time in the middle of its frame', () => {
  assert.equal(P.onFrame(1.0, 25), 1.02);
  assert.equal(P.onFrame(1.039, 25), 1.02);
  assert.equal(P.onFrame(1.04, 25), 1.06);
});
