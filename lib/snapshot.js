// View windows are cameras on the main window's board. The main window sends a snapshot (its
// collectSession() output, every record carrying the tile's stable id) whenever the board changes;
// a view works out what to do with it here, so it never has to rebuild what it already shows.
{
  const sameRect = (a, b) => (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
  // what of a record is the tile itself rather than where it is or what it is doing right now:
  // a change here means the view rebuilds the tile (a loop, bookmarks, text, a tile setting)
  const VOLATILE = ['currentTime', 'paused', 'playbackRate', 'board', 'galleryH', 'sync', 'volume', 'muted'];
  const GROUP_OPTS = ['name', 'color', 'sync', 'sticky', 'loop', 'range', 'volume', 'muted', 'rate'];
  const Snapshot = {
    // The main window's once-a-second clock: how far a view's tile may be from the board's time
    // before it is put right (seconds), and whether its play state should follow the board's. A
    // tile this window acted on a moment ago is left alone: the board may not have heard yet.
    CLOCK_GRACE_MS: 1500,
    clockFix(local, remote, tol) { return Number.isFinite(remote) && Number.isFinite(local) && Math.abs(remote - local) > tol ? remote : null; },
    clockPlay(localPaused, boardPlaying, sinceLocalAction) {
      if (sinceLocalAction < Snapshot.CLOCK_GRACE_MS) return null;
      if (localPaused && boardPlaying) return 'play';
      if (!localPaused && !boardPlaying) return 'pause';
      return null;
    },
    // playback ops made in one tick go out as one message, one entry per tile and op (the last
    // value wins: a click that toggles play and broadcasts it is one play, not two)
    batch(ops) {
      const m = new Map();
      for (const o of ops) m.set(o.id + '|' + o.op, o);
      return [...m.values()];
    },
    // only ever move forward: a snapshot that left before the last one applied is ignored
    accept(lastSeq, seq) { return Number.isFinite(seq) && seq > (Number(lastSeq) || 0); },
    sig(rec) {
      const o = {};
      for (const k of Object.keys(rec || {}).sort()) if (!VOLATILE.includes(k)) o[k] = rec[k];
      return JSON.stringify(o);
    },
    // the snapshot's groups with member indexes turned into tile ids
    groupsOf(snap) {
      const videos = (snap && snap.videos) || [];
      return ((snap && snap.groups) || []).map((g) => {
        const opts = {};
        for (const k of GROUP_OPTS) if (g[k] !== undefined) opts[k] = g[k];
        return { id: g.id, members: (g.members || []).map((i) => videos[i] && videos[i].id).filter(Boolean), opts };
      });
    },
    // current: what the view shows, [{ id, board, galleryH?, sig? }]; currentGroups: groupsOf() of
    // the snapshot it last applied (or what it shows), so unchanged groups are left alone
    diff(current, incoming, currentGroups = []) {
      const have = new Map(current.map((c) => [c.id, c]));
      const seen = new Set();
      const out = { add: [], remove: [], move: [], rebuild: [], regroup: null };
      for (const rec of (incoming && incoming.videos) || []) {
        if (!rec || typeof rec.id !== 'string' || seen.has(rec.id)) continue;
        seen.add(rec.id);
        const c = have.get(rec.id);
        if (!c) { out.add.push(rec); continue; }
        if (c.sig !== undefined && c.sig !== Snapshot.sig(rec)) { out.rebuild.push(rec); continue; }
        if (!sameRect(c.board, rec.board) || (rec.galleryH !== undefined && c.galleryH !== undefined && c.galleryH !== rec.galleryH)) {
          out.move.push({ id: rec.id, board: rec.board ? { ...rec.board } : null, galleryH: rec.galleryH });
        }
      }
      for (const c of current) if (!seen.has(c.id)) out.remove.push(c.id);
      const groups = Snapshot.groupsOf(incoming);
      if (JSON.stringify(groups) !== JSON.stringify(currentGroups)) out.regroup = groups;
      return out;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Snapshot;
  else window.Snapshot = Snapshot;
}
