const test = require('node:test');
const assert = require('node:assert/strict');
const ClickGuard = require('./clickguard');

test('a clean click acts', () => {
  const g = ClickGuard.create();
  assert.equal(g.shouldAct(), true);
});
test('the guard is consumed by one click', () => {
  const g = ClickGuard.create();
  g.afterDrag();
  assert.equal(g.shouldAct(), false); // the click that ends a drag
  assert.equal(g.shouldAct(), true);  // the next real click
});
test('a new press clears a stale guard', () => {
  const g = ClickGuard.create();
  g.afterDrag();
  g.pointerDown();                     // the click after the drag never came (release over an embed)
  assert.equal(g.shouldAct(), true);
});
test('ezTarget: controls never count as the picture', () => {
  const hit = (sel) => ['button', '.seek', '.vol-zone'].includes(sel);
  assert.equal(ClickGuard.ezTarget(hit), false);
  assert.equal(ClickGuard.ezTarget(() => false), true);
});
// A board tile owns the pointer from pointerdown (so a release over an embed still ends the drag),
// which makes Chromium deliver the click to the tile element, not to the <video> under the cursor.
test('clickPlays: a click the tile captured plays when it landed on the picture', () => {
  assert.equal(ClickGuard.clickPlays({ shift: false, retargeted: true, onPicture: true, ez: false, onControl: false }), true);
});
test('clickPlays: a click the picture received itself is left to the picture', () => {
  assert.equal(ClickGuard.clickPlays({ shift: false, retargeted: false, onPicture: true, ez: true, onControl: false }), false);
});
test('clickPlays: off the picture only EZ play acts, and never on a control', () => {
  assert.equal(ClickGuard.clickPlays({ shift: false, retargeted: true, onPicture: false, ez: false, onControl: false }), false);
  assert.equal(ClickGuard.clickPlays({ shift: false, retargeted: true, onPicture: false, ez: true, onControl: false }), true);
  assert.equal(ClickGuard.clickPlays({ shift: false, retargeted: false, onPicture: false, ez: true, onControl: false }), true);
  assert.equal(ClickGuard.clickPlays({ shift: false, retargeted: true, onPicture: false, ez: true, onControl: true }), false);
});
test('clickPlays: shift-click never plays', () => {
  assert.equal(ClickGuard.clickPlays({ shift: true, retargeted: true, onPicture: true, ez: true, onControl: false }), false);
  assert.equal(ClickGuard.clickPlays({ shift: true, retargeted: false, onPicture: false, ez: true, onControl: false }), false);
});
// --- board clicks that died with pointer capture (plan C, task 5) ---
test('clickTarget: picture, marker, time readout or nothing', () => {
  const at = (sel) => (s) => s === sel;           // "the element under the pointer matches s"
  assert.equal(ClickGuard.clickTarget({ closest: () => false, onPicture: true, ez: false }), 'picture');
  assert.equal(ClickGuard.clickTarget({ closest: at('.marker'), onPicture: false, ez: false }), 'marker');
  assert.equal(ClickGuard.clickTarget({ closest: at('.time'), onPicture: false, ez: false }), 'time');
  assert.equal(ClickGuard.clickTarget({ closest: at('button'), onPicture: false, ez: false }), null);
  assert.equal(ClickGuard.clickTarget({ closest: () => false, onPicture: false, ez: false }), null);       // tile chrome, EZ off
  assert.equal(ClickGuard.clickTarget({ closest: () => false, onPicture: false, ez: true }), 'picture');   // EZ play: chrome counts as the picture
});
test('clickTarget: the marker and the time readout win over EZ play and over their container', () => {
  const both = (...sels) => (s) => sels.includes(s);
  assert.equal(ClickGuard.clickTarget({ closest: both('.marker', '.markers'), onPicture: false, ez: true }), 'marker'); // .markers is a control, the marker inside it is not "nothing"
  assert.equal(ClickGuard.clickTarget({ closest: both('.time'), onPicture: false, ez: true }), 'time');                 // EZ play must not turn the readout into a play button
  assert.equal(ClickGuard.clickTarget({ closest: both('.markers'), onPicture: false, ez: true }), null);                // the bare marker strip stays a control
});
test('dblClickFullscreens: only a double-click the tile captured, on the picture, outside compare', () => {
  assert.equal(ClickGuard.dblClickFullscreens({ retargeted: true, onPicture: true, compareOpen: false }), true);
  assert.equal(ClickGuard.dblClickFullscreens({ retargeted: false, onPicture: true, compareOpen: false }), false); // the picture got it itself (gallery): its own handler acts
  assert.equal(ClickGuard.dblClickFullscreens({ retargeted: true, onPicture: false, compareOpen: false }), false); // chrome, buttons, seek bar
  assert.equal(ClickGuard.dblClickFullscreens({ retargeted: true, onPicture: true, compareOpen: true }), false);
});
