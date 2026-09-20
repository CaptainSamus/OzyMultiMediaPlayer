const test = require('node:test');
const assert = require('node:assert/strict');
const HoverPlay = require('./hoverplay');

const hp = () => HoverPlay.create({ delay: 150 });

test('a fresh state machine has nothing to do', () => {
  const h = hp();
  assert.deepEqual(h.tick(0), []);
  assert.deepEqual(h.tick(10000), []);
  assert.equal(h.nextDue(), null);
});

test('entering arms a timer; the tile plays once the delay is up', () => {
  const h = hp();
  assert.deepEqual(h.enter('a', 0), []);
  assert.equal(h.nextDue(), 150);
  assert.deepEqual(h.tick(100), []);      // still inside the delay
  assert.deepEqual(h.tick(150), [{ op: 'play', id: 'a' }]);
  assert.equal(h.nextDue(), null);        // nothing armed any more
  assert.deepEqual(h.tick(400), []);      // and it does not play twice
});

test('leaving before the delay is up plays nothing', () => {
  const h = hp();
  h.enter('a', 0);
  assert.deepEqual(h.leave('a', 100), []);
  assert.equal(h.nextDue(), null);
  assert.deepEqual(h.tick(200), []);
});

test('entering a second tile pauses the first and arms the second', () => {
  const h = hp();
  h.enter('a', 0);
  h.tick(150);
  assert.deepEqual(h.enter('b', 200), [{ op: 'pause', id: 'a' }]);
  assert.deepEqual(h.tick(300), []);
  assert.deepEqual(h.tick(350), [{ op: 'play', id: 'b' }]);
});

test('entering a second tile while the first is only armed plays neither yet', () => {
  const h = hp();
  h.enter('a', 0);
  assert.deepEqual(h.enter('b', 50), []); // 'a' never played, so there is nothing to pause
  assert.deepEqual(h.tick(150), []);      // 'a' is no longer armed
  assert.deepEqual(h.tick(200), [{ op: 'play', id: 'b' }]);
});

test('leaving the playing tile pauses it', () => {
  const h = hp();
  h.enter('a', 0);
  h.tick(150);
  assert.deepEqual(h.leave('a', 300), [{ op: 'pause', id: 'a' }]);
  assert.deepEqual(h.tick(500), []);
});

test('leaving a tile that is neither armed nor playing does nothing', () => {
  const h = hp();
  assert.deepEqual(h.leave('zzz', 0), []);
  h.enter('a', 0);
  h.tick(150);
  assert.deepEqual(h.leave('zzz', 200), []);
  assert.deepEqual(h.leave('a', 300), [{ op: 'pause', id: 'a' }]); // 'a' was untouched by that
});

test('re-entering the tile that is already playing changes nothing', () => {
  const h = hp();
  h.enter('a', 0);
  h.tick(150);
  assert.deepEqual(h.enter('a', 200), []);
  assert.equal(h.nextDue(), null);
  assert.deepEqual(h.tick(400), []);
});

test('reset pauses whatever is playing and forgets everything', () => {
  const h = hp();
  h.enter('a', 0);
  h.tick(150);
  assert.deepEqual(h.reset(), [{ op: 'pause', id: 'a' }]);
  assert.deepEqual(h.tick(1000), []);
  assert.equal(h.nextDue(), null);
  // a reset with only an armed tile has nothing to pause
  h.enter('b', 2000);
  assert.deepEqual(h.reset(), []);
  assert.deepEqual(h.tick(3000), []);
});

test('the delay is configurable and defaults sensibly', () => {
  const slow = HoverPlay.create({ delay: 400 });
  slow.enter('a', 1000);
  assert.equal(slow.nextDue(), 1400);
  assert.deepEqual(slow.tick(1399), []);
  assert.deepEqual(slow.tick(1400), [{ op: 'play', id: 'a' }]);
  const dflt = HoverPlay.create();
  dflt.enter('a', 0);
  assert.equal(typeof dflt.nextDue(), 'number');
});
