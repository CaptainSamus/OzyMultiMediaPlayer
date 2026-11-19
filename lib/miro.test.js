const test = require('node:test');
const assert = require('node:assert/strict');
const Miro = require('./miro');
const TextTile = require('./texttile');

test('boardId: from a board link or the bare id', () => {
  assert.equal(Miro.boardId('https://miro.com/app/board/uXjVKabc123=/?share_link_id=99'), 'uXjVKabc123=');
  assert.equal(Miro.boardId('miro.com/app/board/uXjVKabc123%3D/'), 'uXjVKabc123=');
  assert.equal(Miro.boardId('  uXjVKabc123=  '), 'uXjVKabc123=');
  assert.equal(Miro.boardId('https://example.com/nothing here'), null);
  assert.equal(Miro.boardId(''), null);
});

test('plainText: paragraphs, breaks, lists and entities', () => {
  assert.equal(Miro.plainText('<p>Hello <strong>world</strong></p><p>Line&nbsp;two &amp; more</p>'), 'Hello world\nLine two & more');
  assert.equal(Miro.plainText('a<br>b<br/>c'), 'a\nb\nc');
  assert.equal(Miro.plainText('<ul><li>one</li><li>two</li></ul>'), '• one\n• two');
  assert.equal(Miro.plainText('&#39;quoted&#x27; &lt;tag&gt;'), "'quoted' <tag>");
  assert.equal(Miro.plainText(null), '');
});

test('boxes: centre to top-left, and children placed from their frame\'s corner', () => {
  const items = [
    { id: 'f', type: 'frame', position: { x: 1000, y: 500, relativeTo: 'canvas_center' }, geometry: { width: 800, height: 600 } },
    { id: 'a', type: 'image', parent: { id: 'f' }, position: { x: 100, y: 50, relativeTo: 'parent_top_left' }, geometry: { width: 200, height: 100 } },
    { id: 'b', type: 'text', position: { x: 0, y: 0 }, geometry: { width: 300, rotation: 30 } },
    { id: 'c', type: 'image', parent: { id: 'gone' }, position: { x: 10, y: 10, relativeTo: 'parent_top_left' }, geometry: { width: 20, height: 20 } },
  ];
  const b = Miro.boxes(items);
  assert.deepEqual(b.get('f'), { x: 600, y: 200, w: 800, h: 600, rotation: 0 });
  assert.deepEqual(b.get('a'), { x: 600 + 100 - 100, y: 200 + 50 - 50, w: 200, h: 100, rotation: 0 });
  const tb = b.get('b'); // only a width: one line at 14 px, Miro's 1.4 line height
  assert.ok(Math.abs(tb.h - 19.6) < 1e-9 && Math.abs(tb.y + 9.8) < 1e-9 && tb.x === -150 && tb.w === 300 && tb.rotation === 30, JSON.stringify(tb));
  assert.deepEqual(b.get('c'), { x: 0, y: 0, w: 20, h: 20, rotation: 0 }); // its frame is missing
});

test('boxes: a parent loop does not hang', () => {
  const items = [
    { id: 'x', type: 'frame', parent: { id: 'y' }, position: { x: 0, y: 0, relativeTo: 'parent_top_left' }, geometry: { width: 10, height: 10 } },
    { id: 'y', type: 'frame', parent: { id: 'x' }, position: { x: 0, y: 0, relativeTo: 'parent_top_left' }, geometry: { width: 10, height: 10 } },
  ];
  const b = Miro.boxes(items);
  assert.equal(b.size, 2);
});

test('imageLinks: the original and the preview, both without a redirect', () => {
  const l = Miro.imageLinks({ data: { imageUrl: 'https://api.miro.com/v2/boards/b/resources/images/123?format=preview&redirect=false' } });
  assert.equal(new URL(l.original).searchParams.get('format'), 'original');
  assert.equal(new URL(l.original).searchParams.get('redirect'), 'false');
  assert.equal(new URL(l.preview).searchParams.get('format'), 'preview');
  assert.equal(Miro.imageLinks({ data: {} }), null);
  assert.equal(Miro.imageLinks({ data: { imageUrl: 'not a url' } }), null);
});

