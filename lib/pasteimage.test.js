const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./pasteimage');

test('imgSrc: the picture Chrome names in what it copied', () => {
  const chrome = '<html><body><!--StartFragment--><img src="https://upload.example.org/a/b/Cat.jpg?x=1&amp;y=2" alt="cat"/><!--EndFragment--></body></html>';
  assert.equal(P.imgSrc(chrome), 'https://upload.example.org/a/b/Cat.jpg?x=1&y=2');
  assert.equal(P.imgSrc("<img alt='x' src='data:image/png;base64,AAAA'>"), 'data:image/png;base64,AAAA');
  assert.equal(P.imgSrc('<img src=https://x.test/p.png>'), 'https://x.test/p.png');
  assert.equal(P.imgSrc('<img src="javascript:alert(1)">'), null);
  assert.equal(P.imgSrc('<p>no picture</p>'), null);
  assert.equal(P.imgSrc(null), null);
});

test('urlFromText: one link only', () => {
  assert.equal(P.urlFromText('  https://cdn.discordapp.com/attachments/1/2/pic.png?ex=1  '), 'https://cdn.discordapp.com/attachments/1/2/pic.png?ex=1');
  assert.equal(P.urlFromText('look at https://x.test/a.png'), null);
  assert.equal(P.urlFromText('C:\\pics\\a.png'), null);
});

test('fromDataUrl: base64 and plain', () => {
  const d = P.fromDataUrl('data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64'));
  assert.equal(d.type, 'image/png'); assert.equal(d.bytes.toString(), 'PNGDATA');
  assert.equal(P.fromDataUrl('data:text/plain,hi'), null);
});

test('best: most pixels, the linked file on a tie, anything when sizes are unknown', () => {
  const link = { kind: 'link', w: 1920, h: 1080 }, bmp = { kind: 'bitmap', w: 1920, h: 1080 }, thumb = { kind: 'link', w: 200, h: 150 };
  assert.equal(P.best([bmp, link]), link);
  assert.equal(P.best([thumb, bmp]), bmp); // Google's small preview link loses to the full picture Chrome copied
  assert.equal(P.best([{ kind: 'link' }, { kind: 'bitmap', w: 10, h: 10 }]).kind, 'bitmap');
  assert.equal(P.best([{ kind: 'link' }]).kind, 'link');
  assert.equal(P.best([]), null);
});

test('extFor and fileName', () => {
  assert.equal(P.extFor('image/jpeg', ''), '.jpg');
  assert.equal(P.extFor('application/octet-stream', 'https://x.test/a/B.WEBP?s=1'), '.webp');
  assert.equal(P.extFor('text/html', 'https://x.test/page'), null);
  const at = new Date(2026, 10, 10, 14, 3, 9);
  assert.equal(P.fileName('https://x.test/art/Spider%20Man%3A%20poster.jpg', '.jpg', at), 'Spider Man poster (pasted 2026-11-10 14.03.09).jpg');
  assert.equal(P.fileName('https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9', '.jpg', at), 'pasted 2026-11-10 14.03.09.jpg');
  assert.equal(P.fileName('', '.png', at), 'pasted 2026-11-10 14.03.09.png');
});
