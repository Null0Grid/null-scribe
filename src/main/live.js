'use strict';

/**
 * Live transcript while recording.
 *
 * The recorders write plain WAV files that grow as audio arrives. Every few seconds we read
 * the new audio from each track, skip it if it's silent, convert that slice to 16 kHz mono,
 * and run whisper.cpp on just that slice. Segments are shifted to their real position in the
 * recording and labeled with the track's speaker ("You", "Discord", …).
 *
 * This is a preview: chunk edges can split a word, so when recording stops the normal full
 * pipeline still transcribes everything in one pass for the saved transcript.
 */

const fs = require('fs');
const path = require('path');
const { toWav } = require('../pipeline/audio');
const { transcribe } = require('../pipeline/transcribe');
const { isEcho } = require('../pipeline/speakers');
const { cleanSegments } = require('../pipeline/cleanup');

/** Find the format and where the audio data starts in a (possibly still-growing) WAV file. */
function readWavLayout(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (n < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    let pos = 12;
    let fmt = null;
    while (pos + 8 <= n) {
      const id = head.toString('ascii', pos, pos + 4);
      const size = head.readUInt32LE(pos + 4);
      if (id === 'fmt ') {
        fmt = {
          format: head.readUInt16LE(pos + 8),
          channels: head.readUInt16LE(pos + 10),
          rate: head.readUInt32LE(pos + 12),
          blockAlign: head.readUInt16LE(pos + 20),
          bits: head.readUInt16LE(pos + 22),
        };
      } else if (id === 'data') {
        // The size field is often 0 until the recorder closes the file, so it's ignored.
        return fmt ? { ...fmt, dataOffset: pos + 8 } : null;
      }
      pos += 8 + size + (size % 2);
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Peak of 16-bit PCM samples, 0..1. */
function peakOf(buf) {
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 8) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak / 32768;
}

function wavHeader({ channels, rate, bits }, dataBytes) {
  const h = Buffer.alloc(44);
  const align = channels * (bits / 8);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * align, 28);
  h.writeUInt16LE(align, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

class LiveTranscriber {
  /**
   * getTracks(): current [{ path, speaker }] (apps can join mid-recording).
   * onSegments(newSegments) receives labeled segments; onNotice(text) for status messages.
   */
  constructor({ getTracks, whisperBin, model, language = 'auto', workDir, onSegments, onNotice, intervalMs = 4000, minChunkSec = 6, maxChunkSec = 25, deps = {} }) {
    Object.assign(this, { getTracks, whisperBin, model, language, workDir, onSegments, onNotice, intervalMs, minChunkSec, maxChunkSec });
    this.toWav = deps.toWav || toWav;
    this.transcribe = deps.transcribe || transcribe;
    this.pos = new Map(); // track path → frames already handled
    this.others = []; // app-track segments, for echo filtering of the mic track
    this.busy = false;
    this.stopped = false;
    this.timer = null;
    this.controller = new AbortController();
    fs.mkdirSync(workDir, { recursive: true });
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((err) => this.onNotice?.(`Live transcript paused: ${err.message}`)), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller.abort();
  }

  async tick({ final = false } = {}) {
    if (this.busy || (this.stopped && !final)) return;
    this.busy = true;
    try {
      for (const track of this.getTracks()) {
        if (this.stopped && !final) break;
        await this.processTrack(track, final);
      }
    } finally {
      this.busy = false;
    }
  }

  async processTrack(track, final) {
    if (!fs.existsSync(track.path)) return;
    const layout = readWavLayout(track.path);
    if (!layout || layout.format !== 1 || layout.bits !== 16) return; // our recorders write 16-bit PCM
    const total = Math.floor((fs.statSync(track.path).size - layout.dataOffset) / layout.blockAlign);
    const done = this.pos.get(track.path) || 0;
    const available = total - done;
    const minFrames = (final ? 1 : this.minChunkSec) * layout.rate;
    if (available < minFrames) return;

    const frames = Math.min(available, this.maxChunkSec * layout.rate);
    const bytes = frames * layout.blockAlign;
    const pcm = Buffer.alloc(bytes);
    const fd = fs.openSync(track.path, 'r');
    try {
      fs.readSync(fd, pcm, 0, bytes, layout.dataOffset + done * layout.blockAlign);
    } finally {
      fs.closeSync(fd);
    }
    this.pos.set(track.path, done + frames);
    if (peakOf(pcm) < 0.01) return; // silence: nothing to transcribe (and whisper invents words on silence)

    const id = `${path.basename(track.path, '.wav')}-${done}`;
    const raw = path.join(this.workDir, `${id}.raw.wav`);
    const wav16 = path.join(this.workDir, `${id}.wav`);
    fs.writeFileSync(raw, Buffer.concat([wavHeader(layout, bytes), pcm]));
    try {
      await this.toWav(raw, wav16, { signal: final ? undefined : this.controller.signal });
      const segs = await this.transcribe({
        bin: this.whisperBin,
        model: this.model,
        wav: wav16,
        language: this.language,
        workDir: this.workDir,
        signal: final ? undefined : this.controller.signal,
      });
      const offsetMs = Math.round((done / layout.rate) * 1000);
      const shifted = cleanSegments(segs).map((s) => ({ start: s.start + offsetMs, end: s.end + offsetMs, text: s.text, speaker: track.speaker }));
      let out = shifted;
      if (track.speaker === 'You') out = shifted.filter((s) => !isEcho(s, this.others));
      else this.others.push(...shifted);
      if (out.length) this.onSegments?.(out);
    } catch (err) {
      if (!this.stopped) throw err;
    } finally {
      fs.rmSync(raw, { force: true });
      fs.rmSync(wav16, { force: true });
    }
  }
}

module.exports = { LiveTranscriber, readWavLayout, peakOf };
