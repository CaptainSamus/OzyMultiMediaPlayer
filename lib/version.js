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
    // Release tags are 4-part (v0.2.0.5) but npm and electron-builder need semver, and the
    // installer / latest.yml are named from package.json's version. The fourth part folds into
    // the patch number (0.2.0.5 -> 0.2.5, 0.2.1.3 -> 0.2.103) so ordering still holds; the true
    // 4-part number stays in buildVersion, which is what the app shows and compares.
    // null when there is nothing usable to convert.
    semverFromTag(tag) {
      const raw = String(tag == null ? '' : tag).trim().replace(/^v/i, '');
      if (!/^\d+(\.\d+)*$/.test(raw)) return null;
      const p = parts(raw);
      if (p.length < 4) return p.join('.');
      return `${p[0]}.${p[1]}.${p[2] * 100 + p[3]}`;
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Version;
  else window.Version = Version;
}
