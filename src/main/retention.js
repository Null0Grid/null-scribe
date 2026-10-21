'use strict';

/**
 * Auto-delete old audio. Recordings older than the chosen number of days lose their audio files
 * (audio.wav, master.flac, per-speaker tracks); the transcript, summary and notes stay.
 */

const fs = require('fs');
const path = require('path');

const RETENTION_CHOICES = [0, 1, 7, 15, 30, 90, 180]; // 0 = never
const AUDIO_FILE = /\.(wav|flac|mp3|m4a|ogg|opus|webm)$/i;
const DAY = 24 * 60 * 60 * 1000;

function normalizeDays(v) {
  const n = Number(v);
  return RETENTION_CHOICES.includes(n) ? n : 0;
}

/** Audio files in a session folder (top level only). */
function audioFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && AUDIO_FILE.test(d.name))
      .map((d) => path.join(dir, d.name));
  } catch (_) {
    return [];
  }
}

/**
 * Delete audio from sessions older than `days`. Skips sessions still processing and the one in `busyId`.
 * Returns [{ id, files, bytes }] for what was removed.
 */
function pruneAudio(sessions, days, { now = Date.now(), busyId = null } = {}) {
  const d = normalizeDays(days);
  if (!d) return [];
  const cutoff = now - d * DAY;
  const removed = [];
  for (const meta of sessions.list()) {
    if (meta.id === busyId || meta.status === 'processing') continue;
    const created = Date.parse(meta.createdAt);
    if (!Number.isFinite(created) || created > cutoff) continue;
    const files = audioFiles(sessions.dirOf(meta.id));
    if (!files.length) continue;
    let bytes = 0;
    for (const f of files) {
      try {
        bytes += fs.statSync(f).size;
        fs.rmSync(f, { force: true });
      } catch (_) {
        /* in use or already gone; try again next time */
      }
    }
    sessions.update(meta.id, { audioDeletedAt: new Date(now).toISOString() });
    removed.push({ id: meta.id, files: files.length, bytes });
  }
  return removed;
}

module.exports = { pruneAudio, normalizeDays, audioFiles, RETENTION_CHOICES };
