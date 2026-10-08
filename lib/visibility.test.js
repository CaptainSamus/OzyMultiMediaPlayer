const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('./visibility');

const view = { x: 0, y: 0, w: 1000, h: 600 };
test('a playing tile fully outside the view (plus margin) is paused', () => {
  const out = V.decide([{ id: 1, rect: { x: 2000, y: 0, w: 100, h: 100 }, playing: true, autoPaused: false }], view, 300);
  assert.deepEqual(out, [{ id: 1, op: 'pause' }]);
});
test('inside the margin counts as visible', () => {
  const out = V.decide([{ id: 1, rect: { x: 1200, y: 0, w: 100, h: 100 }, playing: true, autoPaused: false }], view, 300);
  assert.deepEqual(out, []);
});
test('only tiles we paused are resumed, and only once back in view', () => {
  const items = [
    { id: 1, rect: { x: 10, y: 10, w: 100, h: 100 }, playing: false, autoPaused: true },   // back: resume
    { id: 2, rect: { x: 10, y: 10, w: 100, h: 100 }, playing: false, autoPaused: false },  // the user paused it: leave it
    { id: 3, rect: { x: 5000, y: 0, w: 100, h: 100 }, playing: false, autoPaused: true },  // still away: nothing
  ];
  assert.deepEqual(V.decide(items, view, 0), [{ id: 1, op: 'resume' }]);
});
test('offscreen decisions are per tile', () => {
  const items = [
    { id: 'a', rect: { x: 10, y: 10, w: 100, h: 100 }, playing: true, autoPaused: false },
    { id: 'b', rect: { x: 9000, y: 10, w: 100, h: 100 }, playing: true, autoPaused: false },
  ];
  assert.deepEqual(V.decide(items, view, 0), [{ id: 'b', op: 'pause' }]);
});
