// Minimal OpenEXR header reader: just enough to list the parts, channels and layers of a frame so
// the ⚙ popover can offer a Layer picker. Pure (takes a Uint8Array, no Node APIs) and never throws:
// a truncated or foreign file gives null.
//
// Layout: magic (20000630, LE) + version, then one attribute list per part. An attribute is
// name\0 type\0 int32 size + size bytes; an empty name ends the list. Multi-part files (version
// bit 0x800) put one list after another and finish with one extra empty name. Channels live in the
// 'chlist' attribute: name\0 + int32 pixelType + uint8 pLinear + 3 reserved + int32 xSampling +
// int32 ySampling each, ended by an empty name.
{
  const MAGIC = 20000630;
  const MULTIPART = 0x800;

  const reader = (b) => {
    let p = 0;
    const need = (n) => { if (n < 0 || p + n > b.length) throw new Error('truncated'); };
    return {
      get pos() { return p; },
      eof() { return p >= b.length; },
      peek() { need(1); return b[p]; },
      u32() { need(4); const v = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; p += 4; return v; },
      i32() { need(4); const v = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24); p += 4; return v; },
      str() { let s = ''; for (;;) { need(1); const c = b[p++]; if (!c) return s; s += String.fromCharCode(c); } },
      fixed(n) { need(n); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + i]); p += n; return s; },
      skip(n) { need(n); p += n; },
    };
  };

  // channel names -> the layers they belong to: everything before the last '.', '' for base channels
  const layersOf = (channels) => {
    const seen = new Set();
    for (const c of channels) { const i = c.lastIndexOf('.'); seen.add(i < 0 ? '' : c.slice(0, i)); }
    return [...seen].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })));
  };

  const readChlist = (r, size) => {
    const end = r.pos + size;
    const names = [];
    while (r.pos < end) {
      const name = r.str();
      if (name === '') break;
      r.skip(16); // pixelType, pLinear + reserved, xSampling, ySampling
      names.push(name);
    }
    if (r.pos < end) r.skip(end - r.pos); // keep the cursor on the next attribute
    return names;
  };

  const ExrHeader = {
    MAGIC,
    // -> { parts: [{ name, channels, layers }] }, or null if this isn't a readable EXR header
    parse(bytes) {
      try {
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const r = reader(b);
        if (r.u32() !== MAGIC) return null;
        const multiPart = !!(r.u32() & MULTIPART);
        const parts = [];
        for (;;) {
          let channels = null, name = '';
          for (;;) {
            const attrName = r.str();
            if (attrName === '') break; // end of this part's attributes
            const type = r.str();
            const size = r.i32();
            if (size < 0) return null;
            if (type === 'chlist') channels = readChlist(r, size);
            else if (attrName === 'name' && type === 'string') name = r.fixed(size);
            else r.skip(size);
          }
          if (!channels) return parts.length ? { parts } : null; // a header with no channel list
          parts.push({ name, channels, layers: layersOf(channels) });
          if (!multiPart || r.eof() || r.peek() === 0) break; // one extra empty name ends the list
        }
        return { parts };
      } catch { return null; } // truncated or malformed: say so instead of throwing
    },
    layers(parsed) { return parsed && parsed.parts ? parsed.parts.map((p) => p.layers) : []; },
    layerLabel(layer) { return layer === '' || layer == null ? 'RGBA (base)' : layer; },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ExrHeader;
  else window.ExrHeader = ExrHeader;
}
