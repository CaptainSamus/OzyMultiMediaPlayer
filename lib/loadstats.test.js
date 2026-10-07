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
