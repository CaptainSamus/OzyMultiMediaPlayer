// The load viewer's arithmetic. Ozy's own numbers come from Electron's app.getAppMetrics(); the
// whole machine's from Node's os module; "everything else" is the difference. Nothing here reads
// what other programs are running - that was the deal with Mark - only totals.
{
  const sum = (c) => c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  const LoadStats = {
    cpuPercent(prev, next) {
      if (!Array.isArray(prev) || !Array.isArray(next) || !prev.length || prev.length !== next.length) return null;
      let total = 0, idle = 0;
      for (let i = 0; i < next.length; i++) { total += sum(next[i]) - sum(prev[i]); idle += next[i].times.idle - prev[i].times.idle; }
      return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
    },
    split({ appCpu, appMemMB, gpuMemMB, sysCpu, usedMemMB, totalMemMB }) {
      const n = (v) => Math.max(0, Number(v) || 0);
      return {
        ozy: { cpu: n(appCpu), memMB: n(appMemMB), gpuMemMB: n(gpuMemMB) },
        other: { cpu: n(n(sysCpu) - n(appCpu)), memMB: n(n(usedMemMB) - n(appMemMB)) },
        freeMB: n(n(totalMemMB) - n(usedMemMB)),
      };
    },
    // 812 MB, 3.2 GB: megabytes until there is a gigabyte of them
    fmt(mb) {
      const v = typeof mb === 'number' ? mb : NaN;
      if (!Number.isFinite(v)) return '–';
      return Math.round(v) >= 1024 ? (v / 1024).toFixed(1) + ' GB' : Math.round(v) + ' MB';
    },
    // Segments for the two live bars: memory as shares of the machine's total, CPU as shares of
    // 100. Clamped in order (Ozy, everything else, the rest) so a bar never overflows, and a
    // missing or half-filled sample gives empty bars instead of throwing in the refresh timer.
    bars(split, totalMemMB) {
      const zero = { mem: [{ key: 'ozy', pct: 0 }, { key: 'other', pct: 0 }, { key: 'free', pct: 0 }], cpu: [{ key: 'ozy', pct: 0 }, { key: 'other', pct: 0 }, { key: 'idle', pct: 0 }] };
      const total = Number(totalMemMB);
      if (!split || typeof split !== 'object' || !(total > 0)) return zero;
      const c = (v) => Math.max(0, Math.min(100, Number(v) || 0));
      const ozy = split.ozy || {}, other = split.other || {};
      const ozyM = c(ozy.memMB / total * 100), otherM = c(Math.min(100 - ozyM, other.memMB / total * 100 || 0));
      const freeM = c(Math.min(100 - ozyM - otherM, split.freeMB / total * 100 || 0));
      const ozyC = c(ozy.cpu), otherC = c(Math.min(100 - ozyC, Number(other.cpu) || 0));
      return {
        mem: [{ key: 'ozy', pct: ozyM }, { key: 'other', pct: otherM }, { key: 'free', pct: freeM }],
        cpu: [{ key: 'ozy', pct: ozyC }, { key: 'other', pct: otherC }, { key: 'idle', pct: c(100 - ozyC - otherC) }],
      };
    },
    // The first GPU's line of
    //   nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits
    // as { busy %, usedMB, totalMB }, or null for anything else (an error message, "[N/A]" fields).
    parseNvidiaSmi(text) {
      const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => /^\d+\s*,\s*\d+\s*,\s*\d+$/.test(l));
      if (!line) return null;
      const [busy, usedMB, totalMB] = line.split(',').map((v) => Number(v.trim()));
      return totalMB > 0 ? { busy, usedMB, totalMB } : null;
    },
    // the GPU bar: video memory used out of the card's total; empty when there is no sample
    gpuBar(gpu) {
      if (!gpu || !(gpu.totalMB > 0)) return [{ key: 'used', pct: 0 }, { key: 'free', pct: 0 }];
      const used = Math.max(0, Math.min(100, gpu.usedMB / gpu.totalMB * 100));
      return [{ key: 'used', pct: Math.round(used) }, { key: 'free', pct: Math.round(100 - used) }];
    },
    // the last good sample, while it is recent enough to show (maxAgeMs, default 5 s)
    freshGpu(gpu, takenAt, now, maxAgeMs = 5000) { return gpu && now - takenAt <= maxAgeMs ? gpu : null; },
    // decoded frames are 12 bits per pixel (yuv420) and a handful are in flight
    estimateMB(width, height) { return (Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0) * 1.5 * 4) / 1048576; },
    // one display row per tile; a tile with no <video> (web player, image, text) is all dashes
    rows(tiles) {
      return (Array.isArray(tiles) ? tiles : []).map((tile) => {
        const t = tile && typeof tile === 'object' ? tile : {};
        const hasRes = Number(t.width) > 0 && Number(t.height) > 0;
        return {
          name: String(t.name || ''),
          res: hasRes ? `${t.width}×${t.height}` : '–',
          tier: t.tier || '–',
          state: t.state || '–',
          dropped: Number.isFinite(t.dropped) ? t.dropped : '–',
          estMB: hasRes ? LoadStats.estimateMB(t.width, t.height) : 0,
        };
      });
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = LoadStats;
  else window.LoadStats = LoadStats;
}
