// What Miro puts on the clipboard when you copy items on a board (Ctrl+C), read for its crops.
//
// Miro's REST API never says how a picture is cropped (only its cropped size), but Miro's own copy
// carries everything it needs to paste the items back exactly, crops included. In the copied HTML
// there is a block (miro-data-v1)…(/miro-data-v1): base64 of JSON whose every byte is shifted by a
// fixed amount (59 when this was written, 2026-11-10; the amount is worked out from the first byte,
// which is always "{"). Inside, data.objects[] are the items; an image's widgetData.json has
//   crop: { x, y, width, height, shape }   in the original file's pixels
//   resource: { id, width, height, name }  the original file
// and the object's initialId is the same id the REST API gives the item. So: copy the board in
// Miro (Ctrl+A, Ctrl+C), then Import from Miro, and every picture is cropped exactly as in Miro.
{
  const MiroClip = {
    // the decoded copy: { boardId, objects, version } or null when the HTML holds no Miro copy
    decode(html) {
      const m = String(html || '').match(/\(miro-data-v1\)([\s\S]*?)\(\/miro-data-v1\)/);
      if (!m) return null;
      let bytes;
      try { bytes = Buffer.from(m[1].replace(/[^A-Za-z0-9+/=_-]/g, ''), 'base64'); } catch { return null; }
      if (bytes.length < 2) return null;
      const k = (bytes[0] - 0x7b + 256) % 256; // the first byte is "{"
      if ((bytes[1] - k + 256) % 256 !== 0x22) return null; // and the second '"': else not what we know
      const plain = Buffer.alloc(bytes.length);
      for (let i = 0; i < bytes.length; i++) plain[i] = (bytes[i] - k + 256) % 256;
      let j;
      try { j = JSON.parse(plain.toString('utf8')); } catch { return null; }
      const objects = j && j.data && Array.isArray(j.data.objects) ? j.data.objects : null;
      if (!objects) return null;
      return { boardId: typeof j.boardId === 'string' ? j.boardId : null, objects, version: j.version };
    },
    // Each copied picture's crop as fractions of its file, by the item's id:
    // Map(id -> { x, y, w, h, shape }). A crop of the whole picture is { x: 0, y: 0, w: 1, h: 1 }.
    crops(decoded) {
      const out = new Map();
      for (const o of (decoded && decoded.objects) || []) {
        const wd = o && o.widgetData;
        if (!wd || wd.type !== 'image' || !wd.json) continue;
        const c = wd.json.crop, r = wd.json.resource;
        const id = o.initialId != null ? String(o.initialId) : null;
        if (!id || !c || !r || !(r.width > 0) || !(r.height > 0)) continue;
        const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
        const f = { x: n(c.x) / r.width, y: n(c.y) / r.height, w: n(c.width) / r.width, h: n(c.height) / r.height };
        if (![f.x, f.y, f.w, f.h].every(Number.isFinite) || f.w <= 0 || f.h <= 0) continue;
        out.set(id, { ...f, ...(typeof c.shape === 'string' ? { shape: c.shape } : {}) });
      }
      return out;
    },
    // Everything an import uses from the copy, by the item's id (2026-11-10):
    //   crops    Map(id -> crop)                       see crops()
    //   order    Map(id -> n)    front to back: the copy lists items back to front, as Miro stacks them
    //   heights  Map(id -> h)    how tall an item is on the board (the API leaves text heights out)
    //   styles   Map(id -> { bold, italic, underline, strike })  a text's or shape's text style
    //   positions Map(id -> { x, y })  an item's middle, in the copy's own coordinates (items in
    //            nothing else only): these differ from the API's by one fixed shift
    //   frames   [{ id, x, y, w, h, title, fill }]  frames, middle in the copy's coordinates (the
    //            API's item list can leave a frame out)
    //   lines    [{ id, a, b, via, kind, width, color, dash, start, end }]  lines and arrows (the
    //            API lists only those joining two items, and not where a loose end is; 2026-11-10)
    info(decoded) {
      const order = new Map(), heights = new Map(), styles = new Map(), positions = new Map(), frames = [];
      const hex = (n) => (Number.isInteger(n) && n >= 0 ? '#' + n.toString(16).padStart(6, '0') : null);
      const lines = MiroClip.lines(decoded);
      ((decoded && decoded.objects) || []).forEach((o, n) => {
        const id = o && o.initialId != null ? String(o.initialId) : null;
        const j = o && o.widgetData && o.widgetData.json;
        if (!id || !j) return;
        order.set(id, n);
        const p = j._position && j._position.offsetPx;
        if (p && !j._parent && Number.isFinite(p.x) && Number.isFinite(p.y)) positions.set(id, { x: p.x, y: p.y });
        if (o.widgetData.type === 'frame' && Number.isFinite(j.width) && Number.isFinite(j.height) && p) {
          let fill = null;
          try { fill = hex(JSON.parse(j.style || '{}').bc); } catch {}
          frames.push({ id, x: p.x, y: p.y, w: j.width, h: j.height, title: typeof j.text === 'string' ? j.text : '', fill });
        }
        const sc = j.scale && Number.isFinite(j.scale.scale) && j.scale.scale > 0 ? j.scale.scale : 1;
        if (j.size && Number.isFinite(j.size.height) && j.size.height > 0) heights.set(id, j.size.height * sc);
        if (typeof j.style === 'string' && /^\{/.test(j.style)) {
          try {
            const st = JSON.parse(j.style);
            if (['b', 'i', 'u', 's'].some((k) => k in st)) styles.set(id, { bold: st.b === 1, italic: st.i === 1, underline: st.u === 1, strike: st.s === 1 });
          } catch {}
        }
      });
      return { boardId: decoded ? decoded.boardId : null, crops: MiroClip.crops(decoded), order, heights, styles, positions, frames, lines, paints: MiroClip.paints(decoded) };
    },
    // Miro's lines (connectors) in the copy. Each end is either loose, a point in the copy's own
    // coordinates ({ x, y }), or on an item ({ item: id, fx, fy }: where on the item's box, 0..1).
    //   json.primary / json.secondary  { point, widgetIndex }  widgetIndex -1: loose; else the
    //                                  copied object (its id in the copy) the end is on
    //   json.points   [{ x, y }]       the bends a line was dragged through
    //   json.style    '{"lc": colour as a number, "t": thickness, "lt": 0 straight / 1 curved /
    //                  2 elbowed, "ls": 2 solid, "a_start" / "a_end": 0 no arrowhead}'
    // A loose end is in the board's own coordinates, also for a line inside a frame.
    lines(decoded) {
      const objects = (decoded && decoded.objects) || [];
      const byCopyId = new Map();
      for (const o of objects) if (o && o.id != null) byCopyId.set(o.id, o);
      const fin = (v) => typeof v === 'number' && Number.isFinite(v);
      const out = [];
      for (const o of objects) {
        const wd = o && o.widgetData;
        if (!wd || wd.type !== 'line' || !wd.json || o.initialId == null) continue;
        const j = wd.json;
        // DISABLED (Mark, 2026-11-10): a line's points are the board's own even when the line is in a
        // frame (unlike an item's offsetPx): on "Character list" the dividers in Frame 1 fall between
        // the rows of pictures only this way
        // let ox = 0, oy = 0;
        // const par = j._parent && byCopyId.get(j._parent.index);
        // if (par && par.widgetData && par.widgetData.type === 'frame') {
        //   const f = par.widgetData.json, fp = f._position && f._position.offsetPx;
        //   if (fp && fin(f.width) && fin(f.height)) { ox = fp.x - f.width / 2; oy = fp.y - f.height / 2; }
        // }
        const ox = 0, oy = 0;
        // (an end on an item with no point is one Miro places itself: the side facing the other end)
        const end = (e) => {
          if (!e) return null;
          if (e.widgetIndex === -1 || e.widgetIndex == null) return e.point && fin(e.point.x) && fin(e.point.y) ? { x: e.point.x + ox, y: e.point.y + oy } : null;
          const on = byCopyId.get(e.widgetIndex);
          if (!on || on.initialId == null) return null;
          const pt = e.point || {};
          return { item: String(on.initialId), fx: fin(pt.x) ? pt.x : null, fy: fin(pt.y) ? pt.y : null };
        };
        const a = end(j.primary), b = end(j.secondary);
        if (!a || !b) continue;
        let st = {};
        try { st = JSON.parse(j.style || '{}') || {}; } catch {}
        const via = Array.isArray(j.points) ? j.points.filter((p) => p && fin(p.x) && fin(p.y)).map((p) => ({ x: p.x + ox, y: p.y + oy })) : [];
        out.push({
          id: String(o.initialId), a, b, via,
          kind: st.lt === 1 ? 'curve' : st.lt === 2 ? 'elbow' : 'straight',
          width: fin(st.t) && st.t > 0 ? st.t : 2,
          color: Number.isInteger(st.lc) && st.lc >= 0 ? '#' + st.lc.toString(16).padStart(6, '0') : '#1a1a1a',
          dash: st.ls === 0 || st.ls === 1 ? 'dashed' : 'solid',
          start: st.a_start ? 'arrow' : 'none',
          end: st.a_end ? 'arrow' : 'none',
        });
      }
      return out;
    },
    // Pen drawings (2026-11-15): json.points [{ x, y }] (Miro's own units, any origin), json.style
    // '{"lc": colour as a number, "t": thickness, "lo": opacity 0..1}', json.scale. A drawing kept
    // inside another item (a note's scribble) is left out.
    paints(decoded) {
      const out = [];
      const fin = (v) => typeof v === 'number' && Number.isFinite(v);
      for (const o of (decoded && decoded.objects) || []) {
        const wd = o && o.widgetData, j = wd && wd.json;
        if (!wd || wd.type !== 'paint' || !j || o.initialId == null || j._parent || !Array.isArray(j.points)) continue;
        const points = j.points.filter((p) => p && fin(p.x) && fin(p.y)).map((p) => ({ x: p.x, y: p.y }));
        let st = {};
        try { st = JSON.parse(j.style || '{}') || {}; } catch {}
        const hex = Number.isInteger(st.lc) && st.lc >= 0 ? '#' + st.lc.toString(16).padStart(6, '0') : '#1a1a1a';
        const a = fin(st.lo) && st.lo < 1 ? Math.round(Math.max(0, st.lo) * 255).toString(16).padStart(2, '0') : '';
        out.push({ id: String(o.initialId), points, color: hex + a, width: fin(st.t) && st.t > 0 ? st.t : 2, scale: j.scale && fin(j.scale.scale) ? j.scale.scale : 1 });
      }
      return out;
    },
    // a crop that is the whole picture (nothing to crop)
    isWhole(c) { return !!c && c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = MiroClip;
  else window.MiroClip = MiroClip;
}
