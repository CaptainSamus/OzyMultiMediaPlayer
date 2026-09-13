// Comparing the app's 4-part versions ("0.2.0.4"), used to decide whether a GitHub release is
// newer than the running build. Leading "v" is ignored and missing parts count as 0.
{
  const parts = (v) => String(v == null ? '' : v).trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);

  const Version = {
    parts,
    // -1 if a < b, 0 if the same, 1 if a > b
    compare(a, b) {
      const pa = parts(a), pb = parts(b);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
      }
      return 0;
    },
    newer(a, b) { return Version.compare(a, b) > 0 },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Version;
  else window.Version = Version;
}
