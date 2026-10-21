'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session, nativeTheme, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const { createSettingsStore } = require('./settings');
const { createSessionStore } = require('./sessions');
const { runPipeline, summarizeSegments } = require('../pipeline');
const { listOllamaModels } = require('../pipeline/summarize');
const { WHISPER_MODELS, LLM_MODELS } = require('../pipeline/models');
const { LocalLLM, findLlamaServer } = require('../pipeline/local-llm');
const { findWhisper } = require('../pipeline/transcribe');
const setup = require('./setup');
const capture = require('../capture');
const { LiveTranscriber } = require('./live');
const { modelPath } = require('../pipeline/models');
const exporter = require('../pipeline/export');
const notes = require('../integrations/notes');
const drive = require('../integrations/drive');
const { renameSpeaker } = require('../pipeline/speaker-names');
const { listTemplates, resolveTemplate, cleanCustom } = require('../pipeline/templates');
const { parseWords, whisperPrompt } = require('../pipeline/glossary');
const retention = require('./retention');

let meeting = null; // { handle, dir, startedAt } while Meeting mode is recording
const { buildDocument, claudeClipboardText, defaultTitle, slugify } = require('../pipeline/markdown');

const CLAUDE_URL = 'https://claude.ai/new';
const AUDIO_EXTS = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm', 'mp4', 'mkv', 'mov', 'wma'];

let win;
let settings;
let sessions;
let current = null; // { id, controller } for the running pipeline
let llm; // built-in summarizer (llama-server child process, started on demand)

function modelsDir() {
  return path.join(app.getPath('userData'), 'models');
}

function osDir() {
  return process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
}

function binDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', '..', 'bin', osDir());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, '..', 'renderer', 'icon-256.png'),
    title: 'Null Scribe',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Dev/CI aid: SCRIBE_CAPTURE=out.png saves a screenshot after load, then quits.
  if (process.env.SCRIBE_CAPTURE) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        // SCRIBE_CAPTURE_JS: optional script run in the page first (e.g. to switch views).
        if (process.env.SCRIBE_CAPTURE_JS) {
          await win.webContents.executeJavaScript(process.env.SCRIBE_CAPTURE_JS).catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.SCRIBE_CAPTURE, img.toPNG());
        app.quit();
      }, Number(process.env.SCRIBE_CAPTURE_DELAY) || 2500)
    );
  }

  // Links (e.g. to claude.ai) open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function sessionPayload(id) {
  return sessions.get(id);
}

function engines() {
  return { 'whisper-cli': findWhisper(binDir()), 'llama-server': findLlamaServer(binDir()) };
}

let setupController = null;

/** Live transcript preview while recording; null if the speech engine/model isn't ready. */
function startLive(handle, dir) {
  const cfg = settings.get();
  if (cfg.liveTranscript === false) return null;
  const bin = findWhisper(binDir());
  const model = modelPath(modelsDir(), cfg.whisperModel);
  if (!bin || !fs.existsSync(model)) {
    send('live:notice', 'Live transcript needs the speech model. It will appear once setup has downloaded it.');
    return null;
  }
  const live = new LiveTranscriber({
    getTracks: () => handle.liveTracks?.() || [],
    whisperBin: bin,
    model,
    language: cfg.language || 'auto',
    prompt: whisperPrompt(parseWords(cfg.customWords)),
    workDir: path.join(dir, 'live'),
    onSegments: (segments) => send('live:segments', segments),
    onNotice: (text) => send('live:notice', text),
  });
  live.start();
  return live;
}

