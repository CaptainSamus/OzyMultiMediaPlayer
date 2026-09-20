// Style rules for text tiles. Kept pure and defensive for the same reason as lib/session.js: a
// style can come from a hand-edited .mvp, so every field falls back to a default rather than
// reaching the renderer as something CSS would silently ignore (or worse, accept).
{
  // System fonts only: the CSP has no font-src, so nothing can be downloaded.
  const FONTS = ['Segoe UI', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Impact', 'Trebuchet MS', 'Comic Sans MS', 'Consolas'];
  const DEFAULTS = {
    font: 'Segoe UI',
    size: 24,            // canvas px, zooms with the board
    color: '#e8e8ea',
    align: 'left',
    bubble: false,       // false = floating text, true = sticky box
    fill: '#ffd166',
    outline: '#00000000', // fully transparent = no border
    outlineWidth: 2,
  };
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const MAX_TEXT = 20000;

  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const color = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v : fallback);

  const TextTile = {
    FONTS,
    DEFAULTS,
    // a complete, clamped style from any input
    normalize(raw) {
      const s = raw && typeof raw === 'object' ? raw : {};
      return {
        font: FONTS.includes(s.font) ? s.font : DEFAULTS.font,
        size: clamp(s.size, 8, 400, DEFAULTS.size),
        color: color(s.color, DEFAULTS.color),
        align: ['left', 'center', 'right'].includes(s.align) ? s.align : DEFAULTS.align,
        bubble: !!s.bubble,
        fill: color(s.fill, DEFAULTS.fill),
        outline: color(s.outline, DEFAULTS.outline),
        outlineWidth: clamp(s.outlineWidth, 0, 20, DEFAULTS.outlineWidth),
      };
    },
    // the tile's text as a plain string: one newline flavour, bounded length
    sanitize(text) {
      if (typeof text !== 'string') return '';
      return text.replace(/\r\n?/g, '\n').slice(0, MAX_TEXT);
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TextTile;
  else window.TextTile = TextTile;
}
