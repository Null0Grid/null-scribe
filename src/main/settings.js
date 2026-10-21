'use strict';

const fs = require('fs');
const path = require('path');
const { cleanCustom, listTemplates } = require('../pipeline/templates');
const { normalizeDays } = require('./retention');

const DEFAULTS = {
  summaryEngine: 'builtin', // 'builtin' (bundled 3B model via llama.cpp) | 'ollama'
  builtinModel: 'llama3.2-3b',
  ollamaHost: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.2:3b',
  whisperModel: 'base.en',
  language: 'auto',
  notesFolder: '', // Null Notes vault (suggested from Null Notes' recent vaults)
  notesOpenAfter: true, // open the new note in Null Notes (nullnotes://open?id=…) after sending
  driveAddress: '', // e.g. http://192.168.1.50:8080 (token is stored separately, encrypted)
  driveFolder: 'Null Scribe',
  driveSendMd: true,
  driveSendPdf: false,
  driveSendAudio: false,
  driveAudioFormat: 'mp3',
  chunkChars: 6000,
  meetingApps: [], // apps last picked in Meeting mode (pre-checked next time)
  meetingMic: true,
  micDevice: '', // '' = system default input
  liveTranscript: true,
  cleanTranscript: true, // remove um/uh, stutters and [laughs]; the verbatim copy is kept too
  customWords: '', // names/terms to spell right, one per line or comma-separated (whisper prompt + summary)
  summaryTemplate: 'meeting', // default template for new summaries (templates.js)
  customTemplates: [], // user's own templates: [{ id, name, instructions }]
  audioRetentionDays: 0, // delete recordings' audio after N days (0 = never); transcripts and summaries stay
};

function createSettingsStore(dir) {
  const file = path.join(dir, 'settings.json');
  let cache = null;

  function get() {
    if (cache) return { ...cache };
    try {
      cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (_) {
      cache = { ...DEFAULTS };
    }
    return { ...cache };
  }

  function set(patch) {
    const next = { ...get() };
    for (const key of Object.keys(DEFAULTS)) {
      if (patch && key in patch) next[key] = patch[key];
    }
    next.chunkChars = Math.min(30000, Math.max(1500, Number(next.chunkChars) || DEFAULTS.chunkChars));
    if (!['builtin', 'ollama'].includes(next.summaryEngine)) next.summaryEngine = DEFAULTS.summaryEngine;
    next.customWords = String(next.customWords || '').slice(0, 4000);
    next.customTemplates = cleanCustom(next.customTemplates);
    if (!listTemplates(next.customTemplates).some((t) => t.id === next.summaryTemplate)) next.summaryTemplate = DEFAULTS.summaryTemplate;
    next.audioRetentionDays = normalizeDays(next.audioRetentionDays);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    cache = next;
    return { ...next };
  }

  return { get, set };
}

module.exports = { createSettingsStore, DEFAULTS };
