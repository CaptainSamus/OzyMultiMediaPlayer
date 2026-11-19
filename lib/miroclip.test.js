const test = require('node:test');
const assert = require('node:assert/strict');
const MiroClip = require('./miroclip');

// what Miro writes: the JSON, every byte shifted, base64, in a span between the markers
function miroCopy(obj, shift = 59) {
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.from(plain.map((b) => (b + shift) % 256)).toString('base64');
  return `<meta charset="utf-8"><span data-meta="<--(miro-data-v1)${enc}(/miro-data-v1)-->"></span>`;
}
const board = {
  isProtected: false, boardId: 'uXjVOacP064=', version: 2,
  data: { objects: [
    { type: 14, id: 6, initialId: '3458764652494130040', widgetData: { type: 'image', json: { crop: { x: 1089.26, y: 0, width: 1982.74, height: 1728, shape: 'custom' }, resource: { id: 'r1', width: 3072, height: 1728 } } } },
    { type: 14, id: 7, initialId: '111', widgetData: { type: 'image', json: { crop: { x: 0, y: 0, width: 800, height: 600, shape: 'custom' }, resource: { width: 800, height: 600 } } } },
    { type: 5, id: 8, initialId: '222', widgetData: { type: 'shape', json: {} } },
    { type: 14, id: 9, initialId: '333', widgetData: { type: 'image', json: { resource: { width: 10, height: 10 } } } },
  ] },
};

test('decode: Miro\'s copy, whatever the shift', () => {
  for (const shift of [59, 1, 200]) {
    const d = MiroClip.decode(miroCopy(board, shift));
    assert.equal(d.boardId, 'uXjVOacP064=');
    assert.equal(d.objects.length, 4);
  }
});

test('decode: anything else is not a Miro copy', () => {
  assert.equal(MiroClip.decode('<img src="https://x.test/a.png">'), null);
  assert.equal(MiroClip.decode('(miro-data-v1)!!!not base64(/miro-data-v1)'), null);
  assert.equal(MiroClip.decode('(miro-data-v1)' + Buffer.from('hello world').toString('base64') + '(/miro-data-v1)'), null);
  assert.equal(MiroClip.decode(null), null);
});

test('crops: fractions of the original file, by the REST item id', () => {
  const c = MiroClip.crops(MiroClip.decode(miroCopy(board)));
  assert.equal(c.size, 2);
  const a = c.get('3458764652494130040');
  assert.ok(Math.abs(a.x - 1089.26 / 3072) < 1e-9 && Math.abs(a.w - 1982.74 / 3072) < 1e-9 && a.y === 0 && a.h === 1);
  assert.equal(a.shape, 'custom');
  assert.equal(MiroClip.isWhole(c.get('111')), true);
  assert.equal(MiroClip.isWhole(a), false);
  assert.equal(MiroClip.crops(null).size, 0);
});

test('info: layers in copy order, heights with their scale, text styles', () => {
  const copy = { boardId: 'b', data: { objects: [
    { initialId: '1', widgetData: { type: 'text', json: { scale: { scale: 10 }, size: { width: 13, height: 20 }, style: '{"st":14,"b":1,"i":0,"u":1,"s":0}' } } },
    { initialId: '2', widgetData: { type: 'shape', json: { scale: { scale: 1 }, size: { width: 50, height: 60 }, style: '{"st":3,"b":0}' } } },
    { initialId: '3', widgetData: { type: 'image', json: { crop: { x: 0, y: 0, width: 5, height: 5 }, resource: { width: 10, height: 10 } } } },
  ] } };
  const html = `(miro-data-v1)${Buffer.from(Buffer.from(JSON.stringify(copy)).map((x) => (x + 59) % 256)).toString('base64')}(/miro-data-v1)`;
  const i = MiroClip.info(MiroClip.decode(html));
  assert.deepEqual([...i.order], [['1', 0], ['2', 1], ['3', 2]]);
  assert.equal(i.heights.get('1'), 200);
  assert.equal(i.heights.get('2'), 60);
  assert.deepEqual(i.styles.get('1'), { bold: true, italic: false, underline: true, strike: false });
  assert.equal(i.styles.get('2').bold, false);
  assert.equal(i.crops.size, 1);
});

test('lines: loose ends, ends on items, bends, look; a loose end in a frame is still the board point', () => {
  const copy = { boardId: 'b', data: { objects: [
    { id: 7, initialId: '70', widgetData: { type: 'image', json: {} } },
    { id: 8, initialId: '80', widgetData: { type: 'frame', json: { width: 100, height: 50, _position: { offsetPx: { x: 1050, y: 2025 } } } } },
    { id: 9, initialId: '90', widgetData: { type: 'line', json: { _parent: null, points: [{ x: 5, y: 6 }],
      primary: { point: { x: 1, y: 2 }, widgetIndex: -1 }, secondary: { point: { x: 0, y: 0.5 }, widgetIndex: 7 },
      style: '{"lc":3355443,"ls":2,"t":24,"lt":2,"a_start":0,"a_end":9}' } } },
    { id: 10, initialId: '100', widgetData: { type: 'line', json: { _parent: { index: 8 }, points: [],
      primary: { point: { x: 10, y: 20 }, widgetIndex: -1 }, secondary: { point: { x: 30, y: 20 }, widgetIndex: -1 }, style: '{"lc":0,"t":2,"lt":0}' } } },
    { id: 11, initialId: '110', widgetData: { type: 'line', json: { primary: { point: { x: 0, y: 0 }, widgetIndex: 99 }, secondary: { point: { x: 1, y: 1 }, widgetIndex: -1 } } } },
  ] } };
  const html = `(miro-data-v1)${Buffer.from(Buffer.from(JSON.stringify(copy)).map((x) => (x + 59) % 256)).toString('base64')}(/miro-data-v1)`;
  const ls = MiroClip.info(MiroClip.decode(html)).lines;
  assert.equal(ls.length, 2); // the third is on an object that was not copied
  // an end on an item with no point: Miro places it (null: the side facing the other end)
  assert.deepEqual(ls[0], { id: '90', a: { x: 1, y: 2 }, b: { item: '70', fx: 0, fy: 0.5 }, via: [{ x: 5, y: 6 }], kind: 'elbow', width: 24, color: '#333333', dash: 'solid', start: 'none', end: 'arrow' });
  assert.deepEqual([ls[1].a, ls[1].b], [{ x: 10, y: 20 }, { x: 30, y: 20 }]);
  assert.equal(ls[1].kind, 'straight');
  assert.equal(ls[1].color, '#000000');
});
