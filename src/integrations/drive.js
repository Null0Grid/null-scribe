'use strict';

/**
 * Null Drive integration (the same address + token setup as the Null Grid browser).
 *
 *   GET /api/v1/me                    → who the token belongs to, and the account's e2ee state
 *   PUT /api/v1/files/{path}          → upload; `If-Match: 0` = create only, never overwrite;
 *                                       `X-Content-SHA256` lets the server verify / dedupe retries
 *
 * End-to-end encrypted accounts refuse plaintext uploads by design, so Scribe checks first and
 * points the user to Null Notes (which syncs to encrypted Drive accounts itself).
 */

const crypto = require('crypto');
const path = require('path');

class DriveError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function normalizeAddress(address) {
  let a = String(address || '').trim();
  if (!a) throw new DriveError('Enter your Null Drive address in Settings.', 'no_address');
  if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
  let u;
  try {
    u = new URL(a);
  } catch (_) {
    throw new DriveError(`That doesn't look like an address: ${address}`, 'bad_address');
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '')}`;
}

/** Encode each path segment, keeping the slashes. */
function encodePath(p) {
  return p
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function cleanSegment(s) {
  return (
    String(s)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 100) || 'Untitled'
  );
}

async function call(base, token, method, apiPath, { body, headers = {}, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base}/api/v1${apiPath}`, {
      method,
      body,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      signal: ctrl.signal,
    });
  } catch (err) {
    const cause = err.cause?.code || err.cause?.message || err.message;
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(cause)) {
      throw new DriveError("Null Drive's HTTPS certificate isn't trusted by this computer (self-signed?). Use the http:// LAN address, or a certificate from a trusted CA.", 'tls');
    }
    if (err.name === 'AbortError') throw new DriveError(`Null Drive at ${base} didn't answer in time.`, 'timeout');
    throw new DriveError(`Can't reach Null Drive at ${base} (${cause}). Is the server running and the address right?`, 'unreachable');
  } finally {
    clearTimeout(t);
  }
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  return { status: res.status, data, text };
}

function apiError(r, fallback) {
  const code = r.data?.error?.code;
  if (r.status === 401) return new DriveError('Null Drive rejected the token. Create a new one in Null Drive → Devices and paste it in Settings.', 'unauthorized');
  if (r.status === 403) return new DriveError('This token can only search. In Null Drive → Devices, create a token with full access for Null Scribe.', 'forbidden');
  if (code === 'e2ee_client_required' || /e2ee|encrypt/i.test(code || '')) return e2eeError();
  return new DriveError(`${fallback}: ${r.data?.error?.message || `HTTP ${r.status}`}`, code || `http_${r.status}`);
}

function e2eeError() {
  return new DriveError(
    'This Null Drive account is end-to-end encrypted, so it only accepts files encrypted by a Null Grid app that holds your key. Send the session to Null Notes instead: Null Notes syncs it to your encrypted Drive.',
    'e2ee'
  );
}

/** Check address + token. Returns { username, device, e2ee, base }. */
async function checkDrive({ address, token }) {
  const base = normalizeAddress(address);
  if (!token) throw new DriveError('Paste a Null Drive token in Settings.', 'no_token');
  const r = await call(base, token, 'GET', '/me');
  if (r.status === 404 || (r.status === 200 && !r.data?.user)) {
    throw new DriveError(`${base} answered, but it isn't a Null Drive server.`, 'not_drive');
  }
  if (r.status !== 200) throw apiError(r, 'Null Drive check failed');
  return { base, username: r.data.user.username, device: r.data.device?.name || null, e2ee: r.data.user.e2ee || 'off' };
}

/**
 * Upload files into <folder>/ on Drive. files: [{ name, data: Buffer }].
 * Never overwrites: on a name clash it tries "name (2).ext", "name (3).ext"…
 * Returns [{ path, size, version }].
 */
async function uploadToDrive({ address, token, folder = 'Null Scribe', files }) {
  const info = await checkDrive({ address, token });
  if (info.e2ee === 'on' || info.e2ee === 'migrating') throw e2eeError();
  const base = info.base;
  const dir = folder
    .split('/')
    .map(cleanSegment)
    .join('/');
  const uploaded = [];
  for (const f of files) {
    const ext = path.extname(f.name);
    const stem = cleanSegment(path.basename(f.name, ext));
    const sha = crypto.createHash('sha256').update(f.data).digest('hex');
    let done = null;
    for (let n = 1; n <= 50 && !done; n++) {
      const remote = `${dir}/${n === 1 ? stem : `${stem} (${n})`}${ext}`;
      const r = await call(base, token, 'PUT', `/files/${encodePath(remote)}`, {
        body: f.data,
        headers: { 'If-Match': '0', 'X-Content-SHA256': sha, 'Content-Type': 'application/octet-stream' },
        timeoutMs: 120000,
      });
      if (r.status === 200 || r.status === 201) {
        done = { path: r.data?.path || remote, size: r.data?.size ?? f.data.length, version: r.data?.version };
      } else if (r.status === 409 && (r.data?.error?.code === 'conflict' || r.data?.error?.code === 'path_collision')) {
        continue; // name taken: try the next number
      } else {
        throw apiError(r, `Upload of ${f.name} failed`);
      }
    }
    if (!done) throw new DriveError(`Couldn't find a free name for ${f.name} in ${dir}/.`, 'name_exhausted');
    uploaded.push(done);
  }
  return { base, folder: dir, uploaded };
}

module.exports = { checkDrive, uploadToDrive, normalizeAddress, encodePath, DriveError };
