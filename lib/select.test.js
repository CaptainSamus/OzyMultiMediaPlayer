const test = require('node:test');
const assert = require('node:assert/strict');
const Select = require('./select');

test('shift toggles, whatever else is true', () => {
  assert.equal(Select.onPointerDown({ inSelection: false, grouped: true, sticky: true, mod: false, shift: true }), 'toggle');
  assert.equal(Select.onPointerDown({ inSelection: true, grouped: false, sticky: false, mod: true, shift: true }), 'toggle');
});
test('ctrl/cmd picks just this tile, even inside a sticky group', () => {
  assert.equal(Select.onPointerDown({ inSelection: false, grouped: true, sticky: true, mod: true, shift: false }), 'only');
});
test('a plain click on an ungrouped tile selects just it (the thing that was missing)', () => {
  assert.equal(Select.onPointerDown({ inSelection: false, grouped: false, sticky: false, mod: false, shift: false }), 'only');
});
test('a plain click on a non-sticky group member selects just it', () => {
  assert.equal(Select.onPointerDown({ inSelection: false, grouped: true, sticky: false, mod: false, shift: false }), 'only');
});
test('a plain click on a sticky member selects the whole group', () => {
  assert.equal(Select.onPointerDown({ inSelection: false, grouped: true, sticky: true, mod: false, shift: false }), 'group');
});
test('keeps a multi-selection on a plain click', () => {
  assert.equal(Select.onPointerDown({ inSelection: true, grouped: false, sticky: false, mod: false, shift: false }), 'keep');
  assert.equal(Select.onPointerDown({ inSelection: true, grouped: true, sticky: true, mod: false, shift: false }), 'keep');
});

// ---- dragSet: what moves (or scales) together when a tile is grabbed ----
const T = (name, group = null, board = true) => ({ name, group, board: board ? { x: 0, y: 0, w: 1, h: 1 } : null });
const G = (sticky, ...members) => { const g = { sticky, members: new Set(members) }; for (const m of members) m.group = g; return g; };
const names = (list) => list.map((t) => t.name).sort().join(',');

test('dragSet: Ctrl is just the grabbed tile, whatever is selected or grouped', () => {
  const a = T('a'), b = T('b'); G(true, a, b);
  assert.equal(names(Select.dragSet(a, [a, b], true)), 'a');
  assert.equal(names(Select.dragSet(a, [a, b], true, { keepSelected: true })), 'a');
});
test('dragSet: an unselected sticky member brings its whole group', () => {
  const a = T('a'), b = T('b'), c = T('c'); G(true, a, b);
  assert.equal(names(Select.dragSet(a, [], false)), 'a,b');
  assert.equal(names(Select.dragSet(a, [c], false)), 'a,b');   // someone else's selection is not grabbed
  assert.equal(names(Select.dragSet(c, [], false)), 'c');      // a loose unselected tile is alone
});
test('dragSet: a multi-selection of loose tiles goes together', () => {
  const a = T('a'), b = T('b'), c = T('c'), d = T('d');
  assert.equal(names(Select.dragSet(b, [a, b, c], false)), 'a,b,c');
  assert.equal(names(Select.dragSet(b, [a, b, c], false, { keepSelected: true })), 'a,b,c');
  assert.equal(names(Select.dragSet(d, [a, b, c], false)), 'd');
});
test('dragSet: a selection touching a sticky group takes every member of it', () => {
  const a = T('a'), b = T('b'), c = T('c'), x = T('x'); G(true, a, b, c);
  assert.equal(names(Select.dragSet(x, [x, a], false)), 'a,b,c,x');
  assert.equal(names(Select.dragSet(x, [x, a], false, { keepSelected: true })), 'a,b,c,x');
});
test('dragSet: a move leaves selected members of a non-sticky group behind, except the grabbed one', () => {
  const a = T('a'), b = T('b'), c = T('c'), x = T('x'); G(false, a, b, c);
  assert.equal(names(Select.dragSet(a, [a, b, c, x], false)), 'a,x');
  assert.equal(names(Select.dragSet(x, [a, b, c, x], false)), 'x');
});
test('dragSet keepSelected: a resize keeps every selected tile, non-sticky group or not', () => {
  const a = T('a'), b = T('b'), c = T('c'), x = T('x'); G(false, a, b, c);
  assert.equal(names(Select.dragSet(a, [a, b, c, x], false, { keepSelected: true })), 'a,b,c,x');
  assert.equal(names(Select.dragSet(a, [a, b], false, { keepSelected: true })), 'a,b');   // only what was selected: c is not pulled in
  assert.equal(names(Select.dragSet(a, [], false, { keepSelected: true })), 'a');           // nothing selected, not sticky: alone
});
test('dragSet: tiles that are not on the board are left out, the grabbed tile comes first', () => {
  const a = T('a'), b = T('b', null, false), c = T('c'), d = T('d', null, false); G(true, c, d);
  assert.equal(names(Select.dragSet(a, [a, b, c], false)), 'a,c');
  assert.equal(Select.dragSet(c, [a, c], false)[0], c);
});
test('dragSet keepSelected is what a move uses too: Sticky off only stops an unselected member dragging the rest', () => {
  const a = T('a'), b = T('b'), c = T('c'); G(false, a, b, c);
  const s1 = T('s1'), s2 = T('s2'); G(true, s1, s2);
  const move = (tile, selected, single = false) => names(Select.dragSet(tile, selected, single, Select.MOVE));
  assert.equal(move(a, [a, b, c]), 'a,b,c');          // lassoed non-sticky group: all of it
  assert.equal(move(a, []), 'a');                     // one unselected member: only it
  assert.equal(move(s1, []), 's1,s2');                // sticky group, nothing selected: whole group
  assert.equal(move(a, [a, b, s1]), 'a,b,s1,s2');     // mixed lasso: what is selected, plus the rest of the sticky group
  assert.equal(move(a, [a, b, c], true), 'a');        // Ctrl: one
  assert.deepEqual(Select.MOVE, Select.RESIZE);       // one rule for both gestures (Scott, 2026-10-07)
});
