const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Session = require('./session');

// the real files people may still have: one per historical shape, in test-fixtures/sessions
const dir = path.join(__dirname, '..', 'test-fixtures', 'sessions');
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, ''));
const FIXTURES = ['v3-original.mvp', 'v3-bom-crlf.mvp', 'v4-v0.0.2.mvp', 'v0.2.0.1.mvp', 'v0.2.0.3.mvp', 'v0.2.0.4.mvp'];

test('every historical fixture is recognised as a session', () => {
  for (const f of FIXTURES) assert.ok(Session.isSession(read(f)), f);
  assert.equal(Session.isSession(null), false);
  assert.equal(Session.isSession({}), false);
  assert.equal(Session.isSession({ videos: 'nope' }), false);
});

test('every video record in every fixture builds a tile', () => {
  for (const f of FIXTURES) {
    const data = read(f);
    const kinds = data.videos.map(Session.videoKind);
    assert.ok(kinds.every(Boolean), `${f}: ${JSON.stringify(kinds)}`);
  }
  // v3 has no type field at all: a bare path is a file tile
  assert.equal(Session.videoKind({ path: 'C:/x/a.mp4' }), 'file');
  assert.equal(Session.videoKind({ type: 'image', path: 'C:/x/a.jpg' }), 'image');
  assert.equal(Session.videoKind({ type: 'youtube', url: 'https://youtu.be/x' }), 'web');
  assert.equal(Session.videoKind({ type: 'sequence', dir: 'C:/x', seq: { name: 'shot' } }), 'sequence');
});

test('records too broken to build anything are dropped, not fatal', () => {
  for (const bad of [null, undefined, 'a string', 42, {}, { type: 'youtube' }, { type: 'sequence', dir: 'C:/x' }, { path: '' }]) {
    assert.equal(Session.videoKind(bad), null, JSON.stringify(bad));
  }
});

test('v3 layout: mode, rowHeight and linked survive; newer fields get defaults', () => {
  const L = Session.layout(read('v3-original.mvp').layout);
  assert.equal(L.mode, 'gallery');
  assert.equal(L.rowHeight, 300);
  assert.equal(L.linked, true);
  assert.equal(L.board, null);
  assert.equal(L.timeDisplay, 'clock');      // v3 never had it
  assert.equal(L.timelineHeight, 140);
  assert.equal(L.galleryScale, 1);
  assert.equal(L.timelineExpanded, false);
});

test('newer layouts keep what they saved', () => {
  const b = Session.layout(read('v4-v0.0.2.mvp').layout);
  assert.equal(b.mode, 'board');
  assert.deepEqual(b.board, { panX: 20, panY: 20, zoom: 1 });
  assert.equal(b.timeDisplay, 'timecode');
  const c = Session.layout(read('v0.2.0.1.mvp').layout);
  assert.equal(c.timelineExpanded, true);
  assert.equal(c.timelineHeight, 200);
  const e = Session.layout(read('v0.2.0.4.mvp').layout);
  assert.equal(e.galleryScale, 1.5);
});

test('a missing or nonsense layout still gives a usable one', () => {
  for (const raw of [undefined, null, {}, 'nope', { mode: 'sideways' }]) {
    const L = Session.layout(raw);
    assert.equal(L.mode, 'gallery');
    assert.equal(L.rowHeight, null);         // caller keeps its default and fits
    assert.equal(L.linked, true);
    assert.equal(L.board, null);
  }
});

test('absurd numbers are clamped rather than believed', () => {
  const L = Session.layout({ mode: 'board', rowHeight: 1e9, galleryScale: 1e6, timelineHeight: -5, board: { panX: 10, panY: 10, zoom: 1e6 } });
  assert.equal(L.rowHeight, Session.LIMITS.maxH);
  assert.equal(L.galleryScale, Session.LIMITS.maxScale);
  assert.equal(L.timelineHeight, 140);       // not positive, so the default
  assert.equal(L.board.zoom, Session.LIMITS.maxZoom);
  assert.equal(Session.masterVolume(99), 1);
  assert.equal(Session.masterVolume(-1), 0);
  assert.equal(Session.masterVolume('loud', 0.5), 0.5);
});

test('groups: the v4 fixture restores, and its sync starts come back', () => {
  const data = read('v4-v0.0.2.mvp');
  const gs = Session.groups(data.groups, (i) => i < data.videos.length);
  assert.equal(gs.length, 1);
  assert.deepEqual(gs[0].members, [0, 1]);
  assert.equal(gs[0].sync, true);
  assert.equal(gs[0].sticky, true);
  assert.equal(gs[0].loop, 'off');
  assert.equal(Session.syncStart(data.videos[1]), 1.25);
  assert.equal(Session.syncStart(data.videos[2]), 0);  // sync: null
  assert.equal(Session.syncStart({}), 0);
});

test('a null group entry is skipped instead of killing the load', () => {
  // this crashed with "Cannot read properties of null (reading 'members')" before the fix
  const gs = Session.groups([null, undefined, 'nonsense', { members: [0, 1] }], () => true);
  assert.equal(gs.length, 1);
  assert.deepEqual(gs[0].members, [0, 1]);
});

test('groups with too few usable members are dropped', () => {
  const known = (i) => [0, 1].includes(i);
  assert.equal(Session.groups([{ members: [] }], known).length, 0);
  assert.equal(Session.groups([{ members: [0] }], known).length, 0);
  assert.equal(Session.groups([{ members: [0, 9] }], known).length, 0);      // 9 never loaded
  assert.equal(Session.groups([{ members: [0, 1, 'x'] }], known)[0].members.length, 2);
  assert.equal(Session.groups(undefined, known).length, 0);                   // v3 has no groups
  assert.equal(Session.groups('nope', known).length, 0);
});

test('group settings are defaulted the same way every time', () => {
  const [g] = Session.groups([{ members: [0, 1] }], () => true);
  assert.equal(g.sync, false);
  assert.equal(g.sticky, true);
  assert.equal(g.loop, 'off');
  assert.equal(g.range, null);
  assert.equal(g.volume, 1);
  assert.equal(g.muted, false);
  assert.equal(g.rate, 1);
  assert.equal(g.id, null);
  const [h] = Session.groups([{ members: [0, 1], loop: 'sideways', rate: -2, volume: 9, range: { in: 'x', out: 2 }, id: 7 }], () => true);
  assert.equal(h.loop, 'off');
  assert.equal(h.rate, 1);
  assert.equal(h.volume, 1);
  assert.equal(h.range, null);
  assert.equal(h.id, 7);
});
