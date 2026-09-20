const test = require('node:test');
const assert = require('node:assert/strict');
const TextTile = require('./texttile');

test('DEFAULTS are the style every new text tile starts from', () => {
  assert.deepEqual(TextTile.DEFAULTS, {
    font: 'Segoe UI',
    size: 24,
    color: '#e8e8ea',
    align: 'left',
    bubble: false,
    fill: '#ffd166',
    outline: '#00000000',
    outlineWidth: 2,
  });
  assert.ok(TextTile.FONTS.includes('Segoe UI'));
  assert.equal(TextTile.FONTS.length, 10);
});

test('normalize with nothing to go on returns a fresh copy of the defaults', () => {
  const s = TextTile.normalize(undefined);
  assert.deepEqual(s, TextTile.DEFAULTS);
  assert.notEqual(s, TextTile.DEFAULTS); // a copy: editing one tile must not move the defaults
  s.size = 99;
  assert.equal(TextTile.DEFAULTS.size, 24);
  assert.deepEqual(TextTile.normalize(null), TextTile.DEFAULTS);
  assert.deepEqual(TextTile.normalize('nope'), TextTile.DEFAULTS);
});

test('normalize keeps known fonts and falls back for anything else', () => {
  assert.equal(TextTile.normalize({ font: 'Georgia' }).font, 'Georgia');
  assert.equal(TextTile.normalize({ font: 'Wingdings' }).font, 'Segoe UI');
  assert.equal(TextTile.normalize({ font: 42 }).font, 'Segoe UI');
});

test('normalize clamps size to 8..400 and defaults junk', () => {
  assert.equal(TextTile.normalize({ size: '900' }).size, 400);
  assert.equal(TextTile.normalize({ size: 1 }).size, 8);
  assert.equal(TextTile.normalize({ size: 'abc' }).size, 24);
  assert.equal(TextTile.normalize({ size: 36 }).size, 36);
});

test('normalize takes CSS hex colours only', () => {
  assert.equal(TextTile.normalize({ color: 'red' }).color, '#e8e8ea');
  assert.equal(TextTile.normalize({ color: '#ABC' }).color, '#ABC');
  assert.equal(TextTile.normalize({ color: '#11223344' }).color, '#11223344');
  assert.equal(TextTile.normalize({ fill: '#123456' }).fill, '#123456');
  assert.equal(TextTile.normalize({ fill: 'rgb(1,2,3)' }).fill, '#ffd166');
  assert.equal(TextTile.normalize({ outline: '#0f0' }).outline, '#0f0');
});

test('normalize takes the three alignments', () => {
  assert.equal(TextTile.normalize({ align: 'center' }).align, 'center');
  assert.equal(TextTile.normalize({ align: 'right' }).align, 'right');
  assert.equal(TextTile.normalize({ align: 'middle' }).align, 'left');
});

test('normalize coerces bubble to a boolean', () => {
  assert.equal(TextTile.normalize({ bubble: 'yes' }).bubble, true);
  assert.equal(TextTile.normalize({ bubble: 0 }).bubble, false);
  assert.equal(TextTile.normalize({ bubble: true }).bubble, true);
});

test('normalize clamps outline width to 0..20', () => {
  assert.equal(TextTile.normalize({ outlineWidth: -3 }).outlineWidth, 0);
  assert.equal(TextTile.normalize({ outlineWidth: 50 }).outlineWidth, 20);
  assert.equal(TextTile.normalize({ outlineWidth: 'abc' }).outlineWidth, 2);
  assert.equal(TextTile.normalize({ outlineWidth: 0 }).outlineWidth, 0);
});

test('sanitize gives a plain string with \\n newlines and a sane length', () => {
  assert.equal(TextTile.sanitize('a\r\nb'), 'a\nb');
  assert.equal(TextTile.sanitize('a\rb'), 'a\nb');
  assert.equal(TextTile.sanitize(null), '');
  assert.equal(TextTile.sanitize(undefined), '');
  assert.equal(TextTile.sanitize(12), '');
  assert.equal(TextTile.sanitize('hello'), 'hello');
  assert.equal(TextTile.sanitize('x'.repeat(30000)).length, 20000);
});
