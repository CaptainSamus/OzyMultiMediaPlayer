// Image sequences: spotting frame runs in a folder, and the ffmpeg calls that decode EXR / TIFF / DPX
// frames into 8-bit PNGs for the frame player (PNG / JPEG / WebP frames are decoded by Chromium).
//
// Decode speed with the bundled ffmpeg 6.1.1 (Task 23 spike, 2026-09-11, 32-thread Windows box,
// synthetic testsrc2 half-float EXR, zip1): one frame including process start 125-250 ms, so frames
// are decoded in batches. 1920x1080, 24 frames -> PNG: ~355 ms (~67 fps); all 48 in one process
// 442 ms (108 fps); 2 processes x 24: 90 fps; 4 x 12: 67 fps (start-up and disk dominate, ffmpeg
// already threads). 3840x2160, 24 frames: ~950 ms (~25 fps, 29 MB of PNG); 2 x 12: 19 fps.
// PNG compression level 1 is as fast as 0 and ~18x smaller. Real renders (PIZ / DWAA, many
// channels, noise) decode and compress slower than this test pattern.
//
// Colour (EXR only), measured on 0.18 linear grey: exposure in linear light, then
//   sRGB  zscale linear -> iec61966-2-1: 118 (+1 stop 162, -1 stop 85)
//   Rec.709 (Nuke): the camera OETF 1.099 x^0.45 - 0.099 through lutrgb at 16 bit: 105
//     (zscale's bt709 is the BT.1886 display inverse, a pure 2.4 gamma: 125, not what Nuke shows)
//   None: linear values clipped: 46
{ // a block: in the renderer every lib shares one global scope, so only Sequence leaves it
const SEQ_EXTS = ['exr', 'png', 'tif', 'tiff', 'jpg', 'jpeg', 'webp', 'dpx'];
const DECODE_EXTS = new Set(['exr', 'tif', 'tiff', 'dpx']);
const FRAME_RE = /^(.*?)([._-]?)(\d{2,})\.([A-Za-z0-9]+)$/;
const COLOURS = ['srgb', 'rec709', 'none'];

const extOf = (n) => n.slice(n.lastIndexOf('.') + 1).toLowerCase();
const parse = (name) => {
  const m = FRAME_RE.exec(name);
  if (!m || !SEQ_EXTS.includes(m[4].toLowerCase())) return null;
  return { name: m[1], sep: m[2], digits: m[3], ext: m[4] };
};
const keyOf = (p) => `${p.name}|${p.sep}|${p.digits.length}|${p.ext.toLowerCase()}`;

// Nuke's rec709 viewer curve on 16-bit linear values (lutrgb works on integer formats only)
const OETF = 'clip(if(lt(val/65535\\,0.018)\\,4.5*val\\,(1.099*pow(val/65535\\,0.45)-0.099)*65535)\\,0\\,65535)';

const Sequence = {
  SEQ_EXTS, COLOURS,
  PIPELINE: 2, // part of the cache key: bump when the decode chain changes so old cached frames aren't reused
  isFrameExt(name) { return SEQ_EXTS.includes(extOf(name)); },
  // names -> runs of 2+ frames sharing name, separator, padding and extension; everything else is loose
  detect(names) {
    const groups = new Map(); const loose = [];
    for (const n of names) {
      const p = parse(n);
      if (!p) { loose.push(n); continue; }
      const k = keyOf(p);
      if (!groups.has(k)) groups.set(k, { p, items: [] });
      groups.get(k).items.push({ n, f: Number(p.digits) });
    }
    const sequences = [];
    for (const { p, items } of groups.values()) {
      if (items.length < 2) { loose.push(...items.map((i) => i.n)); continue; }
      items.sort((a, b) => a.f - b.f);
      const have = new Set(items.map((i) => i.f));
      const start = items[0].f, end = items[items.length - 1].f, missing = [];
      for (let f = start; f <= end; f++) if (!have.has(f)) missing.push(f);
      sequences.push({ name: p.name, sep: p.sep, pad: p.digits.length, ext: p.ext, start, end, count: items.length, missing, frames: items.map((i) => i.n) });
    }
    sequences.sort((a, b) => Sequence.label(a).localeCompare(Sequence.label(b), undefined, { sensitivity: 'base', numeric: true }));
    return { sequences, loose };
  },
  // which run a single file name would belong to (key matches detect's grouping)
  member(name) { const p = parse(name); return p ? { key: keyOf(p), frame: Number(p.digits) } : null; },
  sameRun(seq, name) { const p = parse(name); return !!p && keyOf(p) === keyOf({ name: seq.name, sep: seq.sep, digits: '0'.repeat(seq.pad), ext: seq.ext }); },
  framePath(seq, n) { return seq.single ? `${seq.name}.${seq.ext}` : `${seq.name}${seq.sep}${String(n).padStart(seq.pad, '0')}.${seq.ext}`; },
  // a lone exr / tif / dpx file: a one-frame sequence (frame 0)
  single(fileName) { const i = fileName.lastIndexOf('.'); return { name: fileName.slice(0, i), sep: '', pad: 0, ext: fileName.slice(i + 1), start: 0, end: 0, count: 1, missing: [], single: true }; },
  label(seq) { if (seq.single) return `${seq.name}.${seq.ext}`; return `${seq.name}${seq.sep}[${String(seq.start).padStart(seq.pad, '0')}-${String(seq.end).padStart(seq.pad, '0')}].${seq.ext}`; },
  pattern(seq) { if (seq.single) return `${seq.name}.${seq.ext}`; return `${seq.name}${seq.sep}${'#'.repeat(seq.pad)}.${seq.ext}`; }, // for display and "on the board" matching
  length(seq) { return seq.end - seq.start + 1; },
  needsDecode(ext) { return DECODE_EXTS.has(String(ext).toLowerCase()); },
  isExr(seq) { return String(seq.ext).toLowerCase() === 'exr'; },
  // runs of frames (sorted numbers) that are contiguous, split to at most `max` frames each
  batches(frames, max = 24) {
    const out = []; let a = null, b = null;
    for (const f of frames) {
      if (a !== null && f === b + 1 && f - a < max) { b = f; continue; }
      if (a !== null) out.push([a, b]);
      a = b = f;
    }
    if (a !== null) out.push([a, b]);
    return out;
  },
  // the -vf chain: EXR gets exposure in linear light and a transfer; everything ends as rgb24
  filter({ seq, exposure = 0, colour = 'srgb', useZscale = true }) {
    const f = [];
    if (Sequence.isExr(seq)) {
      if (Number(exposure)) f.push(`exposure=exposure=${Number(exposure)}`);
      if (colour === 'srgb' && useZscale) f.push('zscale=tin=linear:pin=bt709:min=gbr:rin=full:t=iec61966-2-1:p=bt709:m=gbr:r=full');
      if (colour === 'rec709') f.push('format=gbrp16le', `lutrgb=r=${OETF}:g=${OETF}:b=${OETF}`);
    }
    // label the result as plain sRGB: left "linear", the PNG gets cICP / gAMA chunks and Chromium
    // colour-manages it (0.18 grey shown with colour None read 117 instead of 46)
    f.push('format=rgb24', 'setparams=color_trc=iec61966-2-1:color_primaries=bt709');
    return f.join(',');
  },
  // one ffmpeg call decoding frames from..to (contiguous, all present) to outDir/<frame>.png
  decodeArgs({ dir, seq, from, to, outDir, exposure = 0, colour = 'srgb', useZscale = true, sep = '/' }) {
    const pat = `${seq.name.replace(/%/g, '%%')}${seq.sep}%0${seq.pad}d.${seq.ext}`;
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    // without zscale the EXR decoder applies the sRGB curve itself (exposure then acts after it)
    if (Sequence.isExr(seq) && colour === 'srgb' && !useZscale) args.push('-apply_trc', 'iec61966_2_1');
    // which layer / part of a multi-layer EXR to decode (decoder options, so they go before -i)
    if (Sequence.isExr(seq)) {
      if (seq.layer) args.push('-layer', String(seq.layer));
      if (Number(seq.part) > 0) args.push('-part', String(Number(seq.part)));
    }
    if (seq.single) args.push('-pattern_type', 'none', '-i', dir + sep + Sequence.framePath(seq, 0), '-frames:v', '1');
    else args.push('-start_number', String(from), '-i', dir + sep + pat, '-frames:v', String(to - from + 1));
    args.push(
      '-vf', Sequence.filter({ seq, exposure, colour, useZscale }),
      '-c:v', 'png', '-compression_level', '1');
    if (seq.single) args.push(outDir + sep + Sequence.cacheFile(seq, 0));
    else args.push('-start_number', String(from), outDir + sep + `%0${seq.pad}d.png`);
    return args;
  },
  cacheFile(seq, n) { return `${String(n).padStart(seq.pad, '0')}.png`; },
  // stable across sessions; changes with the files (first frame's mtime) and the look settings
  cacheKey(seq, dir, exposure, colour, firstMtime) {
    const s = [Sequence.PIPELINE, dir, seq.name, seq.sep, seq.pad, String(seq.ext).toLowerCase(), seq.start, seq.end, Math.round(firstMtime || 0), Sequence.isExr(seq) ? `${Number(exposure) || 0}|${colour}|${seq.layer || ''}|${Number(seq.part) || 0}` : ''].join('|');
    // cyrb53: a small non-crypto hash that runs the same in main and the renderer
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Sequence;
else window.Sequence = Sequence;
}
