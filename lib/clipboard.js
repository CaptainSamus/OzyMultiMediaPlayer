// Where pasted tiles land. Copy keeps the session records of the selected tiles (the same shape
// `collectSession` writes and undo's remove already stores), so paste can rebuild any tile type;
// all this module does is move that set as a block, without touching the originals.
{
  const hasBoard = (r) => !!(r && r.board && isFinite(Number(r.board.x)) && isFinite(Number(r.board.y)));
  const copy = (r) => JSON.parse(JSON.stringify(r)); // records are plain JSON by construction

  const Clipboard = {
    // the rectangle the records occupy on the board, or null when none of them sit on it
    bbox(records) {
      const list = (Array.isArray(records) ? records : []).filter(hasBoard);
      if (!list.length) return null;
      const x = Math.min(...list.map((r) => Number(r.board.x)));
      const y = Math.min(...list.map((r) => Number(r.board.y)));
      const r1 = Math.max(...list.map((r) => Number(r.board.x) + (Number(r.board.w) || 0)));
      const b1 = Math.max(...list.map((r) => Number(r.board.y) + (Number(r.board.h) || 0)));
      return { x, y, w: r1 - x, h: b1 - y };
    },
    // deep copies with the whole set shifted so its top-left corner lands on `target`; relative
    // positions are preserved, and a record with no board comes back unchanged
    placeRecords(records, target) {
      const out = (Array.isArray(records) ? records : []).map(copy);
      const bb = Clipboard.bbox(out);
      if (!bb || !target || !isFinite(Number(target.x)) || !isFinite(Number(target.y))) return out;
      const dx = Number(target.x) - bb.x, dy = Number(target.y) - bb.y;
      for (const r of out) if (hasBoard(r)) { r.board.x = Number(r.board.x) + dx; r.board.y = Number(r.board.y) + dy; }
      return out;
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Clipboard;
  else window.Clipboard = Clipboard;
}
