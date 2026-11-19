// Favorites: a star on a tile's title bar marks it. A favorite wears a gold ring on the board (and
// in the gallery), is saved with the session, and is listed on the sidebar's Favorites tab, where
// clicking its name flies the view to it. The rules that need no DOM live here, where they are tested.
{
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const Favorites = {
    // the share of the view a tile fills (its longer side, against the view's) when we fly to it
    FILL: 0.6,
    // how long the flight takes
    FLY_MS: 380,
    // A record says it is a favorite only with favorite: true; anything else (older files, a
    // hand-edited true-ish value) is not one.
    fromRecord(v) { return !!(v && typeof v === 'object' && v.favorite === true); },

    // ---- folders (Mark, 2026-11-05) ----
    // Favorites can be sorted into folders. A session keeps its folders as favFolders:
    // [{ id, name, color, open }], and a starred record names its folder as favFolder: id. A
    // favorite in no folder (or in one that is gone) is "Not in a folder". Each folder has a colour,
    // and its favorites wear that colour as their ring, so the board shows which belong together.
    // (not gold: gold is a favorite in no folder)
    COLORS: ['#3fb6ff', '#ff5d8f', '#4cd964', '#b47bff', '#ff8a3d', '#2fe0c8', '#e8e8e8', '#ff4040'],
    // a session's favFolders as saved, cleaned up: bad entries dropped, ids unique, names trimmed
    folders(raw) {
      const out = [];
      const seen = new Set();
      for (const f of Array.isArray(raw) ? raw : []) {
        if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !f.id || f.id.length > 64 || seen.has(f.id)) continue;
        seen.add(f.id);
        const name = String(typeof f.name === 'string' ? f.name : '').trim().slice(0, 80) || 'Folder';
        const color = typeof f.color === 'string' && /^#[0-9a-f]{6}$/i.test(f.color) ? f.color.toLowerCase() : Favorites.COLORS[out.length % Favorites.COLORS.length];
        out.push({ id: f.id, name, color, open: f.open !== false });
      }
      return out;
    },
    // a new folder for this list: the next free id, "Folder N" unless named, the first colour no
    // folder has yet (round again when all are taken)
    newFolder(folders, name) {
      const list = folders || [];
      let n = 1;
      while (list.some((f) => f.id === 'f' + n)) n++;
      const used = new Set(list.map((f) => f.color));
      const color = Favorites.COLORS.find((c) => !used.has(c)) || Favorites.COLORS[list.length % Favorites.COLORS.length];
      let label = String(name || '').trim().slice(0, 80);
      if (!label) { let k = list.length + 1; while (list.some((f) => f.name === 'Folder ' + k)) k++; label = 'Folder ' + k; }
      return { id: 'f' + n, name: label, color, open: true };
    },
    // the folder id a record (or tile) is in, or null when it names none that exists
    folderOf(v, folders) {
      const id = v && typeof v === 'object' && typeof v.favFolder === 'string' ? v.favFolder : null;
      return id && (folders || []).some((f) => f.id === id) ? id : null;
    },
    // The Favorites tab: one section per folder in the folders' order, each with its favorites
    // sorted by name, then the favorites in no folder. items: [{ id, name, folder }].
    // Returns [{ folder: <folder> | null, items }]; the no-folder section only when it has some
    // (or when there are no folders at all, so an empty list still has its one section).
    sections(items, folders) {
      const list = folders || [];
      const known = new Set(list.map((f) => f.id));
      const out = list.map((f) => ({ folder: f, items: Favorites.sorted((items || []).filter((it) => it.folder === f.id)) }));
      const loose = Favorites.sorted((items || []).filter((it) => !it.folder || !known.has(it.folder)));
      if (loose.length || !list.length) out.push({ folder: null, items: loose });
      return out;
    },
    // the board rectangle around a folder's tiles (board coordinates), or null when none are on it
    bounds(rects) {
      const rs = (rects || []).filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite));
      if (!rs.length) return null;
      const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
      const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    },

    // ---- playing on while out of sight (Mark, 2026-11-05) ----
    // With the setting on, a favorite that is playing keeps playing when it is off screen (or too
    // small to be worth decoding), turned down to `quiet` (3 % unless set otherwise; never louder
    // than it already was). Back in view it is at its own volume again.
    QUIET: 0.03,
    QUIET_MAX: 0.25,
    FADE_MS: 600,
    quietLevel(v) { const n = Number(v); return Number.isFinite(n) ? clamp(n, 0, Favorites.QUIET_MAX) : Favorites.QUIET; },
    quietVolume(volume, quiet) { return Math.min(clamp(Number(volume) || 0, 0, 1), Favorites.quietLevel(quiet)); },
    // the volume part way through a fade from `from` to `to` (k from 0 to 1)
    fade(from, to, k) { return k <= 0 ? from : k >= 1 ? to : from + (to - from) * k; },
    // The favorites list: [{ id, name }] sorted by name the way a person reads them ("clip 2"
    // before "clip 10"), ties kept in board order.
    sorted(items) {
      return (items || [])
        .map((it, i) => ({ it, i }))
        .sort((a, b) => String(a.it.name || '').localeCompare(String(b.it.name || ''), undefined, { numeric: true, sensitivity: 'base' }) || a.i - b.i)
        .map((x) => x.it);
    },
    // Where the board camera goes to show `rect` (board coordinates) in a view of `view` = { w, h }
    // pixels: centred, and zoomed so the tile fills about FILL of the view. Zoom stays within the
    // board's limits, so a huge tile is shown as big as the board allows (still centred).
    camera(rect, view, { minZoom, maxZoom, fill = Favorites.FILL } = {}) {
      const w = Math.max(1, Number(rect.w) || 1), h = Math.max(1, Number(rect.h) || 1);
      const zoom = clamp(Math.min((view.w * fill) / w, (view.h * fill) / h), minZoom, maxZoom);
      const cx = rect.x + w / 2, cy = rect.y + h / 2;
      return { zoom, panX: view.w / 2 - cx * zoom, panY: view.h / 2 - cy * zoom };
    },
    // One step of the flight from camera `a` to camera `b` (t from 0 to 1, eased here). The point
    // at the middle of the view travels in a straight line and the zoom changes evenly in scale,
    // so a fly from far out to close up neither lurches nor overshoots.
    between(a, b, t, view) {
      const e = t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3); // ease out
      const ca = { x: (view.w / 2 - a.panX) / a.zoom, y: (view.h / 2 - a.panY) / a.zoom };
      const cb = { x: (view.w / 2 - b.panX) / b.zoom, y: (view.h / 2 - b.panY) / b.zoom };
      const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * e);
      const cx = ca.x + (cb.x - ca.x) * e, cy = ca.y + (cb.y - ca.y) * e;
      return { zoom, panX: view.w / 2 - cx * zoom, panY: view.h / 2 - cy * zoom };
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Favorites;
  else window.Favorites = Favorites;
}
