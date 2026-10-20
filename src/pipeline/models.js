'use strict';

const path = require('path');
const { downloadFile } = require('./download');

const WHISPER_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

// Optional local mirror (e.g. a homelab file server): NULL_SCRIBE_MODEL_MIRROR=http://nas.lan/models
// must serve the same file names (ggml-base.en.bin, Llama-3.2-3B-Instruct-Q4_K_M.gguf, ...).
const mirror = () => (process.env.NULL_SCRIBE_MODEL_MIRROR || '').replace(/\/+$/, '');

// Speech models (whisper.cpp). Sizes are approximate, for the UI.
const WHISPER_MODELS = {
  'tiny.en': { label: 'Tiny (English) · 75 MB · fastest', sizeMb: 75 },
  tiny: { label: 'Tiny (multilingual) · 75 MB', sizeMb: 75 },
  'base.en': { label: 'Base (English) · 142 MB · recommended', sizeMb: 142 },
  base: { label: 'Base (multilingual) · 142 MB', sizeMb: 142 },
  'small.en': { label: 'Small (English) · 466 MB', sizeMb: 466 },
  small: { label: 'Small (multilingual) · 466 MB', sizeMb: 466 },
  'medium.en': { label: 'Medium (English) · 1.5 GB · slow on CPU', sizeMb: 1500 },
  'large-v3-turbo': { label: 'Large v3 Turbo · 1.6 GB · best accuracy', sizeMb: 1600 },
};

// Built-in summary models (llama.cpp GGUF, ~3B parameters, 4-bit). Check each license before shipping.
const LLM_MODELS = {
  'llama3.2-3b': {
    label: 'Llama 3.2 3B · 2.0 GB · recommended',
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeMb: 2020,
    license: 'Llama 3.2 Community License (commercial use allowed; requires "Built with Llama")',
  },
  'qwen2.5-3b': {
    label: 'Qwen 2.5 3B · 2.1 GB · personal use',
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    sizeMb: 2100,
    license: 'Qwen Research License (restrictions on commercial use)',
  },
};

function modelPath(modelsDir, name) {
  return path.join(modelsDir, `ggml-${name}.bin`);
}

/** Make sure a whisper speech model exists locally, downloading it on first use. */
async function ensureModel(name, modelsDir, { onProgress, signal, baseUrl = mirror() || WHISPER_BASE } = {}) {
  const m = WHISPER_MODELS[name];
  if (!m) throw new Error(`Unknown whisper model: ${name}`);
  return downloadFile(`${baseUrl}/ggml-${name}.bin`, modelPath(modelsDir, name), {
    onProgress,
    signal,
    expectedBytes: m.sizeMb * 1e6,
  });
}

/** Make sure a built-in summary model (GGUF) exists locally, downloading it on first use. */
async function ensureLlmModel(name, modelsDir, { onProgress, signal, url } = {}) {
  const m = LLM_MODELS[name];
  if (!m) throw new Error(`Unknown summary model: ${name}`);
  return downloadFile(url || (mirror() ? `${mirror()}/${m.file}` : m.url), path.join(modelsDir, m.file), {
    onProgress,
    signal,
    expectedBytes: m.sizeMb * 1e6,
    minBytes: 100_000_000,
  });
}

module.exports = { WHISPER_MODELS, LLM_MODELS, ensureModel, ensureLlmModel, modelPath };
