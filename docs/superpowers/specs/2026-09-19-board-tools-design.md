# Board tools: text tiles, copy/paste, hover play — design

Date: 2026-09-19. Requested by Mark ("more features similar to Miro").
Three independent tasks, planned as Tasks 31–33 in `docs/superpowers/plans/2026-09-10-ozy-v1.md`.
All three ship together as pre-release v0.2.0.9.

Constraints carried from the codebase: no bundler, `lib/*.js` IIFE modules with colocated
`node --test` tests, `app.js` is the single renderer, CSP forbids inline `<style>` and web fonts
(inline `el.style.x = ...` is fine), `.mvp` reading lives in `lib/session.js` and must never throw,
cut features are commented out in place rather than deleted.

## 1. Text tiles (Task 31)

**Purpose.** Floating text and Miro-style sticky notes on the infinite board, with font, size,
colour, alignment, and an optional filled/outlined bubble.

**Model.** A tile with `type: 'text'`, no `path`, `board: {x,y,w,h}` in canvas units like any tile,
plus:

```js
text: 'plain string, \n for newlines',
style: {
  font: 'Segoe UI',      // one of TextTile.FONTS (system fonts only: CSP has no font-src)
  size: 24,              // canvas px, clamped 8..400; zooms with the board
  color: '#e8e8ea',      // CSS hex colour (#rgb, #rrggbb, #rrggbbaa)
  align: 'left',         // left | center | right
  bubble: false,         // false = floating text, true = sticky box
  fill: '#ffd166',       // bubble background
  outline: '#00000000',  // bubble border colour; fully transparent = none
  outlineWidth: 2,       // canvas px, 0..20
}
```

`TextTile.FONTS`: Segoe UI, Arial, Georgia, Times New Roman, Courier New, Verdana, Impact,
Trebuchet MS, Comic Sans MS, Consolas. `TextTile.DEFAULTS` holds the style above.
`TextTile.normalize(raw)` returns a full, clamped style from any input (unknown font → default,
bad colour → default, size/outlineWidth clamped, bubble coerced to boolean).
`TextTile.sanitize(text)` returns a string: `\r\n` → `\n`, max 20 000 chars, non-strings → `''`.

**Where it lives.** Same `tiles` array; `tile.el` is a `div.tile.text-tile` cloned from a new
`<template id="tpl-text">`: a `div.text-body` (the rendered/editable text) inside a
`div.text-bubble`, plus the four corner `.handle`s and the `.remove` button. No overlay controls,
no ⚙. Board-only: in gallery mode text tiles get the `hidden` attribute. `tile.aspect` is `null`
and `tile.freeAspect = true`.

**Sizing.** Width is set by the user (corner handles resize width only, anchored on the opposite
edge; min 40 canvas px). Height is derived from the wrapped text after every text/style/width
change (`scrollHeight` of the body plus bubble padding and border), written back into
`tile.board.h` so lasso, snap, overlap resolution and Arrange see the true box. Every place that
computes `w = h * aspect` (`startResize`, `placeOnBoard`, the `lib/arrange.js` callers, dbl-click
handle reset) skips tiles with `freeAspect`.

**Creation.** Toolbar button "T" (title "Text (or double-click the board)") and double-click on
empty board space (`#grid`/`#canvas` background, not a tile). Both create a tile at the pointer's
world position with default style, width 240, and text `''`, then enter edit mode immediately.
The toolbar button places the tile at the centre of the current view. `recordAdd` (or the
equivalent undo hook used by `addVideo`) is called so Ctrl+Z removes it.

**Editing.** Double-click a text tile → `text-body` becomes `contenteditable="plaintext-only"`
and is focused with the caret at the end. Enter inserts a newline. Click outside, Esc, or
selecting another tile ends editing: text is read via `textContent`, sanitised, stored, and the
height recomputed. A tile whose text is empty after editing ends is removed (like Miro). While
editing: `tile.editing = true`; the global keydown guard treats `e.target.isContentEditable` like
an input; `attachTileDrag` ignores pointerdown whose target is the editing body; wheel over the
body still pans/zooms the board.