test('fileName: from the title, safe and unique', () => {
  const taken = new Set();
  assert.equal(Miro.fileName({ id: 1, data: { title: 'Artist: portrait?.png' } }, '.png', taken), 'Artist portrait.png');
  assert.equal(Miro.fileName({ id: 2, data: { title: 'artist portrait.PNG' } }, '.png', taken), 'artist portrait (2).png');
  assert.equal(Miro.fileName({ id: 3, data: {} }, '.jpg', taken), 'image-3.jpg');
  assert.equal(Miro.fileName({ id: 4, data: { title: 'CON' } }, '.jpg', taken), 'image-4.jpg');
});

test('extFor: content type first, then the link', () => {
  assert.equal(Miro.extFor('image/jpeg; charset=x', ''), '.jpg');
  assert.equal(Miro.extFor('image/png', ''), '.png');
  assert.equal(Miro.extFor('application/octet-stream', 'https://s3/x/photo.JPEG?sig=1'), '.jpg');
  assert.equal(Miro.extFor('', 'https://s3/x/noext'), '.jpg');
});

test('colour: hex, sticky names, transparent', () => {
  assert.equal(Miro.colour('#FFF'), '#ffffff');
  assert.equal(Miro.colour('light_yellow'), '#fff9b1');
  assert.equal(Miro.colour('transparent', '#123456'), null);
  assert.equal(Miro.colour(undefined, '#123456'), '#123456');
  assert.equal(Miro.font('open_sans'), 'Segoe UI');
  assert.equal(Miro.font('who_knows'), 'Segoe UI');
});

const board = [
  { id: 'fr', type: 'frame', data: { title: 'Painters' }, style: { fillColor: '#ffffff' }, position: { x: 0, y: 0 }, geometry: { width: 2000, height: 1000 } },
  { id: 'im', type: 'image', parent: { id: 'fr' }, data: { title: 'a.jpg', imageUrl: 'https://api.miro.com/x?format=preview' }, position: { x: 300, y: 200, relativeTo: 'parent_top_left' }, geometry: { width: 400, height: 300 } },
  { id: 'lost', type: 'image', data: { imageUrl: 'https://api.miro.com/y' }, position: { x: 0, y: 0 }, geometry: { width: 10, height: 10 } },
  { id: 'tx', type: 'text', data: { content: '<p>Monet</p>' }, style: { fontSize: '48', color: '#1a1a1a', textAlign: 'center', fontFamily: 'arial' }, position: { x: 0, y: 0 }, geometry: { width: 300 } },
  { id: 'st', type: 'sticky_note', data: { content: '<p>todo</p>' }, style: { fillColor: 'light_pink' }, position: { x: 0, y: 0 }, geometry: { width: 200, height: 230 } },
  { id: 'sh', type: 'shape', data: { shape: 'circle', content: '' }, style: { fillColor: '#ff0000', fillOpacity: '0.5', borderColor: '#000000', borderWidth: '4' }, position: { x: 0, y: 0 }, geometry: { width: 100, height: 100 } },
  { id: 'tri', type: 'shape', data: { shape: 'triangle' }, style: {}, position: { x: 0, y: 0 }, geometry: { width: 100, height: 100 } },
  { id: 'yt', type: 'embed', data: { url: 'https://www.youtube.com/watch?v=abc' }, position: { x: 0, y: 0 }, geometry: { width: 320, height: 180 } },
  { id: 'pen', type: 'drawing', position: { x: 0, y: 0 }, geometry: { width: 1, height: 1 } },
];

