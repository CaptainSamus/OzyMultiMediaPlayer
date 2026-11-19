const test = require('node:test');
const assert = require('node:assert');
const TD = require('./todolist.js');

// a goal with two tasks; the first has two sub-tasks
const sample = () => TD.normalize({ title: 'Ship the trailer', color: '#E24B4A', items: [
  { id: 'a', text: 'Edit', kids: [{ id: 'a1', text: 'Rough cut', done: true }, { id: 'a2', text: 'Fine cut' }] },
  { id: 'b', text: 'Music' },
] });
const ids = (m) => TD.visible(m.items).map((v) => '  '.repeat(v.depth) + v.item.id);

test('normalize keeps the tree, fixes ids, colours and the done state of goals', () => {
  const m = sample();
  assert.strictEqual(m.title, 'Ship the trailer');
  assert.strictEqual(m.color, '#e24b4a');
  assert.deepStrictEqual(ids(m), ['a', '  a1', '  a2', 'b']);
  assert.strictEqual(m.items[0].done, false); // one of its sub-tasks is not done
  const d = TD.normalize({ items: [{ id: 'x', color: 'red', kids: [{ id: 'x', done: true }] }] });
  assert.deepStrictEqual(TD.visible(d.items).map((v) => v.item.id), ['x', 'xx']);
  assert.strictEqual(d.items[0].color, '');
  assert.strictEqual(d.items[0].done, true); // all its sub-tasks are done
  assert.deepStrictEqual(TD.normalize(null), { title: 'To-do', color: '', items: [] });
});

test('normalize lifts anything deeper than the limit to the last level', () => {
  let deep = { id: 'n0', kids: [] }, cur = deep;
  for (let i = 1; i < 16; i++) { const n = { id: 'n' + i, kids: [] }; cur.kids.push(n); cur = n; }
  const m = TD.normalize({ items: [deep] });
  assert.strictEqual(TD.count(m.items), 16);
  assert.ok(Math.max(...TD.visible(m.items).map((v) => v.depth)) <= TD.MAX_DEPTH - 1);
});

test('ticking a goal ticks everything under it; the last sub-task ticks its goal', () => {
  const m = sample();
  TD.toggle(m, 'a2');
  assert.strictEqual(m.items[0].done, true);
  TD.toggle(m, 'a1');
  assert.strictEqual(m.items[0].done, false);
  TD.toggle(m, 'a', true);
  assert.deepStrictEqual(m.items[0].kids.map((k) => k.done), [true, true]);
  TD.toggle(m, 'a');
  assert.deepStrictEqual(m.items[0].kids.map((k) => k.done), [false, false]);
  assert.strictEqual(TD.toggle(m, 'nope'), false);
});

test('adding after, before, as a sub-task, and as the first sub-task', () => {
  const m = sample();
  const n1 = TD.addAfter(m, 'b', 'Sound');
  const n2 = TD.addChild(m, 'b', 'Pick track');
  const n3 = TD.addAfter(m, 'a', 'Notes', { asFirstChild: true });
  const n4 = TD.addBefore(m, 'a', 'Plan');
  const n5 = TD.addAfter(m, null, 'At the end');
  assert.deepStrictEqual(ids(m), [n4, 'a', '  ' + n3, '  a1', '  a2', 'b', '  ' + n2, n1, n5]);
  assert.strictEqual(TD.find(m.items, n2).parent.id, 'b');
});

test('indent puts a task under the one above; outdent puts it back after its goal', () => {
  const m = sample();
  assert.strictEqual(TD.indent(m, 'a'), false); // nothing above it
  assert.strictEqual(TD.indent(m, 'b'), true);
  assert.deepStrictEqual(ids(m), ['a', '  a1', '  a2', '  b']);
  assert.strictEqual(TD.indent(m, 'b'), true);
  assert.deepStrictEqual(ids(m), ['a', '  a1', '  a2', '    b']);
  assert.strictEqual(m.items[0].kids[1].done, false);
  assert.strictEqual(TD.outdent(m, 'b'), true);
  assert.strictEqual(TD.outdent(m, 'b'), true);
  assert.strictEqual(TD.outdent(m, 'b'), false); // already at the top
  assert.deepStrictEqual(ids(m), ['a', '  a1', '  a2', 'b']);
  assert.strictEqual(TD.depthOf(m.items, 'a2'), 1);
});

test('move, remove (with its sub-tasks), text, colour and folding', () => {
  const m = sample();
  assert.strictEqual(TD.move(m, 'a2', -1), true);
  assert.deepStrictEqual(m.items[0].kids.map((k) => k.id), ['a2', 'a1']);
  assert.strictEqual(TD.move(m, 'a2', -1), false);
  assert.strictEqual(TD.setText(m, 'b', 'Score'), true);
  assert.strictEqual(TD.setText(m, 'b', 'Score'), false);
  TD.setColor(m, 'b', '#123ABC');
  assert.strictEqual(m.items[1].color, '#123abc');
  assert.strictEqual(TD.setOpen(m, 'a', false), true);
  assert.deepStrictEqual(ids(m), ['a', 'b']);
  assert.strictEqual(TD.setOpen(m, 'b'), false); // nothing to fold
  TD.setAllOpen(m, true);
  assert.deepStrictEqual(TD.neighbour(m.items, 'a1', 1), 'b');
  assert.deepStrictEqual(TD.neighbour(m.items, 'a', -1), null);
  TD.remove(m, 'a');
  assert.deepStrictEqual(ids(m), ['b']);
});

test('progress counts the real tasks; clearDone and uncheckAll', () => {
  const m = sample();
  assert.deepStrictEqual(TD.progress(m.items), { done: 1, total: 3 });
  TD.toggle(m, 'b');
  assert.deepStrictEqual(TD.progress(m.items), { done: 2, total: 3 });
  assert.strictEqual(TD.clearDone(m), 2); // a1 and b
  assert.deepStrictEqual(ids(m), ['a', '  a2']);
  TD.toggle(m, 'a2');
  TD.uncheckAll(m);
  assert.deepStrictEqual(TD.progress(m.items), { done: 0, total: 1 });
});

test('summary and fromText (pasted lists, with their levels and ticks)', () => {
  const m = sample();
  assert.strictEqual(TD.summary(m), 'Ship the trailer\n☐ Edit\n  ☑ Rough cut\n  ☐ Fine cut\n☐ Music');
  const items = TD.fromText('- Edit\n  - [x] Rough cut\n  - [ ] Fine cut\n\n* Music\n\t1. Pick track\n☑ Done thing');
  const v = TD.visible(items).map((x) => '  '.repeat(x.depth) + (x.item.done ? '[x] ' : '') + x.item.text);
  assert.deepStrictEqual(v, ['Edit', '  [x] Rough cut', '  Fine cut', 'Music', '  Pick track', '[x] Done thing']);
});
