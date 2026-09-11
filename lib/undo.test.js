const test = require('node:test');
const assert = require('node:assert/strict');
const Undo = require('./undo');
test('push, undo, redo, and the limit', () => {
  const h = Undo.create(3);
  for (let i = 1; i <= 5; i++) h.push({ n: i });
  assert.equal(h.size, 3);                 // oldest two dropped
  assert.deepEqual(h.undo(), { n: 5 });
  assert.deepEqual(h.undo(), { n: 4 });
  assert.deepEqual(h.redo(), { n: 4 });
  assert.deepEqual(h.undo(), { n: 4 });
  assert.deepEqual(h.undo(), { n: 3 });
  assert.equal(h.undo(), null);
});
test('a new push after undo discards the redo branch', () => {
  const h = Undo.create(10);
  h.push({ n: 1 }); h.push({ n: 2 }); h.undo(); h.push({ n: 3 });
  assert.equal(h.redo(), null);
  assert.deepEqual(h.undo(), { n: 3 });
  assert.deepEqual(h.undo(), { n: 1 });
});
test('clear empties both stacks', () => {
  const h = Undo.create(10); h.push({ n: 1 }); h.undo(); h.clear();
  assert.equal(h.undo(), null); assert.equal(h.redo(), null); assert.equal(h.size, 0);
});
