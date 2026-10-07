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
