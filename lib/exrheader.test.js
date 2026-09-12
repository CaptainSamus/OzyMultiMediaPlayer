const test = require('node:test');
const assert = require('node:assert/strict');
const ExrHeader = require('./exrheader');

// --- helpers that assemble real EXR header bytes ---
const i32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const chars = (s) => [...s].map((c) => c.charCodeAt(0));
const attr = (name, type, payload) => [...chars(name), 0, ...chars(type), 0, ...i32(payload.length), ...payload];
const chlist = (names) => {
  const out = [];
  for (const n of names) out.push(...chars(n), 0, ...i32(1), 0, 0, 0, 0, ...i32(1), ...i32(1)); // pixelType, pLinear+reserved, sampling
  out.push(0);
  return out;
};
const channelsAttr = (names) => attr('channels', 'chlist', chlist(names));
const nameAttr = (n) => attr('name', 'string', chars(n));
const compressionAttr = () => attr('compression', 'compression', [3]); // an attribute we skip over
const file = (body, { multi = false } = {}) => Uint8Array.from([...i32(ExrHeader.MAGIC), ...i32(multi ? 2 | 0x800 : 2), ...body]);

test('single part with R G B A: one layer, the base one', () => {
  const r = ExrHeader.parse(file([...compressionAttr(), ...channelsAttr(['R', 'G', 'B', 'A']), 0]));
  assert.equal(r.parts.length, 1);
  assert.deepEqual(r.parts[0].channels, ['R', 'G', 'B', 'A']);
  assert.deepEqual(r.parts[0].layers, ['']);
  assert.equal(r.parts[0].name, '');
});
test('named layers come out in order, with the base layer first', () => {
  const r = ExrHeader.parse(file([...channelsAttr(['R', 'G', 'B', 'specular.R', 'diffuse.R', 'diffuse.G', 'diffuse.B', 'specular.G']), 0]));
  assert.deepEqual(r.parts[0].layers, ['', 'diffuse', 'specular']);
});
test('a nested layer name keeps everything before the last dot', () => {
  const r = ExrHeader.parse(file([...channelsAttr(['light1.diffuse.R', 'light1.diffuse.G', 'Z']), 0]));
  assert.deepEqual(r.parts[0].layers, ['', 'light1.diffuse']); // Z is a base channel
});
test('multi-part file: a part each, with names and layers', () => {
  const beauty = [...nameAttr('beauty'), ...channelsAttr(['R', 'G', 'B', 'A'])];
  const depth = [...nameAttr('depth'), ...channelsAttr(['Z', 'mask.A'])];
  const r = ExrHeader.parse(file([...beauty, 0, ...depth, 0, 0], { multi: true }));
  assert.equal(r.parts.length, 2);
  assert.deepEqual(r.parts.map((p) => p.name), ['beauty', 'depth']);
  assert.deepEqual(r.parts[0].layers, ['']);
  assert.deepEqual(r.parts[1].layers, ['', 'mask']);
  assert.deepEqual(ExrHeader.layers(r), [[''], ['', 'mask']]);
});
test('truncated, empty and foreign files give null instead of throwing', () => {
  const good = file([...channelsAttr(['R', 'G', 'B']), 0]);
  assert.equal(ExrHeader.parse(good.subarray(0, good.length - 12)), null);
  assert.equal(ExrHeader.parse(good.subarray(0, 6)), null);
  assert.equal(ExrHeader.parse(new Uint8Array(0)), null);
  assert.equal(ExrHeader.parse(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), null); // wrong magic
  assert.equal(ExrHeader.parse(null), null);
});
test('layerLabel names the base layer', () => {
  assert.equal(ExrHeader.layerLabel(''), 'RGBA (base)');
  assert.equal(ExrHeader.layerLabel('diffuse'), 'diffuse');
});
