'use strict';

/**
 * Meeting mode: record chosen apps (Zoom, Discord, …) and the mic as separate tracks,
 * leaving everything else (Spotify, games, notifications) out.
 *   Linux   → PipeWire (pipewire.js)
 *   Windows → process loopback helper (windows.js)
 */

function backend() {
  if (process.platform === 'linux') return require('./pipewire');
  if (process.platform === 'win32') return require('./windows');
  return null;
}

async function available(binDir) {
  const b = backend();
  if (!b) return { ok: false, reason: 'Meeting mode is available on Windows and Linux.' };
  return b.available(binDir);
}

async function listSources(binDir) {
  const b = backend();
  if (!b) return [];
  return b.listSources(binDir);
}

async function listMics(binDir) {
  const b = backend();
  if (!b) return [];
  return b.listMics(binDir);
}

async function startCapture(opts) {
  const b = backend();
  if (!b) throw new Error('Meeting mode is available on Windows and Linux.');
  return b.startCapture(opts);
}

module.exports = { available, listSources, listMics, startCapture };
