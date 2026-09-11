const test = require('node:test');
const assert = require('node:assert/strict');
const Codecs = require('./codecs');

test('mimeFor maps chromium-playable codecs to a canPlayType string', () => {
  assert.equal(Codecs.mimeFor('h264', '.mp4'), 'video/mp4; codecs="avc1.42E01E"');
  assert.equal(Codecs.mimeFor('hevc', '.mov'), 'video/mp4; codecs="hvc1.1.6.L93.B0"');
  assert.equal(Codecs.mimeFor('vp9', '.webm'), 'video/webm; codecs="vp09.00.10.08"');
  assert.equal(Codecs.mimeFor('av1', '.mp4'), 'video/mp4; codecs="av01.0.05M.08"');
  assert.equal(Codecs.mimeFor('prores', '.mov'), null);
  assert.equal(Codecs.mimeFor('dnxhd', '.mov'), null);
});

test('parseFps handles ffprobe rational strings', () => {
  assert.equal(Codecs.parseFps('24000/1001').toFixed(3), '23.976');
  assert.equal(Codecs.parseFps('30/1'), 30);
  assert.equal(Codecs.parseFps('0/0'), null);
  assert.equal(Codecs.parseFps(undefined), null);
});

test('parseProbe pulls the first video stream and format duration', () => {
  const json = {
    streams: [{ codec_type: 'audio', codec_name: 'aac' },
              { codec_type: 'video', codec_name: 'prores', width: 1920, height: 1080, avg_frame_rate: '24/1', r_frame_rate: '24/1' }],
    format: { duration: '12.5' },
  };
  assert.deepEqual(Codecs.parseProbe(json, '.mov'),
    { codec: 'prores', width: 1920, height: 1080, fps: 24, duration: 12.5, mime: null });
});

test('parseProbe on audio-only file reports null video fields and an audio mime', () => {
  const json = { streams: [{ codec_type: 'audio', codec_name: 'mp3' }], format: { duration: '3' } };
  assert.deepEqual(Codecs.parseProbe(json, '.mp3'),
    { codec: 'mp3', width: null, height: null, fps: null, duration: 3, mime: 'audio/mpeg' });
});
