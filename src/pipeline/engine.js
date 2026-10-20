'use strict';

const { ensureLlmModel, LLM_MODELS } = require('./models');
const { ollamaChat } = require('./summarize');

/**
 * Return a chat(messages) function for the configured summary engine.
 *  - "builtin": downloads the GGUF on first use and starts the bundled llama-server (LocalLLM).
 *  - "ollama":  talks to the user's Ollama server.
 * onStatus(fraction, message) reports download/load progress.
 */
async function prepareSummarizer({ settings, modelsDir, llm, signal, onStatus, deps = {} }) {
  if (settings.summaryEngine === 'ollama') {
    return (opts) => ollamaChat({ ...opts, host: settings.ollamaHost, model: settings.ollamaModel });
  }

  const name = settings.builtinModel in LLM_MODELS ? settings.builtinModel : 'llama3.2-3b';
  const file = await (deps.ensureLlmModel || ensureLlmModel)(name, modelsDir, {
    signal,
    onProgress: (p) => onStatus?.(0, `Downloading summary model ${Math.round(p * 100)}%`),
  });
  onStatus?.(0, 'Loading summary model');
  await llm.start(file, { signal });
  return (opts) => llm.chat(opts);
}

function engineLabel(settings) {
  if (settings.summaryEngine === 'ollama') return settings.ollamaModel;
  return (LLM_MODELS[settings.builtinModel] || LLM_MODELS['llama3.2-3b']).label.split(' · ')[0];
}

module.exports = { prepareSummarizer, engineLabel };
