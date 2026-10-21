'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Find the whisper.cpp CLI inside binDir (whisper-cli is the current name, main the legacy one). */
function findWhisper(binDir) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['whisper-cli', 'main']) {
    const p = path.join(binDir, name + exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Turn whisper.cpp's -oj JSON into [{ start, end, text }] with times in ms.
 * Drops blank segments and the [BLANK_AUDIO]-style markers whisper emits for silence.
 */
function parseWhisperJson(json) {
  const items = Array.isArray(json?.transcription) ? json.transcription : [];
  return items
    .map((it) => ({
      start: Number(it.offsets?.from ?? 0),
      end: Number(it.offsets?.to ?? 0),
      text: String(it.text ?? '').trim(),
    }))
    .filter((s) => s.text && !/^\[[A-Z_ ]+\]$/.test(s.text) && !/^\([^)]*\)$/.test(s.text));
}

/**
 * Run whisper.cpp on a 16 kHz WAV file. Resolves with segments.
 * onProgress(fraction) is fed from whisper's -pp progress output.
 */
function transcribe({ bin, model, wav, language = 'auto', threads, workDir, prompt = '', onProgress, signal }) {
  return new Promise((resolve, reject) => {
    if (!bin || !fs.existsSync(bin)) {
      return reject(new Error('whisper.cpp binary not found. Run "npm run build:engines" (see README).'));
    }
    const outBase = path.join(workDir || path.dirname(wav), 'whisper-out');
    const nThreads = String(threads || Math.max(1, Math.min(8, os.cpus().length - 1)));
    const args = ['-m', model, '-f', wav, '-l', language, '-t', nThreads, '-oj', '-of', outBase, '-pp', '-np'];
    if (prompt) args.push('--prompt', prompt); // custom words: bias recognition toward these spellings

    const proc = spawn(bin, args, { windowsHide: true });
    let log = '';
    const handle = (d) => {
      const text = d.toString();
      log = (log + text).slice(-20000);
      const re = /progress\s*=\s*(\d+)%/g;
      let m;
      let last = null;
      while ((m = re.exec(text))) last = m[1];
      if (last !== null) onProgress?.(Number(last) / 100);
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);

    const onAbort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Could not start whisper.cpp: ${err.message}`));
    });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Cancelled'));
      if (code !== 0) {
        return reject(new Error(`whisper.cpp failed (exit ${code}): ${log.trim().split('\n').slice(-3).join(' ')}`));
      }
      try {
        const json = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
        onProgress?.(1);
        resolve(parseWhisperJson(json));
      } catch (err) {
        reject(new Error(`Could not read whisper output: ${err.message}`));
      }
    });
  });
}

module.exports = { findWhisper, parseWhisperJson, transcribe };
