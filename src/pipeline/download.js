'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

/**
 * Download url → dest atomically (via dest.part), reporting progress as a 0–1 fraction.
 * Skips the download when dest already exists and is at least minBytes.
 */
async function downloadFile(url, dest, { onProgress, signal, expectedBytes = 0, minBytes = 1_000_000 } = {}) {
  if (fs.existsSync(dest) && fs.statSync(dest).size >= minBytes) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let res;
  try {
    res = await fetch(url, { signal, redirect: 'follow' });
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled');
    throw new Error(`Download failed (${new URL(url).host}): ${err.message}`);
  }
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${path.basename(dest)}`);

  const total = Number(res.headers.get('content-length')) || expectedBytes || 1;
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let received = 0;
  try {
    await new Promise((resolve, reject) => {
      const stream = Readable.fromWeb(res.body);
      stream.on('data', (chunk) => {
        received += chunk.length;
        onProgress?.(Math.min(1, received / total));
      });
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      stream.pipe(out);
    });
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw signal?.aborted ? new Error('Cancelled') : err;
  }
  fs.renameSync(tmp, dest);
  return dest;
}

module.exports = { downloadFile };
