'use strict';

const fs = require('fs');
const path = require('path');
const { WHISPER_MODELS, LLM_MODELS, ensureModel, ensureLlmModel, modelPath } = require('../pipeline/models');

/**
 * First-run setup: works out which model files the current settings need,
 * checks free disk space, and downloads whatever is missing.
 * The installer ships the program; models (data) arrive here on first launch.
 */
function requiredModels(settings, modelsDir) {
  const items = [];
  const w = WHISPER_MODELS[settings.whisperModel] || WHISPER_MODELS['base.en'];
  const wId = WHISPER_MODELS[settings.whisperModel] ? settings.whisperModel : 'base.en';
  items.push({
    id: `whisper:${wId}`,
    kind: 'whisper',
    name: wId,
    label: `Speech model — ${w.label.split(' · ')[0]}`,
    sizeMb: w.sizeMb,
    downloaded: isPresent(modelPath(modelsDir, wId), 1_000_000),
  });
  if (settings.summaryEngine !== 'ollama') {
    const lId = LLM_MODELS[settings.builtinModel] ? settings.builtinModel : 'llama3.2-3b';
    const l = LLM_MODELS[lId];
    items.push({
      id: `llm:${lId}`,
      kind: 'llm',
      name: lId,
      label: `Summary model — ${l.label.split(' · ')[0]}`,
      sizeMb: l.sizeMb,
      downloaded: isPresent(path.join(modelsDir, l.file), 100_000_000),
    });
  }
  return items;
}

function isPresent(file, minBytes) {
  try {
    return fs.statSync(file).size >= minBytes;
  } catch (_) {
    return false;
  }
}

async function freeSpaceMb(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const s = await fs.promises.statfs(dir);
    return Math.floor((s.bavail * s.bsize) / 1e6);
  } catch (_) {
    return null; // unknown: don't block on it
  }
}

async function status(settings, modelsDir, engines) {
  const items = requiredModels(settings, modelsDir);
  const neededMb = items.filter((i) => !i.downloaded).reduce((a, i) => a + i.sizeMb, 0);
  const missingEngines = Object.entries(engines)
    .filter(([, p]) => !p)
    .map(([name]) => name);
  return {
    ready: items.every((i) => i.downloaded) && missingEngines.length === 0,
    items,
    neededMb,
    freeMb: await freeSpaceMb(modelsDir),
    missingEngines,
    engine: settings.summaryEngine,
  };
}

/** Download every missing model in order. onProgress({ id, progress }) per item. */
async function downloadMissing(settings, modelsDir, { onProgress, signal, deps = {} } = {}) {
  const _ensureModel = deps.ensureModel || ensureModel;
  const _ensureLlm = deps.ensureLlmModel || ensureLlmModel;
  const items = requiredModels(settings, modelsDir);

  const needMb = items.filter((i) => !i.downloaded).reduce((a, i) => a + i.sizeMb, 0);
  const free = await freeSpaceMb(modelsDir);
  if (free !== null && needMb > 0 && free < needMb * 1.1 + 200) {
    throw new Error(`Not enough disk space: need about ${(needMb / 1000).toFixed(1)} GB, ${(free / 1000).toFixed(1)} GB free.`);
  }

  for (const item of items) {
    if (item.downloaded) {
      onProgress?.({ id: item.id, progress: 1 });
      continue;
    }
    onProgress?.({ id: item.id, progress: 0 });
    const opts = { signal, onProgress: (p) => onProgress?.({ id: item.id, progress: p }) };
    if (item.kind === 'whisper') await _ensureModel(item.name, modelsDir, opts);
    else await _ensureLlm(item.name, modelsDir, opts);
    onProgress?.({ id: item.id, progress: 1 });
  }
}

module.exports = { requiredModels, status, downloadMissing };