test('toRecords: kinds, layers and what was left out', () => {
  const files = new Map([['im', { path: 'D:/imp/images/a.jpg', thumb: 'D:/imp/images/previews/a.jpg' }]]);
  const { records, report } = Miro.toRecords(board, files, { youtube: (u) => (u.includes('youtube') ? { kind: 'video' } : null) });
  // frames at the back, text on top
  assert.equal(records[0].id, 'miro-fr');
  assert.equal(records[records.length - 1].id, 'miro-tx');
  const im = records.find((r) => r.id === 'miro-im');
  assert.deepEqual(im.board, { x: -1000 + 300 - 200, y: -500 + 200 - 150, w: 400, h: 300 });
  assert.equal(im.type, 'image'); assert.equal(im.thumb, 'D:/imp/images/previews/a.jpg');
  const tx = records.find((r) => r.id === 'miro-tx');
  assert.equal(tx.text, 'Monet'); assert.equal(tx.style.size, 48); assert.equal(tx.style.font, 'Arial'); assert.equal(tx.style.bubble, false);
  const st = records.find((r) => r.id === 'miro-st');
  assert.equal(st.style.fill, '#ffcee0'); assert.equal(st.style.box, 'fixed'); assert.equal(st.style.fit, true);
  const sh = records.find((r) => r.id === 'miro-sh');
  assert.equal(sh.style.shape, 'ellipse'); assert.equal(sh.style.fill, '#ff000080'); assert.equal(sh.style.outlineWidth, 4);
  assert.equal(records.find((r) => r.id === 'miro-yt').type, 'youtube');
  assert.equal(report.made.image, 1);
  assert.equal(report.missingImages, 1);
  assert.equal(report.skipped.drawing, 1);
  // assert.equal(report.made['shape (drawn as a box: triangle)'], 1); // DISABLED (2026-11-15): triangles are drawn as triangles now
  assert.equal(records.find((r) => r.style && r.style.shape === 'triangle').type, 'text');
  const fr = records.find((r) => r.id === 'miro-fr');
  assert.ok(fr.frame && typeof fr.frame.title === 'string'); // a real frame, its title its own
  assert.ok(!records.some((r) => /-title$/.test(r.id)));
  // every text style survives Ozy's own clean-up unchanged
  for (const r of records.filter((x) => x.type === 'text')) assert.deepEqual(TextTile.normalize(r.style), { ...TextTile.normalize({}), ...r.style }, r.id);
  assert.match(Miro.describe(report, 3), /3 arrows/);
});

