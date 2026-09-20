// Where pasted tiles land. Copy keeps the session records of the selected tiles (the same shape
// `collectSession` writes and undo's remove already stores), so paste can rebuild any tile type;
// all this module does is move that set as a block, without touching the originals.
{
  const hasBoard = (r) => !!(r && r.board && isFinite(Number(r.board.x)) && isFinite(Number(r.board.y)));
  const copy = (r) => JSON.parse(JSON.stringify(r)); // records are plain JSON by construction

  const STAGGER = 24; // canvas px between cascaded tiles, matching placeOnBoard's drop cascade

  const TileClipboard = {
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
      const bb = TileClipboard.bbox(out);
      if (!bb || !target || !isFinite(Number(target.x)) || !isFinite(Number(target.y))) return out;
      const dx = Number(target.x) - bb.x, dy = Number(target.y) - bb.y;
      for (const r of out) if (hasBoard(r)) { r.board.x = Number(r.board.x) + dx; r.board.y = Number(r.board.y) + dy; }
      return out;
    },
    // Where to put records that carry no board of their own (a tile that only ever lived in the
    // gallery). They cascade from just under the placed block instead of being scattered by the
    // board's own placement, so a paste stays one group of tiles. One point per boardless record,
    // in record order; empty when they are all placed, or when nothing in the set has a board.
    cascadePoints(records, gap = 8) {
      const list = Array.isArray(records) ? records : [];
      const loose = list.filter((r) => r && !hasBoard(r));
      const bb = TileClipboard.bbox(list);
      if (!loose.length || !bb) return [];
      return loose.map((_, i) => ({ x: bb.x + STAGGER * i, y: bb.y + bb.h + Number(gap || 0) + STAGGER * i }));
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TileClipboard;
  else window.TileClipboard = TileClipboard; // not `Clipboard`: that is a DOM global
}