function registerIpc() {
  // ---- first-run setup (model downloads) ----
  ipcMain.handle('setup:status', () => setup.status(settings.get(), modelsDir(), engines()));
  ipcMain.handle('setup:start', async () => {
    if (setupController) throw new Error('Setup is already running.');
    setupController = new AbortController();
    try {
      await setup.downloadMissing(settings.get(), modelsDir(), {
        signal: setupController.signal,
        onProgress: (p) => send('setup:progress', p),
      });
      return setup.status(settings.get(), modelsDir(), engines());
    } finally {
      setupController = null;
    }
  });
  ipcMain.handle('setup:cancel', () => {
    setupController?.abort();
    return true;
  });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const before = settings.get().audioRetentionDays;
    const next = settings.set(patch);
    if (next.audioRetentionDays !== before) runRetention();
    return next;
  });
  ipcMain.handle('models:list', () => ({
    whisper: Object.entries(WHISPER_MODELS).map(([id, m]) => ({ id, label: m.label })),
    llm: Object.entries(LLM_MODELS).map(([id, m]) => ({
      id,
      label: m.label,
      license: m.license,
      downloaded: fs.existsSync(path.join(modelsDir(), m.file)),
    })),
  }));
  ipcMain.handle('ollama:test', async (_e, host) => {
    try {
      return { ok: true, models: await listOllamaModels(host || settings.get().ollamaHost) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('dialog:pickAudio', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import a recording',
      properties: ['openFile'],
      filters: [{ name: 'Audio / video', extensions: AUDIO_EXTS }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose your Null Notes vault folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('recording:save', (_e, buffer) => {
    const dir = path.join(app.getPath('userData'), 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `recording-${Date.now()}.webm`);
    fs.writeFileSync(file, Buffer.from(buffer));
    return file;
  });

  // ---- Meeting mode: capture chosen apps + mic as separate tracks ----
  ipcMain.handle('meeting:available', () => capture.available(binDir()));
  ipcMain.handle('meeting:sources', () => capture.listSources(binDir()));
  ipcMain.handle('capture:mics', () => capture.listMics(binDir()));
  ipcMain.handle('meeting:start', async (_e, { appKeys = [], mic = true, micId = '', micOnly = false }) => {
    if (meeting) throw new Error('A meeting is already being recorded.');
    const dir = path.join(app.getPath('userData'), 'recordings', `meeting-${Date.now()}`);
    if (micOnly) settings.set({ micDevice: micId });
    else settings.set({ meetingApps: appKeys, meetingMic: mic, micDevice: micId });
    const handle = await capture.startCapture({
      appKeys,
      mic,
      micId,
      dir,
      binDir: binDir(),
      onStatus: (s) => send('meeting:status', s),
    });
    meeting = { handle, dir, startedAt: Date.now(), live: startLive(handle, dir) };
    return { dir, live: !!meeting.live };
  });
  ipcMain.handle('meeting:stop', async () => {
    if (!meeting) throw new Error('No meeting is being recorded.');
    const m = meeting;
    meeting = null;
    m.live?.stop();
    const tracks = await m.handle.stop();
    const apps = m.handle.linkedApps();
    if (!tracks.length) throw new Error('Nothing was recorded.');
    return { tracks, apps, dir: m.dir };
  });
  ipcMain.handle('meeting:discard', async () => {
    if (!meeting) return true;
    const m = meeting;
    meeting = null;
    m.live?.stop();
    await m.handle.stop().catch(() => {});
    fs.rmSync(m.dir, { recursive: true, force: true });
    return true;
  });

  ipcMain.handle('pipeline:run', async (_e, { inputPath, tracks, sourceName, title, templateId }) => {
    if (current) throw new Error('A recording is already being processed.');
    const isMeeting = Array.isArray(tracks) && tracks.length > 0;
    if (isMeeting) {
      for (const t of tracks) if (!fs.existsSync(t.path)) throw new Error('Meeting recording files are missing.');
    } else if (!inputPath || !fs.existsSync(inputPath)) {
      throw new Error('Audio file not found.');
    }

    const name = (title || '').trim() || defaultTitle();
    const source = sourceName || (isMeeting ? 'Meeting' : path.basename(inputPath));
    const meta = sessions.create({ title: name, source });
    const controller = new AbortController();
    current = { id: meta.id, controller };
    send('pipeline:progress', { id: meta.id, stage: 'start', progress: 0, message: 'Starting' });

    try {
      const result = await runPipeline({
        inputPath,
        tracks: isMeeting ? tracks : undefined,
        sourceName: source,
        sessionDir: sessions.dirOf(meta.id),
        title: name,
        createdAt: meta.createdAt,
        settings: settings.get(),
        binDir: binDir(),
        modelsDir: modelsDir(),
        llm,
        templateId,
        signal: controller.signal,
        onStage: (s) => send('pipeline:progress', { id: meta.id, ...s }),
      });
      sessions.update(meta.id, { status: 'done', durationMs: result.durationMs, template: result.template });
      if (isMeeting) cleanupRecording(path.dirname(tracks[0].path), true);
      else cleanupRecording(inputPath);
      return sessionPayload(meta.id);
    } catch (err) {
      sessions.update(meta.id, { status: 'error', error: err.message });
      send('pipeline:progress', { id: meta.id, stage: 'error', progress: 0, message: err.message });
      throw err;
    } finally {
      current = null;
    }
  });

  // Re-run only the summary step (e.g. after switching Ollama model). Reuses the saved transcript.
  ipcMain.handle('pipeline:resummarize', async (_e, arg) => {
    const { id, templateId } = typeof arg === 'object' && arg ? arg : { id: arg };
    if (current) throw new Error('Something is already being processed.');
    const data = sessions.get(id);
    const cfg = settings.get();
    const template = resolveTemplate(templateId || data.meta.template || cfg.summaryTemplate, cfg.customTemplates);
    if (!data.segments.length) throw new Error('This session has no transcript to summarize.');
    const controller = new AbortController();
    current = { id, controller };
    try {
      const summary = await summarizeSegments({
        segments: data.segments,
        settings: cfg,
        templateId: template.id,
        modelsDir: modelsDir(),
        llm,
        signal: controller.signal,
        stage: (stage, progress, message) => send('pipeline:progress', { id, stage, progress, message }),
      });
      const dir = sessions.dirOf(id);
      fs.writeFileSync(path.join(dir, 'summary.md'), summary);
      const doc = buildDocument({ ...data.meta, sourceName: data.meta.source, summary, segments: data.segments });
      fs.writeFileSync(path.join(dir, 'document.md'), doc);
      sessions.update(id, { status: 'done', error: undefined, template: template.id });
      send('pipeline:progress', { id, stage: 'done', progress: 1, message: 'Done' });
      return sessionPayload(id);
    } catch (err) {
      send('pipeline:progress', { id, stage: 'error', progress: 0, message: err.message });
      throw err;
    } finally {
      current = null;
    }
  });

  ipcMain.handle('pipeline:cancel', () => {
    current?.controller.abort();
    return true;
  });

  ipcMain.handle('sessions:list', () => sessions.list());
  ipcMain.handle('sessions:get', (_e, id) => sessionPayload(id));
  ipcMain.handle('sessions:rename', (_e, { id, title }) => {
    const data = sessions.get(id);
    const name = String(title || '').trim() || data.meta.title;
    sessions.update(id, { title: name });
    if (data.summary) {
      const doc = buildDocument({ ...data.meta, title: name, sourceName: data.meta.source, summary: data.summary, segments: data.segments });
      fs.writeFileSync(path.join(sessions.dirOf(id), 'document.md'), doc);
    }
    return sessionPayload(id);
  });
  ipcMain.handle('sessions:delete', (_e, id) => {
    if (current?.id === id) throw new Error('Cancel processing before deleting.');
    sessions.remove(id);
    return true;
  });

  // Rename a speaker ("Discord" → "Tom") in the transcript, the verbatim copy and the summary.
  ipcMain.handle('sessions:rename-speaker', (_e, { id, from, to }) => {
    if (current?.id === id) throw new Error('Wait until processing finishes.');
    const data = sessions.get(id);
    const dir = sessions.dirOf(id);
    const rawFile = path.join(dir, 'transcript-raw.json');
    let rawSegments = null;
    try {
      rawSegments = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    } catch (_) {
      /* older sessions have no verbatim copy */
    }
    const r = renameSpeaker({ segments: data.segments, rawSegments, summary: data.summary, from, to });
    fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(r.segments, null, 2));
    if (rawSegments) fs.writeFileSync(rawFile, JSON.stringify(r.rawSegments, null, 2));
    if (data.summary) fs.writeFileSync(path.join(dir, 'summary.md'), r.summary);
    if (data.summary || data.document) {
      const doc = buildDocument({ ...data.meta, sourceName: data.meta.source, summary: r.summary || '', segments: r.segments });
      fs.writeFileSync(path.join(dir, 'document.md'), doc);
    }
    const names = { ...(data.meta.speakerNames || {}) };
    const original = Object.keys(names).find((k) => names[k] === from) || from;
    names[original] = r.name;
    sessions.update(id, { speakerNames: names });
    return sessionPayload(id);
  });

  // ---- Summary templates: built-ins + the user's own ----
  ipcMain.handle('templates:list', () => {
    const cfg = settings.get();
    return { templates: listTemplates(cfg.customTemplates), defaultId: cfg.summaryTemplate };
  });
  ipcMain.handle('templates:save', (_e, { id, name, instructions }) => {
    const cfg = settings.get();
    const list = cleanCustom(cfg.customTemplates);
    const n = String(name || '').trim();
    const ins = String(instructions || '').trim();
    if (!n) throw new Error('Give the template a name.');
    if (!ins) throw new Error('Write what the summary should contain.');
    if (listTemplates(list).some((t) => t.name.toLowerCase() === n.toLowerCase() && t.id !== id)) throw new Error(`There's already a template called "${n}".`);
    const existing = list.find((t) => t.id === id);
    let savedId = id;
    if (existing) Object.assign(existing, { name: n, instructions: ins });
    else {
      if (list.length >= 50) throw new Error('You can keep up to 50 of your own templates.');
      savedId = `custom-${Date.now().toString(36)}`;
      list.push({ id: savedId, name: n, instructions: ins });
    }
    settings.set({ customTemplates: list });
    return { templates: listTemplates(settings.get().customTemplates), savedId };
  });
  ipcMain.handle('templates:delete', (_e, id) => {
    const cfg = settings.get();
    const list = cleanCustom(cfg.customTemplates).filter((t) => t.id !== id);
    const patch = { customTemplates: list };
    if (cfg.summaryTemplate === id) patch.summaryTemplate = 'meeting';
    settings.set(patch);
    const next = settings.get();
    return { templates: listTemplates(next.customTemplates), defaultId: next.summaryTemplate };
  });

  // ---- Null Notes: write a note (with a Null Notes id) into the vault, then open it ----
  ipcMain.handle('notes:vaults', () => notes.detectVaults());
  ipcMain.handle('share:notes', async (_e, id) => {
    const cfg = settings.get();
    const data = sessions.get(id);
    if (!data.document) throw new Error('This session has no summary yet.');
    const out = notes.sendToNotes({ vault: cfg.notesFolder, title: data.meta.title, createdAt: data.meta.createdAt, markdown: data.document });
    sessions.update(id, { notes: { file: out.file, id: out.id, at: new Date().toISOString() } });
    let opened = false;
    if (cfg.notesOpenAfter !== false) {
      // Give Null Notes' watcher a moment to index the new file before the link asks for it.
      await new Promise((r) => setTimeout(r, 1200));
      opened = await shell.openExternal(out.link).then(() => true, () => false);
    }
    return { ...out, vault: cfg.notesFolder, opened };
  });

  // ---- Null Drive: address + token (token kept encrypted by the OS keychain) ----
  ipcMain.handle('drive:token-status', () => ({ saved: !!readDriveToken(), secure: safeStorage.isEncryptionAvailable() }));
  ipcMain.handle('drive:set-token', (_e, token) => saveDriveToken(String(token || '').trim()));
  ipcMain.handle('drive:test', async (_e, { address, token } = {}) => {
    try {
      const info = await drive.checkDrive({ address: address ?? settings.get().driveAddress, token: token || readDriveToken() });
      return { ok: true, ...info };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  });
  ipcMain.handle('share:drive', async (_e, { id, md = true, pdf = false, audio = false, audioFormat = 'mp3' }) => {
    const cfg = settings.get();
    const data = sessions.get(id);
    if (!md && !pdf && !audio) throw new Error('Pick at least one thing to upload.');
    const token = readDriveToken();
    const stem = `${data.meta.createdAt.slice(0, 10)} ${data.meta.title}`;
    const doc = { meta: data.meta, summary: data.summary || '', segments: data.segments };
    const files = [];
    if (md) {
      if (!data.document) throw new Error('This session has no summary yet.');
      files.push({ name: `${stem}.md`, data: Buffer.from(data.document) });
    }
    if (pdf) files.push({ name: `${stem}.pdf`, data: await htmlToPdf(exporter.buildHtml(doc), sessions.dirOf(id)) });
    if (audio) {
      const f = exporter.AUDIO_FORMATS[audioFormat] || exporter.AUDIO_FORMATS.mp3;
      const dir = sessions.dirOf(id);
      const src = ['master.flac', 'audio.wav'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
      if (!src) throw new Error(noAudioMessage(data.meta));
      const tmp = path.join(dir, `.upload.${f.ext}`);
      try {
        await exporter.exportAudio(src, tmp, audioFormat in exporter.AUDIO_FORMATS ? audioFormat : 'mp3', { title: data.meta.title });
        files.push({ name: `${stem}.${f.ext}`, data: fs.readFileSync(tmp) });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    const result = await drive.uploadToDrive({ address: cfg.driveAddress, token, folder: cfg.driveFolder || 'Null Scribe', files });
    sessions.update(id, { drive: { at: new Date().toISOString(), paths: result.uploaded.map((u) => u.path) } });
    return result;
  });

  // Open in Claude: copy summary + transcript to the clipboard, then open claude.ai in the browser.
  ipcMain.handle('share:claude', async (_e, id) => {
    const data = sessions.get(id);
    if (!data.summary) throw new Error('This session has no summary yet.');
    const text = claudeClipboardText({ title: data.meta.title, summary: data.summary, segments: data.segments });
    clipboard.writeText(text);
    await shell.openExternal(CLAUDE_URL);
    return { chars: text.length };
  });

  ipcMain.handle('share:export', async (_e, id) => {
    const data = sessions.get(id);
    if (!data.document) throw new Error('This session has no summary yet.');
    const r = await dialog.showSaveDialog(win, {
      title: 'Export Markdown',
      defaultPath: `${data.meta.createdAt.slice(0, 10)}-${slugify(data.meta.title)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, data.document);
    return r.filePath;
  });

  // ---- Downloads: audio (5 formats) and transcript (md/txt/pdf/html) ----
  ipcMain.handle('export:formats', () => ({
    audio: Object.entries(exporter.AUDIO_FORMATS).map(([id, f]) => ({ id, label: f.label, note: f.note })),
    transcript: Object.entries(exporter.TRANSCRIPT_FORMATS).map(([id, f]) => ({ id, label: f.label, ext: f.ext })),
  }));

  ipcMain.handle('export:audio', async (_e, { id, format }) => {
    const data = sessions.get(id);
    const f = exporter.AUDIO_FORMATS[format];
    if (!f) throw new Error('Unknown audio format.');
    const dir = sessions.dirOf(id);
    // Prefer the lossless master; older sessions only have the 16 kHz transcription copy.
    const src = ['master.flac', 'audio.wav'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
    if (!src) throw new Error(noAudioMessage(data.meta));
    const dest = await askSavePath(data.meta, f.ext, `${f.label} audio`);
    if (!dest) return null;
    await exporter.exportAudio(src, dest, format, { title: data.meta.title });
    return dest;
  });

  ipcMain.handle('export:transcript', async (_e, { id, format }) => {
    const data = sessions.get(id);
    const f = exporter.TRANSCRIPT_FORMATS[format];
    if (!f) throw new Error('Unknown transcript format.');
    if (!data.summary && !data.segments.length) throw new Error('This session has no transcript yet.');
    const doc = { meta: data.meta, summary: data.summary || '', segments: data.segments };
    const dest = await askSavePath(data.meta, f.ext, f.label);
    if (!dest) return null;
    if (format === 'md') {
      const md = data.document || buildDocument({ ...data.meta, sourceName: data.meta.source, summary: doc.summary, segments: doc.segments });
      fs.writeFileSync(dest, md);
    } else if (format === 'txt') {
      fs.writeFileSync(dest, exporter.buildText(doc));
    } else if (format === 'html') {
      fs.writeFileSync(dest, exporter.buildHtml(doc));
    } else if (format === 'pdf') {
      fs.writeFileSync(dest, await htmlToPdf(exporter.buildHtml(doc), sessions.dirOf(id)));
    } else if (format === 'srt') {
      fs.writeFileSync(dest, exporter.buildSrt(doc.segments));
    } else if (format === 'vtt') {
      fs.writeFileSync(dest, exporter.buildVtt(doc.segments, { title: data.meta.title }));
    }
    return dest;
  });

  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });
}

function noAudioMessage(meta) {
  if (meta.audioDeletedAt) {
    return `The audio was deleted automatically on ${new Date(meta.audioDeletedAt).toLocaleDateString()} (Settings → Storage). The transcript and summary are still here.`;
  }
  return 'This session has no audio saved.';
}

/* Auto-delete old audio (Settings → Storage). Runs at startup, every 6 hours, and when the setting changes. */
function runRetention() {
  try {
    const removed = retention.pruneAudio(sessions, settings.get().audioRetentionDays, { busyId: current?.id });
    if (removed.length) send('sessions:changed', { audioDeleted: removed.map((r) => r.id) });
  } catch (err) {
    console.error('Audio cleanup failed:', err.message);
  }
}

/* Drive token: encrypted with the OS keychain (DPAPI on Windows, libsecret/kwallet on Linux).
   Without a keychain it's kept in memory for this run only, never written in plain text. */
let memoryDriveToken = '';
function driveTokenFile() {
  return path.join(app.getPath('userData'), 'drive-token.bin');
}
function readDriveToken() {
  if (memoryDriveToken) return memoryDriveToken;
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(fs.readFileSync(driveTokenFile()));
  } catch (_) {
    return '';
  }
}
function saveDriveToken(token) {
  memoryDriveToken = '';
  if (!token) {
    fs.rmSync(driveTokenFile(), { force: true });
    return { saved: false, secure: safeStorage.isEncryptionAvailable() };
  }
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(driveTokenFile(), safeStorage.encryptString(token), { mode: 0o600 });
    return { saved: true, secure: true };
  }
  memoryDriveToken = token;
  return { saved: true, secure: false };
}

async function askSavePath(meta, ext, label) {
  const r = await dialog.showSaveDialog(win, {
    title: `Download ${label}`,
    defaultPath: path.join(app.getPath('downloads'), `${meta.createdAt.slice(0, 10)}-${slugify(meta.title)}.${ext}`),
    filters: [{ name: label, extensions: [ext] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
}

/** Render HTML to PDF with Chromium (no extra dependency). Letter for US/Canada, A4 elsewhere. */
async function htmlToPdf(html, workDir) {
  const tmp = path.join(workDir, `.export-${Date.now()}.html`);
  fs.writeFileSync(tmp, html);
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await pdfWin.loadFile(tmp);
    const letter = /^en-(US|CA)|^es-(US|MX)|^fr-CA/i.test(app.getLocale());
    return await pdfWin.webContents.printToPDF({ printBackground: true, pageSize: letter ? 'Letter' : 'A4' });
  } finally {
    pdfWin.destroy();
    fs.rmSync(tmp, { force: true });
  }
}

/** Delete temporary mic recordings once processed; the session keeps its own audio.wav. */
function cleanupRecording(target, isDir = false) {
  const recDir = path.join(app.getPath('userData'), 'recordings');
  const rel = path.relative(recDir, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return; // never delete files imported from elsewhere
  // A file inside a capture folder (recordings/meeting-123/you.wav) → remove the whole folder.
  const top = path.join(recDir, rel.split(path.sep)[0]);
  fs.rmSync(isDir || top !== target ? top : target, { force: true, recursive: true });
}

app.whenReady().then(() => {
  const data = app.getPath('userData');
  settings = createSettingsStore(data);
  sessions = createSessionStore(path.join(data, 'sessions'));
  sessions.recoverInterrupted();
  nativeTheme.themeSource = 'dark'; // dark only: native dialogs, menus and scrollbars match
  llm = new LocalLLM({ bin: findLlamaServer(binDir()) });

  // Allow microphone access for in-app recording; deny everything else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  registerIpc();
  createWindow();
  runRetention();
  setInterval(runRetention, 6 * 60 * 60 * 1000).unref?.();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  llm?.stop();
  meeting?.handle.stop().catch(() => {});
});

app.on('window-all-closed', () => {
  current?.controller.abort();
  llm?.stop();
  if (process.platform !== 'darwin') app.quit();
});