**Rendering.** `renderTextTile(tile)` writes inline style properties: `fontFamily`,
`fontSize: size + 'px'`, `color`, `textAlign` on the body; on the bubble `background`,
`border: outlineWidth px solid outline`, `borderRadius 8px`, `padding 12px`. When `bubble` is
false the bubble has transparent background, no border and no padding. Body CSS:
`white-space: pre-wrap; overflow-wrap: anywhere; outline: none`. Selection uses the existing
`.selected` rule. Text tiles never show `.overlay`.

**Floating toolbar.** A singleton `div.text-toolbar` appended to `document.body`,
`position: fixed`, shown whenever the selection contains at least one text tile, positioned
8 px above the union of the selected text tiles' screen rects (flipped below when off the top),
clamped to the viewport, repositioned on every `applyBoardView`, drag move, and resize. Built
imperatively like `openTileSettings` (no `innerHTML`). Controls, left to right:

| Control | Widget |
|---|---|
| Font | `<select>` of `TextTile.FONTS`, each option rendered in its own face |
| Size | `input[type=number]` 8–400 with − / + buttons stepping 2 |
| Text colour | swatch button opening a `.color-pop`: the 8 `Groups.PALETTE` swatches + `input[type=color]` |
| Align | three toggle buttons L / C / R |
| Bubble | toggle button "Bubble" |
| Fill | swatch (same pop), disabled when bubble is off |
| Outline | swatch (same pop) + `input[type=number]` width 0–20, disabled when bubble is off |

Changing any control applies to every selected text tile immediately and pushes one undo entry
per interaction (debounced 250 ms for number/colour inputs). The toolbar shows the values of the
first selected text tile; mixed values are not indicated. Pointerdown on the toolbar stops
propagation so it does not clear the selection or start a lasso. The toolbar stays visible while
a tile is being edited so the user can restyle while typing.

**Persistence.** `Session.VERSION` → 5 (also the `app.js` mirror). `collectSession()` adds a
branch: `{ type: 'text', text, style, board }`. `Session.videoKind(v)` returns `'text'` when
`v.type === 'text' && typeof v.text === 'string'`. `applySession` dispatches `'text'` →
`addTextTile(v)`, which runs `TextTile.normalize`/`sanitize` and requires a usable `board`
(finite x, y, w > 0); otherwise the record is dropped, since text has no gallery form.
`recordRemove`/`restoreRemoved` work unchanged because they round-trip the same record. New
fixture `test-fixtures/sessions/v5-text.mvp` with three text tiles (one bubble, one plain, one
with an unknown font and oversize size) exercised by `lib/session.test.js`. Older builds skip the
record (no `path`), so old Ozy opens new files minus the text.

**Path guards.** `tileName`, `recordGResize`, `recordRemove`, `onBoardPaths`, and any sidebar
"reveal"/"open folder" actions treat `t.path == null` as "not a file": `tileName` returns the
first 24 chars of the text, or "Text" when empty. Context menu for a text tile offers Edit,
Bring to front, Remove only.

**Out of scope.** Rotation, rich text (bold/italic spans, links), gallery-mode text, web fonts,
text on the timeline, per-tile ⚙.

**Tests.** `lib/texttile.js` + `lib/texttile.test.js`: defaults, normalize (each field good and
bad), sanitize. `lib/session.test.js`: kind `'text'`, the v5 fixture loads with every record
classified, a text record without `text` is `null`.

## 2. Copy and paste (Task 32)

**Purpose.** Ctrl+C on any selection (lasso or click) and Ctrl+V to duplicate those tiles, for
every tile type: video, audio (already a `file` tile), image, sequence, YouTube/Twitch, text.

