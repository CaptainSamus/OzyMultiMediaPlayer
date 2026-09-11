const test = require('node:test');
const assert = require('node:assert/strict');
const Frames = require('./frames');

test('step lands on the next frame midpoint', () => {
  assert.equal(Frames.step(0, 24, 1), 1.5 / 24);
  assert.equal(Frames.step(1.5 / 24, 24, 1), 2.5 / 24);
  assert.equal(Frames.step(0, 24, -1), 0.5 / 24);      // never below frame 0
  assert.equal(Frames.step(10, 24, -1), (240 - 1 + 0.5) / 24);
});
test('toFrame is the frame whose interval contains t', () => {
  assert.equal(Frames.toFrame(1.5 / 24, 24), 1);
  assert.equal(Frames.toFrame(0, 24), 0);
});
test('timecode is non-drop HH:MM:SS:FF with integer fps', () => {
  assert.equal(Frames.timecode(0, 24), '00:00:00:00');
  assert.equal(Frames.timecode(3661 + 12 / 24, 24), '01:01:01:12');
  // at 23.976 fps, t = 1.0 s is still inside frame 23; frame 24 is the first "01" second
  assert.equal(Frames.timecode(1, 23.976), '00:00:00:23');
  assert.equal(Frames.timecode(24.5 / 23.976, 23.976), '00:00:01:00');
});
test('format honours mode and unknown fps', () => {
  assert.equal(Frames.format(65, 125, 24, 'clock'), '1:05 / 2:05');
  assert.equal(Frames.format(1, 2, 24, 'frames'), '24 / 48');
  assert.equal(Frames.format(1, 2, 24, 'timecode'), '00:00:01:00 / 00:00:02:00');
  assert.equal(Frames.format(1, 2, null, 'frames'), '~24 / ~48');
});
