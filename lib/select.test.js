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
