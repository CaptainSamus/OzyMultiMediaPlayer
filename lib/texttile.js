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
    // (2026-11-06, for sticky notes, shapes and Miro frames) 'auto': the box is as tall as the
    // wrapped text; 'fixed': the box keeps the size it is given and the text sits in it
    box: 'auto',
    valign: 'top',       // where the text sits in a fixed box
    fit: false,          // fixed box: shrink the text until it fits (a sticky note)
    shape: 'box',        // 'box', 'ellipse', or one of SHAPES (2026-11-15)
    radius: 8,           // corner rounding of a bubble, canvas px
    padding: 12,         // inside a bubble, canvas px
    shadow: false,       // a soft drop shadow (sticky notes)
    // (2026-11-10, Miro imports) the whole text in bold / italic / underlined / struck through
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    lineHeight: 1.25,    // of the text size (Miro's text: 1.4)
  };
  // (2026-11-15) shapes beyond a box and an ellipse: an outline drawn behind the text, as points
  // on a 100 x 100 square that is stretched to the tile's box
  const SHAPES = {
    triangle: '50,0 100,100 0,100',
    diamond: '50,0 100,50 50,100 0,50',
    hexagon: '25,0 75,0 100,50 75,100 25,100 0,50',
    star: '50,0 61.8,35.4 100,38.2 69.1,61.8 80.9,100 50,76.4 19.1,100 30.9,61.8 0,38.2 38.2,35.4',
    arrow: '0,25 62,25 62,0 100,50 62,100 62,75 0,75',
    parallelogram: '22,0 100,0 78,100 0,100',
  };
  // the sticky note colours Miro offers (its names, as close as the eye says)
  const NOTE_COLORS = ['#fff9b1', '#f5d128', '#ff9d48', '#d5f692', '#c9df56', '#93d275', '#67c6c0', '#a6ccf5', '#6cd8fa', '#9ea9ff', '#ffcee0', '#ea94bb', '#be88c7', '#f16c7f', '#f5f6f8', '#000000'];
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
    SHAPES,
    NOTE_COLORS,
    // a complete, clamped style from any input
    normalize(raw) {
      const s = raw && typeof raw === 'object' ? raw : {};
      return {
        font: FONTS.includes(s.font) ? s.font : DEFAULTS.font,
        size: clamp(s.size, 0.5, 4000, DEFAULTS.size), // (8-400 until 2026-11-06: a scaled Miro board has tiny and huge text)
        color: color(s.color, DEFAULTS.color),
        align: ['left', 'center', 'right'].includes(s.align) ? s.align : DEFAULTS.align,
        bubble: !!s.bubble,
        fill: color(s.fill, DEFAULTS.fill),
        outline: color(s.outline, DEFAULTS.outline),
        outlineWidth: clamp(s.outlineWidth, 0, 200, DEFAULTS.outlineWidth),
        box: s.box === 'fixed' ? 'fixed' : 'auto',
        valign: ['top', 'middle', 'bottom'].includes(s.valign) ? s.valign : DEFAULTS.valign,
        fit: s.fit === true,
        shape: s.shape === 'ellipse' || SHAPES[s.shape] ? s.shape : 'box',
        radius: clamp(s.radius, 0, 4000, DEFAULTS.radius),
        padding: clamp(s.padding, 0, 2000, DEFAULTS.padding),
        shadow: s.shadow === true,
        bold: s.bold === true,
        italic: s.italic === true,
        underline: s.underline === true,
        strike: s.strike === true,
        lineHeight: clamp(s.lineHeight, 0.8, 3, DEFAULTS.lineHeight),
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
