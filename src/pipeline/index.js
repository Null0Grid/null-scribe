'use strict';

const fs = require('fs');
const path = require('path');
const { toWav, mixToWav, maxVolumeDb, makeMaster } = require('./audio');
const { ensureModel } = require('./models');
const { findWhisper, transcribe } = require('./transcribe');
const { summarize } = require('./summarize');
const { prepareSummarizer, engineLabel } = require('./engine');
const { mergeTracks } = require('./speakers');
const { cleanSegments } = require('./cleanup');
const { buildDocument } = require('./markdown');
const { parseWords, whisperPrompt, summaryNote } = require('./glossary');
const { resolveTemplate } = require('./templates');

const SILENT_DB = -50; // tracks quieter than this are skipped (whisper hallucinates on silence)

/**
 * Full pipeline: audio → 16 kHz WAV → whisper.cpp transcript → summary → Markdown.
 *
 * Input is either one file (inputPath) or Meeting-mode tracks: [{ path, speaker }] where
 * speaker is "You" (mic) or the app's name ("Discord", "Zoom"). Files with the same speaker are mixed,
 * each speaker is transcribed separately, and the results are merged into one labeled timeline.
 *
 * The summary comes from the built-in 3B model (llm) or the user's Ollama server, per settings.
 * Every artifact is written into sessionDir. onStage({ stage, progress, message }) reports progress.
 */
async function runPipeline({ inputPath, tracks, sessionDir, title, createdAt, sourceName, settings, binDir, modelsDir, llm, onStage, signal, templateId, deps = {} }) {
  const stage = (name, progress, message) => onStage?.({ stage: name, progress, message });
  const _toWav = deps.toWav || toWav;
  const _mix = deps.mixToWav || mixToWav;
  const _maxVolume = deps.maxVolumeDb || maxVolumeDb;
  const _makeMaster = deps.makeMaster || makeMaster;
  const _ensureModel = deps.ensureModel || ensureModel;
  const _transcribe = deps.transcribe || transcribe;
  const _prepare = deps.prepareSummarizer || prepareSummarizer;

  fs.mkdirSync(sessionDir, { recursive: true });
  const meeting = Array.isArray(tracks) && tracks.length > 0;
  const prompt = whisperPrompt(parseWords(settings.customWords));
  const groups = meeting ? groupBySpeaker(tracks) : [{ speaker: null, files: [inputPath] }];

  // 1. Convert / mix
  stage('convert', 0, meeting ? 'Mixing meeting tracks' : 'Converting audio');
  let durationMs = 0;
  for (const [i, g] of groups.entries()) {
    g.wav = path.join(sessionDir, g.speaker ? `track-${g.speaker.toLowerCase()}.wav` : 'audio.wav');
    const r = g.files.length === 1 ? await _toWav(g.files[0], g.wav, { signal }) : await _mix(g.files, g.wav, { signal });
    durationMs = Math.max(durationMs, r.durationMs || 0);
    stage('convert', (i + 1) / groups.length, 'Converting audio');
  }
  if (meeting && groups.length > 1) {
    // Combined file for listening back later.
    await _mix(groups.map((g) => g.wav), path.join(sessionDir, 'audio.wav'), { signal }).catch(() => {});
  }
  // Full-quality copy for downloads (lossless 48 kHz). Not fatal if it fails.
  const sources = meeting ? tracks.map((t) => t.path) : [inputPath];
  await _makeMaster(sources, path.join(sessionDir, 'master.flac'), { signal }).catch(() => {});
  stage('convert', 1, 'Audio ready');

  // 2. Speech model
  stage('model', 0, `Checking speech model (${settings.whisperModel})`);
  const model = await _ensureModel(settings.whisperModel, modelsDir, {
    signal,
    onProgress: (p) => stage('model', p, `Downloading speech model ${Math.round(p * 100)}%`),
  });
  stage('model', 1, 'Speech model ready');

  // 3. Transcribe each speaker's track
  stage('transcribe', 0, 'Transcribing');
  const perTrack = [];
  for (const [i, g] of groups.entries()) {
    const label = g.speaker ? ` (${g.speaker})` : '';
    if (meeting && (await _maxVolume(g.wav, { signal }).catch(() => 0)) < SILENT_DB) {
      perTrack.push({ speaker: g.speaker, segments: [] }); // nothing was said on this track
      continue;
    }
    const segments = await _transcribe({
      bin: deps.whisperBin || findWhisper(binDir),
      model,
      wav: g.wav,
      language: settings.language || 'auto',
      prompt,
      workDir: sessionDir,
      signal,
      onProgress: (p) => stage('transcribe', (i + p) / groups.length, `Transcribing${label} ${Math.round(((i + p) / groups.length) * 100)}%`),
    });
    perTrack.push({ speaker: g.speaker, segments });
  }
  const merged = meeting ? mergeTracks(perTrack) : { segments: perTrack[0].segments, droppedEcho: 0 };
  const { droppedEcho } = merged;
  // Keep the verbatim transcript, and use the cleaned one (no um/uh, stutters, [laughs]) everywhere else.
  fs.writeFileSync(path.join(sessionDir, 'transcript-raw.json'), JSON.stringify(merged.segments, null, 2));
  const segments = settings.cleanTranscript === false ? merged.segments : cleanSegments(merged.segments);
  fs.writeFileSync(path.join(sessionDir, 'transcript.json'), JSON.stringify(segments, null, 2));
  stage('transcribe', 1, `Transcribed ${segments.length} segments${droppedEcho ? ` (${droppedEcho} echoed lines removed)` : ''}`);

  // 4. Summarize
  const template = resolveTemplate(templateId || settings.summaryTemplate, settings.customTemplates);
  const summary = await summarizeSegments({ segments, settings, modelsDir, llm, signal, stage, prepare: _prepare, templateId: template.id });
  fs.writeFileSync(path.join(sessionDir, 'summary.md'), summary);

  const doc = buildDocument({
    title,
    createdAt,
    durationMs,
    sourceName: sourceName || (inputPath ? path.basename(inputPath) : 'meeting'),
    summary,
    segments,
  });
  fs.writeFileSync(path.join(sessionDir, 'document.md'), doc);
  stage('done', 1, 'Done');

  return { durationMs, segments, rawSegments: merged.segments, summary, doc, droppedEcho, template: template.id };
}

function groupBySpeaker(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const speaker = t.speaker || 'Other';
    if (!map.has(speaker)) map.set(speaker, { speaker, files: [] });
    map.get(speaker).files.push(t.path);
  }
  // "You" first so the mic track is processed first.
  return [...map.values()].sort((a, b) => (a.speaker === 'You' ? -1 : b.speaker === 'You' ? 1 : 0));
}

/** Summary step on its own; also used by "Re-summarize". */
async function summarizeSegments({ segments, settings, modelsDir, llm, signal, stage, prepare = prepareSummarizer, templateId }) {
  const template = resolveTemplate(templateId || settings.summaryTemplate, settings.customTemplates);
  const label = engineLabel(settings);
  stage('summarize', 0, `Preparing ${label}`);
  const chat = segments.length
    ? await prepare({ settings, modelsDir, llm, signal, onStatus: (p, msg) => stage('summarize', p, msg) })
    : null;
  return summarize({
    segments,
    chunkChars: Number(settings.chunkChars) || 6000,
    signal,
    chat,
    format: template.format,
    glossaryNote: summaryNote(parseWords(settings.customWords)),
    onProgress: (p) => stage('summarize', p, `Summarizing with ${label} ${Math.round(p * 100)}%`),
  });
}

module.exports = { runPipeline, summarizeSegments, groupBySpeaker };
