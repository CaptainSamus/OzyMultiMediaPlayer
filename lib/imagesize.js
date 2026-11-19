// A picture's width and height from the first bytes of its file, without decoding it: PNG, JPEG,
// GIF, WebP and BMP. Used by the Miro import to see which pictures Miro shows cropped (their shape
// on the board differs from the file's). Returns { w, h } or null.
// (2026-11-06; a JPEG's EXIF rotation is not looked at: Miro serves the picture as it shows it.)
const fs = require('fs');

function fromBuffer(b) {
  if (!b || b.length < 10) return null;
  // PNG: signature, then IHDR's width and height
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) };
  // WebP: lossy (VP8 ), lossless (VP8L) or extended (VP8X)
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

// the first 256 KB is plenty for every format here (a JPEG's frame header can sit behind a big EXIF block)
async function ofFile(p) {
  let fh;
  try {
    fh = await fs.promises.open(p, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const r = fromBuffer(buf.subarray(0, bytesRead));
    return r && r.w > 0 && r.h > 0 ? r : null;
  } catch { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}

module.exports = { fromBuffer, ofFile };
