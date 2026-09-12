const test = require('node:test');
const assert = require('node:assert/strict');
const Sequence = require('./sequence');
const range = (a, b, f) => Array.from({ length: b - a + 1 }, (_, i) => f(a + i));

test('detect: a 240-frame EXR run is one sequence', () => {
  const r = Sequence.detect(range(1, 240, (n) => `shot.${String(n).padStart(4, '0')}.exr`));
  assert.equal(r.sequences.length, 1);
  const s = r.sequences[0];
  assert.deepEqual([s.name, s.sep, s.pad, s.ext, s.start, s.end, s.count], ['shot', '.', 4, 'exr', 1, 240, 240]);
  assert.deepEqual(s.missing, []);
  assert.deepEqual(r.loose, []);
});
test('detect: a gap is listed as missing', () => {
  const s = Sequence.detect(['render_001.png', 'render_003.png', 'render_004.png']).sequences[0];
  assert.deepEqual([s.start, s.end, s.count], [1, 4, 3]);
  assert.deepEqual(s.missing, [2]);
});
test('detect: two names in one folder are two sequences; other files stay loose', () => {
  const r = Sequence.detect(['a.0001.exr', 'a.0002.exr', 'b_01.jpg', 'b_02.jpg', 'notes.txt', 'clip.mp4']);
  assert.deepEqual(r.sequences.map(Sequence.label), ['a.[0001-0002].exr', 'b_[01-02].jpg']);
  assert.deepEqual(r.loose.sort(), ['clip.mp4', 'notes.txt']);
});
test('detect: a single frame and inconsistent padding stay loose', () => {
  assert.deepEqual(Sequence.detect(['hero.0100.exr']).loose, ['hero.0100.exr']);
  const r = Sequence.detect(['img1.png', 'img10.png']);
  assert.equal(r.sequences.length, 0);
  assert.deepEqual(r.loose.sort(), ['img1.png', 'img10.png']);
});
test('detect: no separator, and a version number before the frame', () => {
  const r = Sequence.detect(['frame0001.tif', 'frame0002.tif', 'shot_v002.0010.exr', 'shot_v002.0011.exr']);
  assert.deepEqual(r.sequences.map(Sequence.label).sort(), ['frame[0001-0002].tif', 'shot_v002.[0010-0011].exr']);
});
test('member, sameRun, framePath', () => {
  const s = Sequence.detect(['shot.0001.exr', 'shot.0002.exr']).sequences[0];
  assert.equal(Sequence.member('shot.0005.exr').frame, 5);
  assert.equal(Sequence.member('shot.exr'), null);
  assert.ok(Sequence.sameRun(s, 'shot.0005.exr'));
  assert.ok(!Sequence.sameRun(s, 'shot.00005.exr'));
  assert.equal(Sequence.framePath(s, 7), 'shot.0007.exr');
});
test('needsDecode: exr/tif/tiff/dpx only', () => {
  assert.deepEqual(['exr', 'TIF', 'tiff', 'dpx', 'png', 'jpg', 'jpeg', 'webp'].map(Sequence.needsDecode), [true, true, true, true, false, false, false, false]);
});
test('batches: contiguous runs, at most max frames each', () => {
  assert.deepEqual(Sequence.batches([1, 2, 3, 5, 6, 10], 24), [[1, 3], [5, 6], [10, 10]]);
  assert.deepEqual(Sequence.batches(range(1, 50, (n) => n), 24), [[1, 24], [25, 48], [49, 50]]);
});
test('decodeArgs: start number, frame count, exr colour chain, rgb24 png out', () => {
  const s = { name: 'shot', sep: '.', pad: 4, ext: 'exr' };
  const a = Sequence.decodeArgs({ dir: 'C:/r', seq: s, from: 10, to: 33, outDir: 'C:/c', exposure: 2, colour: 'srgb' });
  assert.equal(a[a.indexOf('-start_number') + 1], '10');
  assert.equal(a[a.indexOf('-i') + 1], 'C:/r/shot.%04d.exr');
  assert.equal(a[a.indexOf('-frames:v') + 1], '24');
  const vf = a[a.indexOf('-vf') + 1];
  assert.match(vf, /^exposure=exposure=2,zscale=tin=linear.*t=iec61966-2-1.*,format=rgb24,setparams=color_trc=iec61966-2-1:color_primaries=bt709$/);
  assert.equal(a[a.length - 1], 'C:/c/%04d.png');
  assert.match(Sequence.filter({ seq: s, colour: 'rec709' }), /format=gbrp16le,lutrgb=r=clip/);
  assert.equal(Sequence.filter({ seq: s, colour: 'none' }), 'format=rgb24,setparams=color_trc=iec61966-2-1:color_primaries=bt709');
  // png / tif frames get no exposure or transfer
  assert.equal(Sequence.filter({ seq: { ...s, ext: 'tif' }, exposure: 3, colour: 'srgb' }), 'format=rgb24,setparams=color_trc=iec61966-2-1:color_primaries=bt709');
  // without zscale the decoder applies sRGB itself
  assert.ok(Sequence.decodeArgs({ dir: 'd', seq: s, from: 1, to: 2, outDir: 'o', useZscale: false }).includes('-apply_trc'));
  // a % in the name is escaped for ffmpeg's pattern
  assert.equal(Sequence.decodeArgs({ dir: 'd', seq: { ...s, name: '50%off' }, from: 1, to: 2, outDir: 'o' }).find((x) => x.startsWith('d/')), 'd/50%%off.%04d.exr');
});
test('decodeArgs: EXR layer and part become decoder options before -i', () => {
  const s = { name: 'shot', sep: '.', pad: 4, ext: 'exr' };
  const plain = Sequence.decodeArgs({ dir: 'd', seq: s, from: 1, to: 2, outDir: 'o' });
  assert.ok(!plain.includes('-layer') && !plain.includes('-part'));
  const a = Sequence.decodeArgs({ dir: 'd', seq: { ...s, layer: 'diffuse', part: 2 }, from: 1, to: 2, outDir: 'o' });
  assert.equal(a[a.indexOf('-layer') + 1], 'diffuse');
  assert.equal(a[a.indexOf('-part') + 1], '2');
  assert.ok(a.indexOf('-layer') < a.indexOf('-i') && a.indexOf('-part') < a.indexOf('-i'));
  // part 0 is the default and stays off the command line
  assert.ok(!Sequence.decodeArgs({ dir: 'd', seq: { ...s, layer: 'diffuse', part: 0 }, from: 1, to: 2, outDir: 'o' }).includes('-part'));
  // png / tif sequences never get either
  assert.ok(!Sequence.decodeArgs({ dir: 'd', seq: { ...s, ext: 'png', layer: 'diffuse', part: 1 }, from: 1, to: 2, outDir: 'o' }).includes('-layer'));
});
test('cacheKey: a different layer or part is a different cache', () => {
  const s = { name: 'shot', sep: '.', pad: 4, ext: 'exr', start: 1, end: 48 };
  const base = Sequence.cacheKey(s, 'C:/r', 0, 'srgb', 1000);
  assert.equal(Sequence.cacheKey({ ...s, layer: '', part: 0 }, 'C:/r', 0, 'srgb', 1000), base); // the defaults
  assert.notEqual(Sequence.cacheKey({ ...s, layer: 'diffuse' }, 'C:/r', 0, 'srgb', 1000), base);
  assert.notEqual(Sequence.cacheKey({ ...s, part: 1 }, 'C:/r', 0, 'srgb', 1000), base);
  assert.notEqual(Sequence.cacheKey({ ...s, layer: 'diffuse' }, 'C:/r', 0, 'srgb', 1000), Sequence.cacheKey({ ...s, layer: 'specular' }, 'C:/r', 0, 'srgb', 1000));
});
test('cacheKey: stable, and changes with exposure, colour and files', () => {
  const s = { name: 'shot', sep: '.', pad: 4, ext: 'exr', start: 1, end: 48 };
  const k = Sequence.cacheKey(s, 'C:/r', 0, 'srgb', 1000);
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(Sequence.cacheKey(s, 'C:/r', 0, 'srgb', 1000), k);
  assert.notEqual(Sequence.cacheKey(s, 'C:/r', 1, 'srgb', 1000), k);
  assert.notEqual(Sequence.cacheKey(s, 'C:/r', 0, 'none', 1000), k);
  assert.notEqual(Sequence.cacheKey(s, 'C:/r', 0, 'srgb', 2000), k);
});
test('single: a lone frame is a one-frame sequence', () => {
  const s = Sequence.single('hero.0100.exr');
  assert.deepEqual([s.name, s.ext, s.start, s.end, s.count, s.single], ['hero.0100', 'exr', 0, 0, 1, true]);
  assert.equal(Sequence.framePath(s, 0), 'hero.0100.exr');
  assert.equal(Sequence.label(s), 'hero.0100.exr');
  const a = Sequence.decodeArgs({ dir: 'd', seq: s, from: 0, to: 0, outDir: 'o' });
  assert.equal(a[a.indexOf('-i') + 1], 'd/hero.0100.exr');
  assert.ok(a.includes('-pattern_type'));
  assert.equal(a[a.length - 1], 'o/0.png');
});
