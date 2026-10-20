'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Each session is a folder: meta.json, audio.wav, transcript.json, summary.md, document.md. */
function createSessionStore(root) {
  fs.mkdirSync(root, { recursive: true });

  const dirOf = (id) => {
    if (!/^[a-z0-9-]+$/i.test(String(id))) throw new Error('Invalid session id');
    return path.join(root, id);
  };

  function create({ title, source }) {
    const createdAt = new Date().toISOString();
    const id = `${createdAt.slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    const meta = { id, title, source, createdAt, status: 'processing', durationMs: 0 };
    fs.mkdirSync(dirOf(id), { recursive: true });
    writeMeta(meta);
    return meta;
  }

  function writeMeta(meta) {
    fs.writeFileSync(path.join(dirOf(meta.id), 'meta.json'), JSON.stringify(meta, null, 2));
  }

  function update(id, patch) {
    const meta = { ...readMeta(id), ...patch, id };
    writeMeta(meta);
    return meta;
  }

  function readMeta(id) {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'meta.json'), 'utf8'));
  }

  function readText(id, name) {
    try {
      return fs.readFileSync(path.join(dirOf(id), name), 'utf8');
    } catch (_) {
      return null;
    }
  }

  function list() {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        try {
          return readMeta(d.name);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function get(id) {
    const meta = readMeta(id);
    const transcriptRaw = readText(id, 'transcript.json');
    return {
      meta,
      summary: readText(id, 'summary.md'),
      document: readText(id, 'document.md'),
      segments: transcriptRaw ? JSON.parse(transcriptRaw) : [],
    };
  }

  function remove(id) {
    fs.rmSync(dirOf(id), { recursive: true, force: true });
  }

  /** Mark sessions left "processing" by a crash or quit as failed. */
  function recoverInterrupted() {
    for (const meta of list()) {
      if (meta.status === 'processing') update(meta.id, { status: 'error', error: 'Interrupted before finishing' });
    }
  }

  return { create, update, list, get, remove, dirOf, recoverInterrupted };
}

module.exports = { createSessionStore };
