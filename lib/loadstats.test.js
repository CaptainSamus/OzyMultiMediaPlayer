const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./loadstats');

const cpus = (idle, busy) => [{ times: { user: busy, nice: 0, sys: 0, irq: 0, idle } }];
test('cpuPercent from two samples', () => {
  assert.equal(L.cpuPercent(null, cpus(100, 100)), null);
  assert.equal(L.cpuPercent(cpus(100, 100), cpus(150, 150)), 50);
  assert.equal(L.cpuPercent(cpus(100, 100), cpus(100, 100)), 0);   // no time passed: 0, not NaN
});
test('split: everything else is the system minus Ozy, never negative', () => {
  const s = L.split({ appCpu: 30, appMemMB: 1000, gpuMemMB: 200, sysCpu: 50, usedMemMB: 8000, totalMemMB: 16000 });
  assert.deepEqual(s, { ozy: { cpu: 30, memMB: 1000, gpuMemMB: 200 }, other: { cpu: 20, memMB: 7000 }, freeMB: 8000 });
  const t = L.split({ appCpu: 60, appMemMB: 9000, gpuMemMB: 0, sysCpu: 50, usedMemMB: 8000, totalMemMB: 16000 });
  assert.equal(t.other.cpu, 0); assert.equal(t.other.memMB, 0);
});
test('estimateMB scales with pixels', () => {
  assert.equal(Math.round(L.estimateMB(1920, 1080)), 12);
  assert.equal(Math.round(L.estimateMB(960, 540)), 3);
  assert.equal(L.estimateMB(0, 0), 0);
});
test('rows tolerate tiles without a video', () => {
  const rows = L.rows([
    { name: 'a.mp4', width: 1920, height: 1080, tier: 'full', state: 'playing', dropped: 3 },
    { name: 'note', state: 'text' },
    { name: 'yt', tier: 'full', state: 'paused' },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].res, '1920×1080'); assert.equal(rows[0].dropped, 3); assert.equal(Math.round(rows[0].estMB), 12);
  assert.equal(rows[1].res, '–'); assert.equal(rows[1].estMB, 0); assert.equal(rows[1].dropped, '–');
  assert.deepEqual(L.rows(null), []);
  assert.equal(L.rows([null, undefined, {}]).length, 3);              // junk rows still render as dashes
});

test('fmt: MB under a GB, GB with one decimal above', () => {
  assert.equal(L.fmt(812), '812 MB');
  assert.equal(L.fmt(1024), '1.0 GB');
  assert.equal(L.fmt(3276), '3.2 GB');
  assert.equal(L.fmt(NaN), '–');
});
test('fmt: never prints 1024 MB, and nothing at all is not zero', () => {
  assert.equal(L.fmt(1023.7), '1.0 GB');
  assert.equal(L.fmt(undefined), '–');
  assert.equal(L.fmt(null), '–');
  assert.equal(L.fmt(0), '0 MB');
});
test('bars: three memory segments out of the total, three CPU segments out of 100', () => {
  const b = L.bars({ ozy: { cpu: 30, memMB: 4000, gpuMemMB: 0 }, other: { cpu: 20, memMB: 8000 }, freeMB: 4000 }, 16000);
  assert.deepEqual(b.mem.map((s) => [s.key, s.pct]), [['ozy', 25], ['other', 50], ['free', 25]]);
  assert.deepEqual(b.cpu.map((s) => [s.key, s.pct]), [['ozy', 30], ['other', 20], ['idle', 50]]);
});
test('bars tolerate missing data', () => {
  const b = L.bars(null, 0);
  assert.deepEqual(b.mem.map((s) => s.pct), [0, 0, 0]);
  assert.deepEqual(b.cpu.map((s) => s.pct), [0, 0, 0]);
  // half a sample (a split with parts missing) must not throw either
  assert.deepEqual(L.bars({}, 16000).mem.map((s) => s.pct), [0, 0, 0]);
  assert.deepEqual(L.bars({ ozy: { memMB: 'x' } }, 16000).cpu.map((s) => s.pct), [0, 0, 100]);
});
test('bars never add up to more than the bar, whatever the numbers say', () => {
  const b = L.bars({ ozy: { cpu: 80, memMB: 12000 }, other: { cpu: 70, memMB: 9000 }, freeMB: 5000 }, 16000);
  assert.deepEqual(b.mem.map((s) => s.pct), [75, 25, 0]);
  assert.deepEqual(b.cpu.map((s) => s.pct), [80, 20, 0]);
});

test('parseNvidiaSmi reads the first GPU line', () => {
  assert.deepEqual(L.parseNvidiaSmi('34, 2150, 12288\n'), { busy: 34, usedMB: 2150, totalMB: 12288 });
  assert.deepEqual(L.parseNvidiaSmi('12, 500, 8192\n3, 100, 8192\n'), { busy: 12, usedMB: 500, totalMB: 8192 });
  assert.equal(L.parseNvidiaSmi(''), null);
  assert.equal(L.parseNvidiaSmi('NVIDIA-SMI has failed'), null);
});
test('parseNvidiaSmi: Windows line endings, and fields the driver will not report', () => {
  assert.deepEqual(L.parseNvidiaSmi('1, 5350, 24564\r\n'), { busy: 1, usedMB: 5350, totalMB: 24564 });
  assert.equal(L.parseNvidiaSmi('[N/A], 5350, 24564\r\n'), null);
  assert.equal(L.parseNvidiaSmi(undefined), null);
  assert.equal(L.parseNvidiaSmi('5, 100, 0\n'), null);      // no memory total: nothing to draw a bar against
});
test('gpuBar: used of total, zeros when unknown', () => {
  assert.deepEqual(L.gpuBar({ busy: 34, usedMB: 3072, totalMB: 12288 }), [{ key: 'used', pct: 25 }, { key: 'free', pct: 75 }]);
  assert.deepEqual(L.gpuBar(null), [{ key: 'used', pct: 0 }, { key: 'free', pct: 0 }]);
  assert.deepEqual(L.gpuBar({ busy: 1, usedMB: 99999, totalMB: 100 }), [{ key: 'used', pct: 100 }, { key: 'free', pct: 0 }]);
});
test('freshGpu: a sample is good for a few seconds, then it is nothing rather than a frozen number', () => {
  const g = { busy: 3, usedMB: 1, totalMB: 2 };
  assert.equal(L.freshGpu(g, 1000, 3000), g);
  assert.equal(L.freshGpu(g, 1000, 6001), null);
  assert.equal(L.freshGpu(null, 1000, 1000), null);
});
