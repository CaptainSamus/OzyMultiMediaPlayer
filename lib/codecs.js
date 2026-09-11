// Codec knowledge shared by main (ffprobe parsing) and renderer (canPlayType).
const VIDEO_MIME = {
  h264: 'video/mp4; codecs="avc1.42E01E"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  vp8: 'video/webm; codecs="vp8"',
  vp9: 'video/webm; codecs="vp09.00.10.08"',
  av1: 'video/mp4; codecs="av01.0.05M.08"',
};
const AUDIO_MIME = { mp3: 'audio/mpeg', aac: 'audio/mp4', flac: 'audio/flac', vorbis: 'audio/ogg', opus: 'audio/ogg', pcm_s16le: 'audio/wav' };

const Codecs = {
  mimeFor(codec, _ext) {
    return VIDEO_MIME[codec] || AUDIO_MIME[codec] || null;
  },
  parseFps(s) {
    if (typeof s !== 'string') return null;
    const [n, d] = s.split('/').map(Number);
    if (!(n > 0) || !(d > 0)) return null;
    return n / d;
  },
  parseProbe(json, ext) {
    const streams = (json && json.streams) || [];
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    const duration = Number(json && json.format && json.format.duration) || null;
    if (v) {
      return {
        codec: v.codec_name || null, width: v.width || null, height: v.height || null,
        fps: Codecs.parseFps(v.avg_frame_rate) || Codecs.parseFps(v.r_frame_rate),
        duration, mime: Codecs.mimeFor(v.codec_name, ext),
      };
    }
    return { codec: a ? a.codec_name : null, width: null, height: null, fps: null, duration, mime: a ? Codecs.mimeFor(a.codec_name, ext) : null };
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Codecs;
else window.Codecs = Codecs;
