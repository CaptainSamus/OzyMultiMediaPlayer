// Miro import: the rules that turn a Miro board (the items its REST API v2 lists) into an Ozy
// session. No network and no files here, so every rule is tested against plain data; the part that
// talks to Miro and downloads the pictures is lib/miroimport.js (main process).
//
// Mark, 2026-11-06: bring whole boards (mostly lots of images and text) over from Miro.
//
// Miro's coordinates, as its API gives them:
//   position { x, y, origin: 'center', relativeTo: 'canvas_center' | 'parent_top_left' }
//   geometry { width, height, rotation }
// x / y is the item's middle. An item inside a frame (parent: { id }) is placed from the frame's
// top-left corner. One Miro unit is one Ozy board pixel, so text sizes carry over as they are.
{
  const LT = typeof module !== 'undefined' && module.exports ? require('./linetile.js') : window.LineTile;
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{3})$/i;

  // Miro's named sticky-note colours, as close as the eye says
  const STICKY = {
    gray: '#f5f6f8', light_yellow: '#fff9b1', yellow: '#f5d128', orange: '#ff9d48', light_green: '#d5f692',
    green: '#c9df56', dark_green: '#93d275', cyan: '#67c6c0', light_pink: '#ffcee0', pink: '#ea94bb',
    violet: '#be88c7', red: '#f16c7f', light_blue: '#a6ccf5', blue: '#6cd8fa', dark_blue: '#9ea9ff', black: '#000000',
  };
  // Miro's fonts -> the nearest one Windows always has (lib/texttile.js lists what Ozy can show)
  const FONTS = {
    arial: 'Arial', abril_fatface: 'Georgia', bangers: 'Impact', eb_garamond: 'Georgia', georgia: 'Georgia', graduate: 'Impact',
    gravitas_one: 'Impact', fredoka_one: 'Trebuchet MS', nixie_one: 'Trebuchet MS', open_sans: 'Segoe UI', permanent_marker: 'Comic Sans MS',
    pt_sans: 'Segoe UI', pt_sans_narrow: 'Segoe UI', pt_serif: 'Georgia', rammetto_one: 'Impact', roboto: 'Segoe UI',
    roboto_condensed: 'Segoe UI', roboto_slab: 'Georgia', caveat: 'Comic Sans MS', times_new_roman: 'Times New Roman',
    titan_one: 'Impact', lemon_tuesday: 'Comic Sans MS', roboto_mono: 'Consolas', noto_sans: 'Segoe UI', plex_sans: 'Segoe UI',
    plex_serif: 'Georgia', plex_mono: 'Consolas', spoof: 'Segoe UI', tiempos_text: 'Georgia', formular: 'Segoe UI',
  };
  const font = (f) => FONTS[String(f || '').toLowerCase()] || 'Segoe UI';
  // a Miro colour: '#rrggbb', a sticky colour name, or 'transparent' (null)
  const colour = (c, fallback = null) => {
    if (typeof c !== 'string') return fallback;
    const s = c.trim().toLowerCase();
    if (s === 'transparent' || s === '') return null;
    if (HEX.test(s)) return s.length === 4 ? '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3] : s;
    return STICKY[s] || fallback;
  };
  // '#rrggbb' at an opacity from 0 to 1 -> '#rrggbbaa'
  const withAlpha = (hex, a) => {
    if (!hex) return '#00000000';
    const n = clamp(num(a, 1), 0, 1);
    return n >= 1 ? hex : hex + Math.round(n * 255).toString(16).padStart(2, '0');
  };

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const Miro = {
    STICKY, FONTS, font, colour,

    // the board id from what the user pastes: a board link (…/app/board/uXjVK1234=/?…) or the bare id
    boardId(input) {
      const s = String(input || '').trim();
      const m = s.match(/\/app\/board\/([^/?#\s]+)/i);
      let id = m ? m[1] : s;
      try { id = decodeURIComponent(id); } catch {}
      return /^[A-Za-z0-9_\-=+]{6,64}$/.test(id) ? id : null;
    },

    // Miro's rich text (a little HTML) as the plain text Ozy keeps: paragraphs and <br> are new
    // lines, list items get a bullet, every other tag goes, entities are decoded
    plainText(html) {
      let s = String(html || '');
      s = s.replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*li[^>]*>/gi, '• ')
        .replace(/<\/\s*(p|div|li|h[1-6]|ul|ol|blockquote)\s*>/gi, '\n')
        .replace(/<[^>]*>/g, '');
      s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
        if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all; }
        return ENTITIES[e.toLowerCase()] ?? all;
      });
      return s.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    },

    // Every item's box in board coordinates: { x, y, w, h } top-left, plus its rotation. Items
    // inside a frame are placed from the frame's corner; a frame inside a frame works the same
    // way. An item whose parent is missing (or a loop) is placed as if it had none.
    // heights: Map(id -> h) from Miro's copy of the board (the API leaves text heights out)
    boxes(items, { heights = null } = {}) {
      const byId = new Map();
      for (const it of items || []) if (it && it.id != null) byId.set(String(it.id), it);
      const out = new Map();
      const visiting = new Set();
      const sizeOf = (it) => {
        const g = it.geometry || {};
        let w = num(g.width, 0), h = num(g.height, 0);
        if (!(w > 0) && h > 0) w = h;
        if (!(h > 0) && heights && heights.get(String(it.id)) > 0) h = heights.get(String(it.id)); // its real height, from Miro's copy
        if (!(h > 0) && w > 0) {
          // a text box can come with only its width: as tall as its lines at its size (Ozy's own
          // text box then settles on the real height, around the same middle); anything else is square
          if (it.type === 'text') {
            const lines = Math.max(1, Miro.plainText(it.data && it.data.content).split(/\n/).length);
            h = lines * clamp(num((it.style || {}).fontSize, 14), 1, 20000) * 1.4; // (Miro's line height)
          } else h = w;
        }
        if (!(w > 0)) { w = 200; h = 200; }
        return { w, h };
      };
      const boxOf = (it) => {
        const key = String(it.id);
        if (out.has(key)) return out.get(key);
        const p = it.position || {};
        const { w, h } = sizeOf(it);
        let cx = num(p.x, 0), cy = num(p.y, 0);
        const parentId = it.parent && it.parent.id != null ? String(it.parent.id) : null;
        const parent = parentId ? byId.get(parentId) : null;
        const rel = String(p.relativeTo || (parent ? 'parent_top_left' : 'canvas_center'));
        if (parent && rel !== 'canvas_center' && !visiting.has(key)) {
          visiting.add(key);
          const pb = boxOf(parent);
          visiting.delete(key);
          if (rel === 'parent_center') { cx += pb.x + pb.w / 2; cy += pb.y + pb.h / 2; }
          else { cx += pb.x; cy += pb.y; }
        }
        const b = { x: cx - w / 2, y: cy - h / 2, w, h, rotation: num((it.geometry || {}).rotation, 0) };
        out.set(key, b);
        return b;
      };
      for (const it of byId.values()) boxOf(it);
      return out;
    },

    // What gets downloaded for an image item: the link to its full-size picture and to Miro's
    // own smaller preview (shown while the tile is small on screen, so a board of thousands of
    // photos does not decode them all at full size). Both need the token; Miro answers with
    // where to fetch the file itself (redirect=false).
    imageLinks(item) {
      // (a link card has no picture of its own, but Miro keeps a preview picture of the page)
      const d = (item && item.data) || {};
      const raw = typeof d.imageUrl === 'string' ? d.imageUrl : item && item.type === 'embed' && typeof d.previewUrl === 'string' ? d.previewUrl : '';
      if (!raw) return null;
      let u;
      try { u = new URL(raw); } catch { return null; }
      const at = (format) => { const v = new URL(u.toString()); v.searchParams.set('format', format); v.searchParams.set('redirect', 'false'); return v.toString(); };
      return { original: at('original'), preview: at('preview') };
    },

    // which stored picture an image item shows (the last part of its link): two items placed from
    // the same upload share it, and the picture is downloaded once for both
    resourceId(item) {
      const d = (item && item.data) || {};
      const raw = typeof d.imageUrl === 'string' ? d.imageUrl : item && item.type === 'embed' && typeof d.previewUrl === 'string' ? d.previewUrl : '';
      try { const m = new URL(raw).pathname.match(/\/resources\/images\/([^/]+)\/?$/); return m ? m[1] : null; } catch { return null; }
    },
    // a file name for a picture, from its Miro title when it has one: safe on Windows, short,
    // unique in `taken` (lower-cased names already used); `ext` like '.jpg'
    fileName(item, ext, taken) {
      const title = item && item.data && typeof item.data.title === 'string' ? item.data.title : '';
      let base = title.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
      if (!base || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = 'image-' + String(item && item.id || 'x');
      base = base.slice(0, 80);
      let name = base + ext, n = 2;
      while (taken.has(name.toLowerCase())) name = `${base} (${n++})${ext}`;
      taken.add(name.toLowerCase());
      return name;
    },

    // The file extension for a downloaded picture: from its content type, else its link
    extFor(contentType, url) {
      const t = String(contentType || '').toLowerCase().split(';')[0].trim();
      const map = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/svg': '.svg', 'image/bmp': '.bmp', 'image/avif': '.avif' };
      if (map[t]) return map[t];
      const m = String(url || '').split('?')[0].match(/\.(jpe?g|png|gif|webp|svg|bmp|avif)$/i);
      return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '.jpg';
    },

    // Which layer each kind of item goes on: frames at the back, then pictures, shapes, notes,
    // and text on top. (Miro's API does not say which item is in front of which.)
    LAYER: { frame: 0, image: 1, document: 1, embed: 2, shape: 3, card: 4, app_card: 4, sticky_note: 5, text: 6 },

    // The session records for a board. files: Map(itemId -> { path, thumb }) for the pictures
    // that were downloaded. Returns { records, report }, report counting what came over by kind
    // and what did not (with why).
    // How much smaller the board comes into Ozy. A Miro board can be enormous in its own units
    // (Mark's "Character list": 1.75 million wide, pictures ~5700 tall, text up to 7000), far past
    // what Ozy's zoom reaches and huge next to a video dropped on it. Everything is scaled by the
    // same amount, so the layout is exactly the same, until a typical picture is about TARGET tall.
    // A board already at Ozy's size (pictures up to ~TARGET tall) comes in as it is.
    SCALE_TARGET: 600,
    importScale(items) {
      const hs = (items || []).filter((it) => it && it.type === 'image').map((it) => num((it.geometry || {}).height, 0)).filter((h) => h > 0).sort((a, b) => a - b);
      const all = hs.length ? hs : (items || []).map((it) => num((it.geometry || {}).height, 0)).filter((h) => h > 0).sort((a, b) => a - b);
      if (!all.length) return 1;
      const median = all[Math.floor(all.length / 2)];
      if (median <= Miro.SCALE_TARGET * 1.5) return 1;
      const k = Miro.SCALE_TARGET / median;
      return Number(k.toPrecision(3));
    },

    // The part of a picture Miro shows, when its shape on the board is not the file's: Miro's API
    // says how big the cropped picture is but not which part of it the crop keeps, so the middle is
    // kept (guessed: true) and the crop can be moved in Ozy. Fractions of the file, or null (uncropped).
    centreCrop(boardAspect, fileW, fileH) {
      if (!(boardAspect > 0) || !(fileW > 0) || !(fileH > 0)) return null;
      const fa = fileW / fileH;
      if (Math.abs(boardAspect - fa) / fa < 0.01) return null;
      if (boardAspect < fa) { const w = boardAspect / fa; return { x: (1 - w) / 2, y: 0, w, h: 1, guessed: true }; }
      const h = fa / boardAspect;
      return { x: 0, y: (1 - h) / 2, w: 1, h, guessed: true };
    },

    // crops: Map(itemId -> { x, y, w, h }) found another way (miro-crops.json beside the board: worked
    // out from screenshots of the Miro board, since Miro's API keeps them to itself); those win
    // over the centre guess
    // a crop from outside (fractions of the file): inside the picture, not too small, or null
    cleanCrop(c) {
      if (!c || typeof c !== 'object') return null;
      const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
      const w = clamp(n(c.w), 0.02, 1), h = clamp(n(c.h), 0.02, 1);
      if (!(w > 0) || !(h > 0)) return null;
      return { x: clamp(n(c.x) || 0, 0, 1 - w), y: clamp(n(c.y) || 0, 0, 1 - h), w, h };
    },

    // copy: what Miro's own copy of the board says (lib/miroclip.js info): { order, heights, styles }
    toRecords(items, files, { youtube = null, scale = null, crops = null, copy = null } = {}) {
      const list = (items || []).filter((it) => it && it.id != null && typeof it.type === 'string');
      const report0 = {};
      // the one fixed shift between the copy's coordinates and the API's (the middle of the items
      // both know): copy = API + shift
      let shift = null;
      if (copy && copy.positions && copy.positions.size) {
        const pre = Miro.boxes(list);
        const dx = [], dy = [];
        for (const [id, p] of copy.positions) { const b = pre.get(id); if (b) { dx.push(p.x - (b.x + b.w / 2)); dy.push(p.y - (b.y + b.h / 2)); } }
        const med = (a) => a.slice().sort((u, v) => u - v)[a.length >> 1];
        if (dx.length >= 3) shift = { x: med(dx), y: med(dy) };
      }
      // a frame in Miro's copy that the API's list left out: added, placed through that shift
      if (copy && copy.frames && copy.frames.length && shift) {
        const known = new Set(list.map((it) => String(it.id)));
        {
          const sx = shift.x, sy = shift.y;
          for (const f of copy.frames) {
            if (known.has(f.id)) continue;
            list.push({ id: f.id, type: 'frame', data: { title: f.title }, style: { fillColor: f.fill || '#ffffff' }, position: { x: f.x - sx, y: f.y - sy, relativeTo: 'canvas_center' }, geometry: { width: f.w, height: f.h } });
            report0.framesFromCopy = (report0.framesFromCopy || 0) + 1;
          }
        }
      }
      const boxes = Miro.boxes(list, { heights: copy && copy.heights });
      const k = scale > 0 ? scale : Miro.importScale(list);
      // Miro's lines and arrows, from its copy (2026-11-10): each joins the copy's order like any item
      if (copy && Array.isArray(copy.lines) && copy.lines.length) {
        for (const ln of copy.lines) {
          const abs = Miro.linePoints(ln, { boxes, shift });
          if (abs) list.push({ id: ln.id, type: 'line', abs, line: ln });
          else report0.linesLost = (report0.linesLost || 0) + 1;
        }
      }
      const report = { made: {}, skipped: {}, rotated: 0, missingImages: 0, ...report0 };
      const made = (k) => { report.made[k] = (report.made[k] || 0) + 1; };
      const skip = (k) => { report.skipped[k] = (report.skipped[k] || 0) + 1; };
      const out = [];
      // Front to back: Miro's API does not say which item is in front of which. Frames go at the
      // back, notes and text on top, and everything between (pictures, shapes, cards, links) bigger
      // behind smaller: a big shape under a group of pictures is their background, a small label
      // on a picture sits on it (2026-11-06: shapes used to cover the pictures on them).
      const area = (it) => { const bx = boxes.get(String(it.id)); return bx ? bx.w * bx.h : 0; };
      const band = (t) => (t === 'frame' ? 0 : t === 'sticky_note' ? 2 : t === 'text' ? 3 : 1);
      let ordered = list.map((it, i) => ({ it, i, a: area(it) })).sort((a, b) => (band(a.it.type) - band(b.it.type)) || (band(a.it.type) === 1 ? b.a - a.a : 0) || a.i - b.i);
      // With Miro's copy of the board, Miro's own order instead (it lists items back to front, as
      // they are stacked on the board). Anything the copy left out goes at the back, so it can
      // never cover what Miro shows on top (2026-11-10).
      const order = copy && copy.order && copy.order.size ? copy.order : null;
      if (order) {
        report.layersFromMiro = true;
        // (frames stay at the very back whatever the copy's order: Miro draws them behind everything)
        const at = (it) => (it.type === 'frame' ? -2 : order.has(String(it.id)) ? order.get(String(it.id)) : -1);
        ordered = ordered.map((o, n) => ({ ...o, n })).sort((a, b) => at(a.it) - at(b.it) || a.n - b.n);
      }
      // a text's bold / italic / underline / strike-through, for the whole text: Miro's copy says
      // so; else the text itself, when all of it is wrapped in <strong>, <em>, <u> or <s>
      const textLook = (it) => {
        const known = copy && copy.styles && copy.styles.get(String(it.id));
        const html = String((it.data && it.data.content) || '');
        const all = (tags) => {
          if (!Miro.plainText(html)) return false;
          const rest = html.replace(new RegExp(String.raw`<(${tags})\b[^>]*>[\s\S]*?<\/\1\s*>`, 'gi'), '');
          return !Miro.plainText(rest);
        };
        const fromHtml = { bold: all('strong|b'), italic: all('em|i'), underline: all('u'), strike: all('s|strike|del') };
        if (!known) return fromHtml;
        return { bold: known.bold || fromHtml.bold, italic: known.italic || fromHtml.italic, underline: known.underline || fromHtml.underline, strike: known.strike || fromHtml.strike };
      };
      // Miro sets text with about 1.4 lines' height per line (its copy: 20 px tall for a 14 px line)
      const LINE = 1.4;
      for (const { it } of ordered) {
        if (it.type === 'line') {
          const ln = it.line;
          // (2026-11-15) an end on an item stays on it in Ozy too (where on its box), and an elbowed or
          // curved line keeps being routed that way when the item moves
          const route = ln.kind === 'elbow' || ln.kind === 'curve' ? ln.kind : 'straight';
          const style = { color: ln.color, width: ln.width, dash: ln.dash, start: ln.start, end: ln.end, route };
          const r = Miro.lineBox(it.abs, style);
          if (!r) { skip('line'); continue; }
          const endOf = (e, p) => {
            const b = e && e.item != null ? boxes.get(String(e.item)) : null;
            return b && b.w > 0 && b.h > 0 ? { id: 'miro-' + String(e.item).slice(0, 58), fx: (p.x - b.x) / b.w, fy: (p.y - b.y) / b.h } : null;
          };
          const ends = [endOf(ln.a, it.abs[0]), endOf(ln.b, it.abs[it.abs.length - 1])];
          out.push({ id: 'miro-' + String(it.id).slice(0, 58), type: 'line', board: r.board, points: r.points, style, ...(ends.some(Boolean) ? { ends } : {}) });
          made(ln.start !== 'none' || ln.end !== 'none' ? 'arrow' : 'line');
          continue;
        }
        const b = boxes.get(String(it.id));
        const board = { x: b.x, y: b.y, w: b.w, h: b.h };
        const st = it.style || {};
        const data = it.data || {};
        const id = 'miro-' + String(it.id).slice(0, 58);
        if (b.rotation && Math.abs(b.rotation % 360) > 0.5) report.rotated++;
        const text = (txt, style) => ({ id, type: 'text', text: txt, style, board });
        switch (it.type) {
          case 'image': {
            const f = files && files.get(String(it.id));
            if (!f || !f.path) { report.missingImages++; skip('image (not downloaded)'); break; }
            const known = crops && crops.get(String(it.id));
            const guess = f.size ? Miro.centreCrop(b.w / b.h, f.size.w, f.size.h) : null;
            // A known crop (Miro's own, read from its copy of the board, or one worked out from a
            // screenshot) is used as it is: also when it keeps the file's shape (zoomed in, not
            // trimmed), and when it is the whole picture (then nothing is cropped). Else the middle.
            const whole = known && known.x <= 0.001 && known.y <= 0.001 && known.w >= 0.999 && known.h >= 0.999;
            const crop = known ? (whole ? null : Miro.cleanCrop(known)) : guess;
            if (crop) report.cropped = (report.cropped || 0) + 1;
            if (known && crop) { report.cropsKnown = (report.cropsKnown || 0) + 1; if (known.source === 'miro') report.cropsFromMiro = (report.cropsFromMiro || 0) + 1; }
            out.push({ id, type: 'image', path: f.path, ...(f.thumb ? { thumb: f.thumb } : {}), ...(crop ? { crop } : {}), aspect: b.w / b.h, board, bookmarks: [], sync: null, volume: 0, muted: false, playbackRate: 1, paused: true, currentTime: 0 });
            made('image');
            break;
          }
          case 'text': {
            const t = Miro.plainText(data.content);
            if (!t) { skip('text (empty)'); break; }
            const fill = colour(st.fillColor);
            out.push(text(t, {
              font: font(st.fontFamily), size: clamp(num(st.fontSize, 14), 1, 20000), color: colour(st.color, '#1a1a1a'),
              align: ['left', 'center', 'right'].includes(st.textAlign) ? st.textAlign : 'left',
              bubble: !!fill, fill: withAlpha(fill || '#ffffff', st.fillOpacity), outline: '#00000000', outlineWidth: 0, radius: 0, padding: 0,
              lineHeight: LINE, ...textLook(it),
            }));
            made('text');
            break;
          }
          case 'sticky_note': {
            out.push(text(Miro.plainText(data.content), {
              // Miro sizes a note's text itself: start big for the note, and Ozy shrinks it until it fits
              font: 'Segoe UI', size: clamp(Math.round(Math.min(b.w, b.h) / 4.5), 12, 200), color: colour(st.fillColor) === '#000000' ? '#ffffff' : '#1a1a1a',
              align: ['left', 'center', 'right'].includes(st.textAlign) ? st.textAlign : 'center',
              valign: { top: 'top', middle: 'middle', bottom: 'bottom' }[st.textAlignVertical] || 'middle',
              bubble: true, fill: colour(st.fillColor, STICKY.light_yellow), outline: '#00000000', outlineWidth: 0,
              box: 'fixed', fit: true, radius: 2, shadow: true, padding: 14, lineHeight: LINE, ...textLook(it),
            }));
            made('sticky note');
            break;
          }
          case 'shape': {
            const shape = String(data.shape || 'rectangle');
            const fill = colour(st.fillColor);
            const border = colour(st.borderColor);
            // (2026-11-15) the outlines Ozy draws itself; the rest stay boxes
            const outline = { triangle: 'triangle', rhombus: 'diamond', hexagon: 'hexagon', star: 'star', right_arrow: 'arrow', parallelogram: 'parallelogram' }[shape] || null;
            const round = outline ? 'outline' : { round_rectangle: 'round', circle: 'ellipse', oval: 'ellipse', ellipse: 'ellipse' }[shape] || (shape === 'rectangle' || shape === 'square' ? 'rect' : null);
            out.push(text(Miro.plainText(data.content), {
              font: font(st.fontFamily), size: clamp(num(st.fontSize, 14), 1, 20000), color: colour(st.color, '#1a1a1a'),
              align: ['left', 'center', 'right'].includes(st.textAlign) ? st.textAlign : 'center',
              valign: { top: 'top', middle: 'middle', bottom: 'bottom' }[st.textAlignVertical] || 'middle',
              bubble: true, fill: withAlpha(fill || '#ffffff', fill ? st.fillOpacity : 0),
              outline: border && st.borderStyle !== 'none' ? withAlpha(border, st.borderOpacity) : '#00000000', outlineWidth: clamp(num(st.borderWidth, 2), 0, 20),
              box: 'fixed', shape: outline || (round === 'ellipse' ? 'ellipse' : 'box'), radius: round === 'round' ? 16 : 0, padding: 8, lineHeight: LINE, ...textLook(it),
            }));
            made(round ? 'shape' : 'shape (drawn as a box: ' + shape + ')');
            break;
          }
          case 'frame': {
            // the frame is an empty box; its name sits just above it, outside, as Miro shows it
            const fill = colour(st.fillColor, '#ffffff');
            out.push(text('', {
              font: 'Segoe UI', size: 14, color: '#555555', align: 'left', valign: 'top',
              bubble: true, fill: withAlpha(fill || '#ffffff', fill ? 1 : 0), outline: '#00000022', outlineWidth: 1, box: 'fixed', radius: 0, padding: 12,
            }));
            const title = String(data.title || '').trim();
            /* DISABLED (Mark, 2026-11-15): Ozy has real frames now; the title is the frame's own
            if (title) {
              const size = clamp(Math.round(Math.max(b.w, b.h) / 70), 14, 160);
              out.push({ id: id + '-title', type: 'text', text: title, board: { x: b.x, y: b.y - size * 1.6, w: Math.max(200, b.w * 0.6), h: size * 1.25 },
                style: { font: 'Segoe UI', size, color: '#5a5a5a', align: 'left', bubble: false, fill: '#ffffff', outline: '#00000000', outlineWidth: 0 } });
            }
            */
            out[out.length - 1].frame = { title };
            made('frame');
            break;
          }
          case 'card':
          case 'app_card': {
            const title = Miro.plainText(data.title), desc = Miro.plainText(data.description);
            out.push(text([title, desc].filter(Boolean).join('\n\n') || 'Card', {
              font: 'Segoe UI', size: 16, color: '#1a1a1a', align: 'left', valign: 'top', bubble: true, fill: '#ffffff',
              outline: colour(st.cardTheme, '#2d9bf0'), outlineWidth: 3, box: 'fixed', radius: 6, padding: 12,
            }));
            made('card');
            break;
          }
          case 'embed': {
            const url = String(data.url || '');
            const yt = youtube ? youtube(url) : null;
            // a link card with its page's preview picture: the picture, where the card was
            const pf = files && files.get(String(it.id));
            if (!yt && pf && pf.path) {
              const crop = pf.size ? Miro.centreCrop(b.w / b.h, pf.size.w, pf.size.h) : null;
              out.push({ id, type: 'image', path: pf.path, ...(pf.thumb ? { thumb: pf.thumb } : {}), ...(crop ? { crop } : {}), aspect: b.w / b.h, board, bookmarks: [], sync: null, volume: 0, muted: false, playbackRate: 1, paused: true, currentTime: 0 });
              made('link (as its preview picture)');
              break;
            }
            if (yt) { out.push({ id, type: 'youtube', kind: yt.kind || 'video', url, title: String(data.title || ''), aspect: b.w / b.h, board, currentTime: 0, volume: 1, muted: false, playbackRate: 1, paused: true, bookmarks: [], sync: null }); made('YouTube'); break; }
            out.push(text(`🔗 ${String(data.title || '').trim() || url}\n${url}`, { font: 'Segoe UI', size: 16, color: '#1a1a1a', align: 'left', valign: 'top', bubble: true, fill: '#f2f2f2', outline: '#00000033', outlineWidth: 1, box: 'fixed', radius: 6, padding: 12 }));
            made('link');
            break;
          }
          case 'document': {
            out.push(text(`📄 ${String(data.title || 'Document').trim()}`, { font: 'Segoe UI', size: 18, color: '#1a1a1a', align: 'center', valign: 'middle', bubble: true, fill: '#f2f2f2', outline: '#00000033', outlineWidth: 1, box: 'fixed', radius: 6, padding: 12 }));
            made('document (as a label)');
            break;
          }
          case 'paint': {
            // (2026-11-15) a pen drawing: its points from Miro's copy, around the middle the API gives
            const pt = copy && copy.paints && copy.paints.find((x) => x.id === String(it.id));
            if (!pt || pt.points.length < 2) { skip('drawing (copy the board in Miro first)'); break; }
            const xs = pt.points.map((q) => q.x), ys = pt.points.map((q) => q.y);
            const pcx = (Math.min(...xs) + Math.max(...xs)) / 2, pcy = (Math.min(...ys) + Math.max(...ys)) / 2;
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2, k = pt.scale > 0 ? pt.scale : 1;
            const abs = pt.points.map((q) => ({ x: cx + (q.x - pcx) * k, y: cy + (q.y - pcy) * k }));
            const style = { color: pt.color, width: pt.width * k, dash: 'solid', start: 'none', end: 'none', route: 'straight' };
            const r = Miro.lineBox(abs, style);
            if (!r) { skip('drawing'); break; }
            out.push({ id, type: 'line', freehand: true, board: r.board, points: r.points, style });
            made('drawing');
            break;
          }
          default:
            skip(it.type);
        }
      }
      // the same scale for everything, and each item's rotation (degrees, clockwise, as Miro has it)
      report.scale = k;
      const rot = new Map(list.map((it) => [String(it.id), num((it.geometry || {}).rotation, 0)]));
      for (const r of out) {
        const deg = rot.get(String(r.id).replace(/^miro-/, '').replace(/-title$/, '')) || 0;
        if (deg && Math.abs(deg % 360) > 0.05 && !/-title$/.test(r.id)) r.rotation = ((deg % 360) + 360) % 360;
        if (k === 1) continue;
        r.board = { x: r.board.x * k, y: r.board.y * k, w: r.board.w * k, h: r.board.h * k };
        if (r.style) for (const key of ['size', 'padding', 'radius', 'outlineWidth', 'width']) if (typeof r.style[key] === 'number') r.style[key] = r.style[key] * k; // (width: a line's thickness)
      }
      return { records: out, report };
    },

    // A line from Miro's copy (lib/miroclip.js lines) as points in the API's board coordinates:
    // a loose end through the copy's shift, an end on an item at its place on the item's box. An
    // elbowed or curved line Miro routes itself is routed the same way here: an elbow leaves an
    // item square to the side it is on, a curve bends out the same way. null when an end cannot be
    // placed (on an item that was not brought over, or loose with no shift known).
    linePoints(ln, { boxes, shift = null } = {}) {
      if (!ln || !ln.a || !ln.b) return null;
      const side = (fx, fy) => (fx <= 0.01 ? { x: -1, y: 0 } : fx >= 0.99 ? { x: 1, y: 0 } : fy <= 0.01 ? { x: 0, y: -1 } : fy >= 0.99 ? { x: 0, y: 1 } : null);
      const at = (e) => {
        if (e.item != null) {
          const b = boxes && boxes.get(String(e.item));
          if (!b) return null;
          if (e.fx == null || e.fy == null) return { auto: b, x: b.x + b.w / 2, y: b.y + b.h / 2, dir: null }; // placed below
          return { x: b.x + num(e.fx, 0.5) * b.w, y: b.y + num(e.fy, 0.5) * b.h, dir: side(num(e.fx, 0.5), num(e.fy, 0.5)) };
        }
        if (!shift || !Number.isFinite(e.x) || !Number.isFinite(e.y)) return null;
        return { x: e.x - shift.x, y: e.y - shift.y, dir: null };
      };
      const A = at(ln.a), B = at(ln.b);
      if (!A || !B) return null;
      // an end Miro places itself: the middle of the item's side that faces the other end
      const facing = (P, Q) => {
        const b = P.auto, dx = (Q.x - P.x) / b.w, dy = (Q.y - P.y) / b.h;
        const fx = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 1 : 0) : 0.5, fy = Math.abs(dx) >= Math.abs(dy) ? 0.5 : (dy >= 0 ? 1 : 0);
        P.x = b.x + fx * b.w; P.y = b.y + fy * b.h; P.dir = side(fx, fy); delete P.auto;
      };
      const QA = { x: A.x, y: A.y }, QB = { x: B.x, y: B.y }; // (both measured from where the other was first)
      if (A.auto) facing(A, QB);
      if (B.auto) facing(B, QA);
      const via = shift ? (ln.via || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: p.x - shift.x, y: p.y - shift.y })) : [];
      // (2026-11-15) elbows and curves are routed by the rules Ozy draws its own lines with
      const pts = (ln.kind === 'elbow' || ln.kind === 'curve') && !via.length ? LT.route(A, B, ln.kind) : [A, ...via, B];
      const plain = (p) => ({ x: p.x, y: p.y });
      // (a bend on top of its neighbour is no bend)
      return pts.map(plain).filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) > 1e-9);
    },
    // the line's box and its points as fractions of it (lib/linetile.js)
    lineBox(abs, style) { return LT.fromAbs(abs, style); },

    // the report as a few lines a person reads
    describe(report, connectors = 0) {
      const lines = [];
      // '30 frames', '1 picture', '2 shapes (drawn as a box: triangle)'
      const NAMES = { image: ['picture', 'pictures'], text: ['text box', 'text boxes'], 'sticky note': ['sticky note', 'sticky notes'], frame: ['frame', 'frames'], shape: ['shape', 'shapes'], card: ['card', 'cards'], YouTube: ['YouTube video', 'YouTube videos'], link: ['link', 'links'], line: ['line', 'lines'], arrow: ['arrow', 'arrows'], drawing: ['drawing', 'drawings'] };
      const say = (k, n) => {
        const m = String(k).match(/^([^(]+?)(\s*\(.*\))?$/) || [null, k, ''];
        const w = NAMES[m[1]] || [m[1], /s$/.test(m[1]) ? m[1] : m[1] + 's'];
        return `${n} ${n === 1 ? w[0] : w[1]}${m[2] || ''}`;
      };
      const made = Object.entries(report.made || {}).map(([k, n]) => say(k, n));
      if (made.length) lines.push('Brought over: ' + made.join(', ') + '.');
      const skipped = Object.entries(report.skipped || {}).map(([k, n]) => say(k, n));
      // DISABLED (Mark, 2026-11-10): Ozy has lines and arrows now; they come from what was copied in Miro
      // if (connectors) skipped.push(`${connectors} arrow${connectors === 1 ? '' : 's'} (Ozy has no arrows yet)`);
      const drawn = ((report.made || {}).line || 0) + ((report.made || {}).arrow || 0);
      if (connectors && !drawn && !report.layersFromMiro) skipped.push(`${connectors} arrow${connectors === 1 ? '' : 's'} (Miro's API leaves lines out: copy the board in Miro first, see below)`);
      if (report.linesLost) skipped.push(`${report.linesLost} line${report.linesLost === 1 ? '' : 's'} joined to something that did not come over`);
      if (skipped.length) lines.push('Not brought over: ' + skipped.join(', ') + '.');
      const guessed = (report.cropped || 0) - (report.cropsKnown || 0);
      const fromMiro = report.cropsFromMiro || 0, fromShots = (report.cropsKnown || 0) - fromMiro;
      if (fromMiro) lines.push(`${fromMiro} cropped picture${fromMiro === 1 ? ' is' : 's are'} cropped exactly as in Miro (read from what you copied in Miro).`);
      if (fromShots) lines.push(`${fromShots} cropped picture${fromShots === 1 ? ' is' : 's are'} cropped as in Miro (worked out from screenshots of the board).`);
      // (with a copy of the board in hand, a picture it left out is one Miro does not copy: locked)
      if (guessed > 0 && report.layersFromMiro) lines.push(`${guessed} cropped picture${guessed === 1 ? ' was' : 's were'} not in what you copied in Miro (Miro does not copy locked items), so ${guessed === 1 ? 'it shows' : 'they show'} the middle of the picture. Unlock ${guessed === 1 ? 'it' : 'them'} in Miro and copy again, or right-click → Crop… here.`);
      else if (guessed > 0) lines.push(`${guessed} cropped picture${guessed === 1 ? '' : 's'} show${guessed === 1 ? 's' : ''} the middle of the picture, because Miro's API does not say which part a crop keeps. For exact crops: in Miro, click the board, press Ctrl+A then Ctrl+C, and Import again. (Or right-click a picture → Crop… to move it.)`);
      if (report.layersFromMiro) lines.push('Layers, text heights and bold / italic text are as in Miro (from what you copied in Miro).');
      if (report.scale && report.scale !== 1) lines.push(`The board was scaled to ${+(report.scale * 100).toPrecision(3)} % of its Miro size so all of it fits in Ozy (everything by the same amount).`);
      return lines.join('\n');
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Miro;
  else window.Miro = Miro;
}