// ---- scale, crops and rotation (2026-11-06: Mark's "Character list" board) ----
test('importScale: a huge board comes in smaller, an Ozy-sized one as it is', () => {
  const img = (h) => ({ id: String(h) + Math.random(), type: 'image', geometry: { width: h, height: h } });
  assert.equal(Miro.importScale([img(500), img(600), img(700)]), 1);
  const k = Miro.importScale([img(4000), img(6000), img(8000)]);
  assert.ok(Math.abs(k - Miro.SCALE_TARGET / 6000) < 0.001, String(k));
  assert.equal(Miro.importScale([]), 1);
});
test('centreCrop: the middle of the file, in the board shape', () => {
  assert.equal(Miro.centreCrop(1.5, 1500, 1000), null); // same shape: not cropped
  const tall = Miro.centreCrop(0.5, 1000, 1000); // board half as wide as the file's square
  assert.deepEqual(tall, { x: 0.25, y: 0, w: 0.5, h: 1, guessed: true });
  const wide = Miro.centreCrop(2, 1000, 1000);
  assert.deepEqual(wide, { x: 0, y: 0.25, w: 1, h: 0.5, guessed: true });
});
test('toRecords: scaled together, cropped pictures and turned items kept', () => {
  const items = [
    { id: 'a', type: 'image', data: { imageUrl: 'https://api.miro.com/x' }, position: { x: 10000, y: 0 }, geometry: { width: 3000, height: 6000, rotation: 15 } },
    { id: 'b', type: 'image', data: { imageUrl: 'https://api.miro.com/y' }, position: { x: 0, y: 0 }, geometry: { width: 6000, height: 6000 } },
    { id: 't', type: 'text', data: { content: '<p>Hi</p>' }, style: { fontSize: '600' }, position: { x: 0, y: 5000 }, geometry: { width: 3000 } },
  ];
  const files = new Map([['a', { path: 'a.png', size: { w: 1000, h: 1000 } }], ['b', { path: 'b.png', size: { w: 800, h: 800 } }]]);
  const { records, report } = Miro.toRecords(items, files);
  const k = report.scale;
  assert.ok(k < 1);
  const a = records.find((r) => r.id === 'miro-a'), b = records.find((r) => r.id === 'miro-b'), t = records.find((r) => r.id === 'miro-t');
  assert.ok(Math.abs(a.board.w - 3000 * k) < 1e-6 && Math.abs(a.board.x - (10000 - 1500) * k) < 1e-6);
  assert.deepEqual(a.crop, { x: 0.25, y: 0, w: 0.5, h: 1, guessed: true });
  assert.equal(a.rotation, 15);
  assert.equal(b.crop, undefined); assert.equal(b.rotation, undefined);
  assert.ok(Math.abs(t.style.size - 600 * k) < 1e-6);
  assert.equal(report.cropped, 1);
  assert.match(Miro.describe(report), /show.? the middle of the picture/);
  assert.match(Miro.describe(report), /scaled to/);
});
test('toRecords: a crop worked out from a screenshot wins over the middle', () => {
  const items = [{ id: 'a', type: 'image', data: { imageUrl: 'https://api.miro.com/x' }, position: { x: 0, y: 0 }, geometry: { width: 300, height: 600 } }];
  const files = new Map([['a', { path: 'a.png', size: { w: 1000, h: 1000 } }]]);
  const { records, report } = Miro.toRecords(items, files, { crops: new Map([['a', { x: 0.05, y: 0, w: 0.5, h: 1, score: 0.97 }]]) });
  assert.deepEqual(records[0].crop, { x: 0.05, y: 0, w: 0.5, h: 1 });
  assert.equal(report.cropsKnown, 1);
  assert.match(Miro.describe(report), /cropped as in Miro \(worked out from screenshots/);
  assert.deepEqual(Miro.cleanCrop({ x: 0.9, y: -1, w: 0.5, h: 2 }), { x: 0.5, y: 0, w: 0.5, h: 1 });
});
test('toRecords: Miro\'s own crop is used as it is, and a whole-picture crop means no crop', () => {
  const items = [
    { id: 'a', type: 'image', data: { imageUrl: 'https://api.miro.com/x' }, position: { x: 0, y: 0 }, geometry: { width: 400, height: 400 } }, // same shape as its file, but zoomed in
    { id: 'b', type: 'image', data: { imageUrl: 'https://api.miro.com/y' }, position: { x: 0, y: 0 }, geometry: { width: 400, height: 200 } },
  ];
  const files = new Map([['a', { path: 'a.png', size: { w: 1000, h: 1000 } }], ['b', { path: 'b.png', size: { w: 1000, h: 1000 } }]]);
  const crops = new Map([['a', { x: 0.1, y: 0.2, w: 0.3, h: 0.3, source: 'miro', score: 1 }], ['b', { x: 0, y: 0, w: 1, h: 1, source: 'miro', score: 1 }]]);
  const { records, report } = Miro.toRecords(items, files, { crops });
  assert.deepEqual(records.find((r) => r.id === 'miro-a').crop, { x: 0.1, y: 0.2, w: 0.3, h: 0.3 });
  assert.equal(records.find((r) => r.id === 'miro-b').crop, undefined); // Miro shows all of it
  assert.equal(report.cropsFromMiro, 1);
  assert.match(Miro.describe(report), /exactly as in Miro \(read from what you copied in Miro\)/);
});

// ---- Miro's copy of the board: its layers, heights and text styles (2026-11-10) ----
test('toRecords with Miro\'s copy: Miro\'s layer order, real text heights, bold from the copy or the text', () => {
  const at = (id, type, extra = {}) => ({ id, type, position: { x: 0, y: 0 }, geometry: { width: 100, height: 100 }, ...extra });
  const items = [
    at('big', 'shape', { data: { shape: 'rectangle', content: '' }, style: {}, geometry: { width: 1000, height: 1000 } }),
    at('t', 'text', { data: { content: '<p><strong>Title</strong></p>' }, style: { fontSize: '40' }, geometry: { width: 300 } }),
    at('t2', 'text', { data: { content: '<p>plain</p>' }, style: { fontSize: '40' }, geometry: { width: 300 } }),
    at('small', 'shape', { data: { shape: 'rectangle', content: '' }, style: {} }),
  ];
  // Miro stacks the text BEHIND the big shape here; the small shape is at the very back
  const copy = { order: new Map([['small', 0], ['t', 1], ['big', 2], ['t2', 3]]), heights: new Map([['t', 130]]), styles: new Map([['t2', { bold: false, italic: true, underline: false, strike: false }]]) };
  const { records, report } = Miro.toRecords(items, new Map(), { copy, scale: 1 });
  assert.deepEqual(records.map((r) => r.id), ['miro-small', 'miro-t', 'miro-big', 'miro-t2']);
  assert.equal(report.layersFromMiro, true);
  const t = records.find((r) => r.id === 'miro-t');
  assert.equal(t.board.h, 130); assert.equal(t.board.y, -65); // placed from its real middle
  assert.equal(t.style.bold, true);
  assert.equal(records.find((r) => r.id === 'miro-t2').style.italic, true);
  // without the copy: Ozy's own guess (shapes bigger behind smaller, text on top)
  const guess = Miro.toRecords(items, new Map(), { scale: 1 }).records.map((r) => r.id);
  assert.deepEqual(guess.slice(-2).sort(), ['miro-t', 'miro-t2']);
});

test('linePoints: loose ends through the shift, ends on items, elbows and curves routed', () => {
  const boxes = new Map([['pic', { x: 100, y: 100, w: 50, h: 40 }]]);
  const shift = { x: 1000, y: 2000 };
  // straight, loose to loose, with a bend
  assert.deepEqual(Miro.linePoints({ a: { x: 1000, y: 2000 }, b: { x: 1100, y: 2000 }, via: [{ x: 1050, y: 2010 }], kind: 'straight' }, { boxes, shift }),
    [{ x: 0, y: 0 }, { x: 50, y: 10 }, { x: 100, y: 0 }]);
  // an elbow leaving the picture's left side: level first, then down to the loose end
  assert.deepEqual(Miro.linePoints({ a: { item: 'pic', fx: 0, fy: 0.5 }, b: { x: 1000 + 20, y: 2000 + 300 }, via: [], kind: 'elbow' }, { boxes, shift }),
    [{ x: 100, y: 120 }, { x: 20, y: 120 }, { x: 20, y: 300 }]);
  // a curve: many points, from one end to the other
  const c = Miro.linePoints({ a: { x: 1000, y: 2000 }, b: { item: 'pic', fx: 0.5, fy: 0 }, kind: 'curve' }, { boxes, shift });
  assert.ok(c.length > 10);
  assert.deepEqual(c[0], { x: 0, y: 0 });
  assert.ok(Math.abs(c[c.length - 1].x - 125) < 1e-9 && Math.abs(c[c.length - 1].y - 100) < 1e-9);
  // an end that cannot be placed
  assert.equal(Miro.linePoints({ a: { item: 'gone', fx: 0, fy: 0 }, b: { x: 0, y: 0 }, kind: 'straight' }, { boxes, shift }), null);
  assert.equal(Miro.linePoints({ a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, kind: 'straight' }, { boxes, shift: null }), null);
});

test('toRecords with Miro\'s copy: lines and arrows in Miro\'s order, scaled with the board', () => {
  const items = [
    { id: 'p1', type: 'shape', data: { shape: 'rectangle', content: '' }, style: {}, position: { x: 0, y: 0 }, geometry: { width: 100, height: 100 } },
    { id: 'p2', type: 'shape', data: { shape: 'rectangle', content: '' }, style: {}, position: { x: 500, y: 0 }, geometry: { width: 100, height: 100 } },
    { id: 'p3', type: 'shape', data: { shape: 'rectangle', content: '' }, style: {}, position: { x: 0, y: 500 }, geometry: { width: 100, height: 100 } },
  ];
  const positions = new Map([['p1', { x: 10, y: 20 }], ['p2', { x: 510, y: 20 }], ['p3', { x: 10, y: 520 }]]); // copy = API + (10, 20)
  const lines = [
    { id: 'L', a: { x: 10 - 50, y: 20 + 300 }, b: { x: 10 + 550, y: 20 + 300 }, via: [], kind: 'straight', width: 24, color: '#1a1a1a', dash: 'solid', start: 'none', end: 'none' },
    { id: 'A', a: { item: 'p1', fx: 1, fy: 0.5 }, b: { item: 'p2', fx: 0, fy: 0.5 }, via: [], kind: 'straight', width: 2, color: '#333333', dash: 'solid', start: 'none', end: 'arrow' },
    { id: 'X', a: { item: 'nope', fx: 1, fy: 0.5 }, b: { x: 0, y: 0 }, via: [], kind: 'straight', width: 2, color: '#333333', dash: 'solid', start: 'none', end: 'none' },
  ];
  const copy = { order: new Map([['p1', 0], ['L', 1], ['p2', 2], ['A', 3], ['p3', 4]]), heights: new Map(), styles: new Map(), positions, frames: [], lines };
  const { records, report } = Miro.toRecords(items, new Map(), { copy, scale: 0.5 });
  assert.deepEqual(records.map((r) => r.id), ['miro-p1', 'miro-L', 'miro-p2', 'miro-A', 'miro-p3']);
  const L = records.find((r) => r.id === 'miro-L');
  assert.equal(L.type, 'line');
  assert.equal(L.style.width, 12);
  const LineTile = require('./linetile.js');
  const ends = LineTile.toAbs(L.board, L.points);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  near(ends[0].x, -25); near(ends[0].y, 150); near(ends[1].x, 275); near(ends[1].y, 150);
  const A = LineTile.toAbs(records.find((r) => r.id === 'miro-A').board, records.find((r) => r.id === 'miro-A').points);
  near(A[0].x, 25); near(A[0].y, 0); near(A[1].x, 225);
  assert.deepEqual([report.made.line, report.made.arrow, report.linesLost], [1, 1, 1]);
  assert.match(Miro.describe(report), /1 line, 1 arrow/);
});

test('linePoints: an end Miro places itself is the middle of the side facing the other end', () => {
  const boxes = new Map([['l', { x: 0, y: 0, w: 100, h: 100 }], ['r', { x: 500, y: 20, w: 100, h: 60 }]]);
  assert.deepEqual(Miro.linePoints({ a: { item: 'l', fx: null, fy: null }, b: { item: 'r', fx: null, fy: null }, kind: 'straight' }, { boxes }),
    [{ x: 100, y: 50 }, { x: 500, y: 50 }]);
});

test('toRecords with Miro\'s copy: an arrow keeps its ends on the items, a drawing comes over as a pen stroke', () => {
  const items = [
    { id: 'p1', type: 'shape', data: { shape: 'rectangle', content: '' }, style: {}, position: { x: 0, y: 0 }, geometry: { width: 100, height: 100 } },
    { id: 'p2', type: 'shape', data: { shape: 'rectangle', content: '' }, style: {}, position: { x: 500, y: 0 }, geometry: { width: 100, height: 100 } },
    { id: 'p3', type: 'shape', data: { shape: 'rectangle', content: '' }, style: {}, position: { x: 0, y: 500 }, geometry: { width: 100, height: 100 } },
    { id: 'pen', type: 'paint', position: { x: 1000, y: 1000 } },
  ];
  const positions = new Map([['p1', { x: 0, y: 0 }], ['p2', { x: 500, y: 0 }], ['p3', { x: 0, y: 500 }]]);
  const lines = [{ id: 'A', a: { item: 'p1', fx: 1, fy: 0.5 }, b: { item: 'p2', fx: 0, fy: 0.5 }, via: [], kind: 'elbow', width: 2, color: '#333333', dash: 'solid', start: 'none', end: 'arrow' }];
  const paints = [{ id: 'pen', points: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 40, y: 0 }], color: '#ff000080', width: 4, scale: 1 }];
  const copy = { order: new Map(), heights: new Map(), styles: new Map(), positions, frames: [], lines, paints };
  const { records, report } = Miro.toRecords(items, new Map(), { copy, scale: 1 });
  const A = records.find((r) => r.id === 'miro-A');
  assert.equal(A.style.route, 'elbow');
  assert.deepEqual(A.ends, [{ id: 'miro-p1', fx: 1, fy: 0.5 }, { id: 'miro-p2', fx: 0, fy: 0.5 }]);
  const pen = records.find((r) => r.id === 'miro-pen');
  assert.equal(pen.type, 'line'); assert.equal(pen.freehand, true); assert.equal(pen.points.length, 3); assert.equal(pen.style.color, '#ff000080');
  assert.equal(report.made.drawing, 1);
});
