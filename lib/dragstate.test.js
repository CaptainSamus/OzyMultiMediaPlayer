const test = require('node:test');
const assert = require('node:assert/strict');
const DragState = require('./dragstate');

test('nothing is showing until a drag arrives', () => {
  const d = DragState.create();
  assert.equal(d.tick(0), false);
  assert.equal(d.tick(10000), false);
});

test('a drag entering the window shows the overlay', () => {
  const d = DragState.create();
  assert.equal(d.enter(0), true);
  assert.equal(d.tick(100), true);
});

test('leaving hides it at once - there is no counter to balance', () => {
  const d = DragState.create();
  d.enter(0);
  assert.equal(d.leave(10), false);
  assert.equal(d.tick(20), false);
  // two enters and one leave used to leave the overlay stuck; now the leave is the last word
  const e = DragState.create();
  e.enter(0); e.enter(5);
  assert.equal(e.leave(10), false);
});

test('a drag still moving over the window keeps it up', () => {
  const d = DragState.create({ idleMs: 400 });
  d.enter(0);
  d.over(100);
  d.over(300);
  assert.equal(d.tick(650), true); // the last dragover was 350 ms ago
});

test('a drag that goes quiet is assumed to have ended somewhere we cannot see', () => {
  const d = DragState.create({ idleMs: 400 });
  d.enter(0);
  d.over(100);
  assert.equal(d.tick(300), true);
  assert.equal(d.tick(600), false); // 500 ms without a dragover: it ended inside an iframe
});

test('dragover alone is enough, even if the enter was missed', () => {
  const d = DragState.create({ idleMs: 400 });
  assert.equal(d.over(0), true);
  assert.equal(d.tick(100), true);
});

test('drop and end hide it immediately', () => {
  const d = DragState.create();
  d.enter(0);
  assert.equal(d.drop(), false);
  assert.equal(d.tick(10), false);
  d.enter(100);
  assert.equal(d.end(), false);
  assert.equal(d.tick(110), false);
});

test('the idle window is configurable', () => {
  const d = DragState.create({ idleMs: 50 });
  d.enter(0);
  assert.equal(d.tick(40), true);
  assert.equal(d.tick(60), false);
});
