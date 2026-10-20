'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

/**
 * Locate ffmpeg. Prefers the bundled ffmpeg-static binary (unpacked from the
 * asar archive in packaged builds) and falls back to ffmpeg on PATH.
 */
function resolveFfmpeg() {
  try {
    let p = require('ffmpeg-static');
    if (p) {
      p = p.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {
    /* not installed */
  }
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return 0;
  return Math.round((+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) * 1000);
}

/**
 * Convert any audio/video file to 16 kHz mono 16-bit WAV (what whisper.cpp wants).
 * Resolves with { durationMs }.
 */
function toWav(input, output, { ffmpeg = resolveFfmpeg(), signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-hide_banner', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output];
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    const onAbort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Could not start ffmpeg (${ffmpeg}): ${err.message}`));
    });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Cancelled'));
      if (code !== 0) return reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.split('\n').slice(-4).join(' ')}`));
      resolve({ durationMs: parseDuration(stderr) });
    });
  });
}

function runFfmpeg(args, { ffmpeg = resolveFfmpeg(), signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', ...args], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    const onAbort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Could not start ffmpeg (${ffmpeg}): ${err.message}`));
    });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Cancelled'));
      if (code !== 0) return reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.split('\n').slice(-4).join(' ')}`));
      resolve(stderr);
    });
  });
}

/**
 * Mix several files (same speaker, or all tracks) into one 16 kHz mono WAV.
 * Tracks are summed without normalization so quiet tracks don't get pumped up.
 */
async function mixToWav(inputs, output, opts = {}) {
  if (inputs.length === 1) return toWav(inputs[0], output, opts);
  const args = ['-y'];
  for (const i of inputs) args.push('-i', i);
  args.push('-filter_complex', `amix=inputs=${inputs.length}:duration=longest:normalize=0`, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output);
  const stderr = await runFfmpeg(args, opts);
  const durations = [...stderr.matchAll(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g)].map((m) => parseDuration(m[0]));
  return { durationMs: Math.max(0, ...durations) };
}

/** Loudest sample in dBFS (-91 for digital silence). Used to skip empty tracks before whisper. */
async function maxVolumeDb(input, opts = {}) {
  const stderr = await runFfmpeg(['-i', input, '-af', 'volumedetect', '-f', 'null', '-'], opts);
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  if (!m) return 0;
  return m[1] === '-inf' ? -91 : parseFloat(m[1]);
}

/**
 * Keep a full-quality copy of the recording (48 kHz FLAC, lossless) for downloads.
 * The 16 kHz mono files used for transcription are too low-quality to hand to people.
 */
async function makeMaster(inputs, output, opts = {}) {
  const args = ['-y'];
  for (const i of inputs) args.push('-i', i);
  if (inputs.length > 1) args.push('-filter_complex', `amix=inputs=${inputs.length}:duration=longest:normalize=0`);
  else args.push('-vn');
  args.push('-ar', '48000', '-ac', '2', '-c:a', 'flac', output);
  await runFfmpeg(args, opts);
  return output;
}

module.exports = { resolveFfmpeg, runFfmpeg, toWav, mixToWav, makeMaster, maxVolumeDb, parseDuration };