**Clipboard.** In-app only: `let clipboard = null` holding
`{ records: [...], origin: {x, y}, lastPaste: {x, y} | null }`. `records` are the
`collectSession().videos` entries for the selected tiles, the same shape `recordRemove` stores, so
`applySession`'s per-type dispatch recreates them. `origin` is the top-left of the selection's
board bbox (null when no selected tile has a board). Copy also writes a plain-text summary to the
OS clipboard via `navigator.clipboard.writeText` (text tiles: their text; media: their path or
URL, one per line) so paths can be pasted elsewhere; best-effort, never blocks copy.

**Paste target.** Board mode: if the pointer is over the board, the pasted bbox's top-left goes to
the pointer's world position; otherwise to `(lastPaste ?? origin) + (24, 24)` canvas px, so
repeated pastes stagger. Relative layout inside the copied set is preserved. Gallery mode: media
tiles are appended to the gallery (board position kept from the record so they also appear on the
board later, offset as above) and text records are skipped with a status message "Text tiles
paste on the board only". Pasted tiles become the selection and are brought to front.

**Groups.** Not copied. Pasted tiles start ungrouped, `sync` off, own volume/mute/loop/bookmarks
from the record.

**Undo.** One undo entry for the whole paste (all pasted tiles removed together). Copy is not
recorded.

**Keys.** Ctrl+C / Ctrl+V in the global keydown handler, ignored when `inControl` or
`e.target.isContentEditable` (native copy/paste in inputs and text editing keep working). Also
offered in the board context menu as Copy / Paste (Paste disabled when the clipboard is empty).
Ctrl+D is not added.

**Tests.** `lib/clipboard.js` + `lib/clipboard.test.js`: `bbox(records)`,
`placeRecords(records, origin, target)` returns deep-copied records with boards shifted so the
bbox top-left lands on `target`, preserving relative positions; records without a board pass
through unchanged. Pure, no DOM.

## 3. Hover play mode (Task 33)

**Purpose.** A viewing mode where every video is paused until the mouse hovers it, plays while
hovered, pauses on leave, and resumes from the same spot on re-entry.

**Toggle.** Toolbar button "Hover play" beside the transport controls, `.toggled` when on.
Stored in app settings (`settings.hoverPlay`, default false) through the existing settings store,
not in the session. Turning on: pause all. Turning off: nothing else changes.

**State machine** (`lib/hoverplay.js`, pure, tested): `HoverPlay.create({ delay: 150 })` with
`enter(id, now)`, `leave(id, now)`, `tick(now)` each returning a list of actions
`[{ op: 'play' | 'pause', id }]`. Enter arms a timer; if leave arrives before `delay`, nothing
plays. Only one tile is armed or playing at a time; entering a second tile pauses the first (if
playing) and arms the second. `leave` of the active tile → `pause`. `reset()` pauses the active
tile and clears state (used when the mode is turned off or compare/fullscreen opens).

**Wiring in `app.js`.** The existing `pointerenter`/`pointerleave` handlers that set
`hoveredTile` also call `HoverPlay.enter/leave` when `settings.hoverPlay` is on and the tile has
`t.pb` (video, audio, sequence, YouTube/Twitch). A single `setTimeout` drives `tick`. Actions map
to `t.pb.play()` / `t.pb.pause()`; if the tile is in a sync group with Sync on, play/pause goes
through the existing group play/pause so members stay together. Still images and text tiles are
ignored.

**Conflicts.** While on: Space and the toolbar Play all / Pause all are ignored with the status
line "Hover play is on"; the per-tile play button still works, and the tile pauses again on leave.
The A/B compare view and fullscreen call `reset()` when they open and hover handling resumes when
they close.

**Persistence and defaults.** Setting only. Reload restores the toggle; videos load paused when it
is on (they already load paused).

**Tests.** `lib/hoverplay.test.js`: enter → tick after delay plays; enter → leave before delay
plays nothing; enter A, tick, enter B pauses A then plays B after delay; leave active pauses;
leave non-active is a no-op; reset pauses the active tile; a fresh instance returns `[]` for
tick.

## Release

After Tasks 31–33 are merged and manually checked: bump `buildVersion` to 0.2.0.9, tag
`v0.2.0.9`, publish as pre-release (Mark promotes by hand), same as v0.2.0.8.
