const test = require('node:test');
const assert = require('node:assert/strict');
const ImageSize = require('./imagesize');

test('PNG, GIF, BMP and JPEG headers', () => {
  const png = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(ImageSize.fromBuffer(png), { w: 640, h: 480 });
  const gif = Buffer.alloc(12); gif.write('GIF89a'); gif.writeUInt16LE(30, 6); gif.writeUInt16LE(20, 8);
  assert.deepEqual(ImageSize.fromBuffer(gif), { w: 30, h: 20 });
  const bmp = Buffer.alloc(30); bmp.write('BM'); bmp.writeInt32LE(100, 18); bmp.writeInt32LE(-50, 22);
  assert.deepEqual(ImageSize.fromBuffer(bmp), { w: 100, h: 50 });
  // JPEG: SOI, an APP0 segment, then SOF0 with height 300 and width 400
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(ImageSize.fromBuffer(jpg), { w: 400, h: 300 });
  assert.equal(ImageSize.fromBuffer(Buffer.from('not a picture at all')), null);
});
