// The recent-sessions list: newest first, one entry per file, capped. Pure.
{
  const Recent = {
    sameFile(a, b, caseInsensitive) { return caseInsensitive ? String(a).toLowerCase() === String(b).toLowerCase() : a === b; },
    push(list, path, now, { max = 10, caseInsensitive = false } = {}) {
      const rest = (Array.isArray(list) ? list : []).filter((e) => e && typeof e.path === 'string' && !Recent.sameFile(e.path, path, caseInsensitive));
      return [{ path, openedAt: Number(now) || 0 }, ...rest].slice(0, max);
    },
    remove(list, path) { return (Array.isArray(list) ? list : []).filter((e) => e && typeof e.path === 'string' && e.path !== path); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Recent;
  else window.Recent = Recent;
}
