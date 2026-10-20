'use strict';

/**
 * Null Notes integration.
 *
 * Null Notes is a folder of Markdown files ("vault"). Every .md note carries a stable id in its
 * frontmatter (`id: <uuid>`), and the app opens a note by id from `nullnotes://open?id=<uuid>`,
 * finding it by scanning frontmatter. Its file watcher indexes new files within ~2 s, which also
 * makes them searchable from Null Search.
 *
 * So "send to Null Notes" = write <vault>/Scribe/<date>-<title>.md with a fresh id, then (optionally)
 * open the nullnotes:// link. No API, no running app required.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NOTES_ID = 'dev.nullgrid.notes'; // Tauri app identifier → its config folder name
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where Null Notes keeps settings.json ({ last, recent: [...] }) on this OS, incl. Store installs. */
function notesSettingsCandidates(env = process.env, platform = process.platform, home = os.homedir()) {
  const out = [];
  if (platform === 'win32') {
    if (env.APPDATA) out.push(path.join(env.APPDATA, NOTES_ID, 'settings.json'));
    // Microsoft Store (MSIX) builds have AppData redirected into the package folder.
    if (env.LOCALAPPDATA) {
      const pk = path.join(env.LOCALAPPDATA, 'Packages');
      try {
        for (const d of fs.readdirSync(pk)) {
          if (/^NULLGRID\.NullNotes_/i.test(d)) out.push(path.join(pk, d, 'LocalCache', 'Roaming', NOTES_ID, 'settings.json'));
        }
      } catch (_) {}
    }
  } else if (platform === 'darwin') {
    out.push(path.join(home, 'Library', 'Application Support', NOTES_ID, 'settings.json'));
  } else {
    out.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), NOTES_ID, 'settings.json'));
  }
  return out;
}

/** Vaults Null Notes has opened recently (most recent first), that still exist. */
function detectVaults(opts = {}) {
  const seen = new Set();
  const vaults = [];
  for (const file of notesSettingsCandidates(opts.env, opts.platform, opts.home)) {
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue;
    }
    for (const v of [cfg.last, ...(Array.isArray(cfg.recent) ? cfg.recent : [])]) {
      if (typeof v !== 'string' || !v || seen.has(v)) continue;
      seen.add(v);
      try {
        if (fs.statSync(v).isDirectory()) vaults.push({ path: v, name: path.basename(v) || v });
      } catch (_) {}
    }
  }
  return vaults;
}

/** Add (or replace) `id:` as the first frontmatter field, the way Null Notes writes it. */
function withNoteId(markdown, id) {
  const text = String(markdown).replace(/^---\r?\nid:.*\r?\n/, '---\n');
  if (/^---\r?\n/.test(text)) return text.replace(/^---\r?\n/, `---\nid: ${id}\n`);
  return `---\nid: ${id}\n---\n${text}`;
}

function safeFileName(name) {
  return (
    String(name)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 100) || 'Conversation'
  );
}

/**
 * Write the session into the vault. Returns { file, id, link }.
 * Never overwrites: a name clash gets " (2)", " (3)"…
 */
function sendToNotes({ vault, folder = 'Scribe', title, createdAt, markdown }) {
  if (!vault) throw new Error('Choose your Null Notes vault in Settings first.');
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) throw new Error(`Null Notes vault not found: ${vault}`);
  const dir = path.join(vault, folder);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${String(createdAt).slice(0, 10)} ${safeFileName(title)}`;
  let file = path.join(dir, `${base}.md`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n}).md`);
  const id = crypto.randomUUID();
  // Write to a temp name first so Null Notes' watcher never sees a half-written note.
  const tmp = path.join(dir, `.${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, withNoteId(markdown, id));
  fs.renameSync(tmp, file);
  return { file, id, link: noteLink(id) };
}

function noteLink(id) {
  if (!UUID_RE.test(id)) throw new Error('Invalid note id');
  return `nullnotes://open?id=${id}`;
}

module.exports = { detectVaults, notesSettingsCandidates, sendToNotes, withNoteId, noteLink, safeFileName };
