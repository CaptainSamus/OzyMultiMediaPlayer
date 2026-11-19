const test = require('node:test');
const assert = require('node:assert/strict');
const Favorites = require('./favorites');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('only favorite: true in a record counts', () => {
  assert.equal(Favorites.fromRecord({ favorite: true }), true);
  for (const v of [{ favorite: 'true' }, { favorite: 1 }, {}, null, undefined, 'x']) assert.equal(Favorites.fromRecord(v), false);
});

test('the list sorts by name, numbers in order, ties in board order', () => {
  const out = Favorites.sorted([
    { id: 'a', name: 'clip 10.mp4' }, { id: 'b', name: 'Clip 2.mp4' }, { id: 'c', name: 'alpha.mov' },
    { id: 'd', name: 'clip 2.mp4' },
  ]);
  assert.deepEqual(out.map((x) => x.id), ['c', 'b', 'd', 'a']);
  assert.deepEqual(Favorites.sorted(null), []);
});

test('the camera centres the tile and fills part of the view', () => {
  const view = { w: 1000, h: 600 };
  const cam = Favorites.camera({ x: 5000, y: -2000, w: 400, h: 225 }, view, { minZoom: 0.05, maxZoom: 4, fill: 0.6 });
  // limited by width: 600 / 400 = 1.5; height would allow 360 / 225 = 1.6
  near(cam.zoom, 1.5);
  // the tile's centre lands in the middle of the view
  near((5000 + 200) * cam.zoom + cam.panX, 500);
  near((-2000 + 112.5) * cam.zoom + cam.panY, 300);
});

test('the camera keeps to the zoom limits', () => {
  const view = { w: 1000, h: 600 };
  assert.equal(Favorites.camera({ x: 0, y: 0, w: 1, h: 1 }, view, { minZoom: 0.05, maxZoom: 4 }).zoom, 4);
  assert.equal(Favorites.camera({ x: 0, y: 0, w: 1e7, h: 1e7 }, view, { minZoom: 0.05, maxZoom: 4 }).zoom, 0.05);
});

test('the flight starts and ends where it should and never overshoots the zoom', () => {
  const view = { w: 800, h: 500 };
  const a = { zoom: 0.1, panX: 10, panY: 20 };
  const b = { zoom: 2, panX: -3000, panY: 400 };
  const s = Favorites.between(a, b, 0, view), e = Favorites.between(a, b, 1, view);
  near(s.zoom, a.zoom); near(s.panX, a.panX); near(s.panY, a.panY);
  near(e.zoom, b.zoom); near(e.panX, b.panX); near(e.panY, b.panY);
  let last = 0;
  for (let t = 0; t <= 1; t += 0.05) {
    const z = Favorites.between(a, b, t, view).zoom;
    assert.ok(z >= last - 1e-12 && z <= b.zoom + 1e-12);
    last = z;
  }
});

// ---- folders (2026-11-05) ----
test('folders: bad entries dropped, ids unique, names and colours cleaned', () => {
  const out = Favorites.folders([
    { id: 'f1', name: '  Hero shots ', color: '#3FB6FF' },
    { id: 'f1', name: 'dup' },
    null, 'x', { name: 'no id' }, { id: '' },
    { id: 'f2', name: '', color: 'red', open: false },
  ]);
  assert.deepEqual(out, [
    { id: 'f1', name: 'Hero shots', color: '#3fb6ff', open: true },
    { id: 'f2', name: 'Folder', color: Favorites.COLORS[1], open: false },
  ]);
  assert.deepEqual(Favorites.folders(undefined), []);
  assert.deepEqual(Favorites.folders('nope'), []);
});

test('newFolder: next free id, a numbered name and an unused colour', () => {
  const a = Favorites.newFolder([]);
  assert.deepEqual(a, { id: 'f1', name: 'Folder 1', color: Favorites.COLORS[0], open: true });
  const b = Favorites.newFolder([a]);
  assert.equal(b.id, 'f2'); assert.equal(b.name, 'Folder 2'); assert.equal(b.color, Favorites.COLORS[1]);
  const c = Favorites.newFolder([{ id: 'f2', name: 'Folder 2', color: Favorites.COLORS[0] }]);
  assert.equal(c.id, 'f1'); assert.equal(c.name, 'Folder 3'); assert.equal(c.color, Favorites.COLORS[1]);
  assert.equal(Favorites.newFolder([], '  Night ').name, 'Night');
  // every colour taken: round again
  const all = Favorites.COLORS.map((color, i) => ({ id: 'f' + (i + 1), name: 'n' + i, color }));
  assert.ok(Favorites.COLORS.includes(Favorites.newFolder(all).color));
});

test('folderOf: only a folder that exists', () => {
  const fs = [{ id: 'f1' }];
  assert.equal(Favorites.folderOf({ favorite: true, favFolder: 'f1' }, fs), 'f1');
  assert.equal(Favorites.folderOf({ favorite: true, favFolder: 'gone' }, fs), null);
  assert.equal(Favorites.folderOf({ favorite: true }, fs), null);
  assert.equal(Favorites.folderOf(null, fs), null);
});

test('sections: folders in order, each sorted by name, then the loose ones', () => {
  const fs = [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }];
  const items = [
    { id: '1', name: 'clip 10', folder: 'a' }, { id: '2', name: 'clip 2', folder: 'a' },
    { id: '3', name: 'x', folder: null }, { id: '4', name: 'y', folder: 'gone' },
  ];
  const s = Favorites.sections(items, fs);
  assert.deepEqual(s.map((x) => x.folder && x.folder.id), ['b', 'a', null]);
  assert.deepEqual(s[0].items, []);
  assert.deepEqual(s[1].items.map((i) => i.id), ['2', '1']);
  assert.deepEqual(s[2].items.map((i) => i.id), ['3', '4']); // a vanished folder's favorites are loose
  // no loose ones: no loose section; no folders: one (possibly empty) section
  assert.equal(Favorites.sections(items.slice(0, 2), fs).length, 2);
  assert.deepEqual(Favorites.sections([], []), [{ folder: null, items: [] }]);
});

test('bounds: the box round a folder\'s tiles', () => {
  assert.deepEqual(Favorites.bounds([{ x: 0, y: 10, w: 100, h: 50 }, { x: 200, y: -20, w: 10, h: 10 }, null]), { x: 0, y: -20, w: 210, h: 80 });
  assert.equal(Favorites.bounds([]), null);
  assert.equal(Favorites.bounds([null, { x: NaN, y: 0, w: 1, h: 1 }]), null);
});

test('quiet volume: never louder than it was, level clamped', () => {
  assert.equal(Favorites.quietVolume(0.8, 0.03), 0.03);
  assert.equal(Favorites.quietVolume(0.01, 0.03), 0.01); // already quieter: left alone
  assert.equal(Favorites.quietVolume(1, 0.9), Favorites.QUIET_MAX);
  assert.equal(Favorites.quietVolume(1, undefined), Favorites.QUIET);
  assert.equal(Favorites.quietVolume(1, -1), 0);
  assert.equal(Favorites.fade(0.8, 0.03, 0), 0.8);
  assert.equal(Favorites.fade(0.8, 0.03, 1), 0.03);
  near(Favorites.fade(0, 1, 0.25), 0.25);
});
