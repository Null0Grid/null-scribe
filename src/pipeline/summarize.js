'use strict';

const { chunkSegments, segmentsToText } = require('./chunk');
const { BUILTIN } = require('./templates');

const SYSTEM_PROMPT = [
  'You summarize recorded conversations for the person who recorded them.',
  'Use only what is in the transcript. Never invent names, decisions, dates or numbers.',
  'Transcripts come from speech recognition and may contain mis-heard words; prefer the most plausible reading.',
  'Write in the same language as the transcript.',
].join(' ');

// Added for Meeting-mode transcripts, where lines carry speaker labels.
const SPEAKER_NOTE = [
  'Lines are labeled "You" (the person who recorded, speaking into their microphone) or with the name',
  'of the app the other participants were heard through (for example "Discord" or "Zoom").',
  'An app label can cover several people on that call.',
  'Attribute points and action items to "You" or to the people on that app (e.g. "Discord participants");',
  'use real names only if someone says them.',
].join(' ');

// Default sections (the Meeting template); other templates live in templates.js.
const FINAL_FORMAT = BUILTIN[0].format;

function trimHost(host) {
  return String(host || 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

/** Call Ollama's /api/chat (non-streaming) and return the reply text. */
async function ollamaChat({ host, model, messages, signal, numCtx = 8192 }) {
  let res;
  try {
    res = await fetch(`${trimHost(host)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, options: { num_ctx: numCtx, temperature: 0.2 } }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled');
    throw new Error(`Could not reach Ollama at ${trimHost(host)}: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.message?.content;
  if (typeof content !== 'string') throw new Error('Ollama reply had no message content');
  return content;
}

/** List models installed on an Ollama server (used by the Settings "Test" button). */
async function listOllamaModels(host, { signal } = {}) {
  const res = await fetch(`${trimHost(host)}/api/tags`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

/** Remove a wrapping ```markdown fence and any <think> block some models emit. */
function cleanReply(text) {
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1].trim();
  return t;
}

/**
 * Summarize transcript segments. Short transcripts go to the model in one pass;
 * long ones are summarized chunk by chunk (map) and the notes merged (reduce).
 */
async function summarize({ segments, host, model, chunkChars = 6000, onProgress, signal, chat = ollamaChat, format = FINAL_FORMAT, glossaryNote = '' }) {
  if (!segments.length) return '## Overview\nNo speech was detected in this recording.';
  const system = [SYSTEM_PROMPT, segments.some((s) => s.speaker) ? SPEAKER_NOTE : '', glossaryNote].filter(Boolean).join(' ');
  const ask = (content) => chat({ host, model, signal, messages: [{ role: 'system', content: system }, { role: 'user', content }] });

  const chunks = chunkSegments(segments, chunkChars);
  if (chunks.length === 1) {
    onProgress?.(0.1);
    const out = await ask(`Transcript:\n\n${segmentsToText(chunks[0])}\n\n${format}`);
    onProgress?.(1);
    return cleanReply(out);
  }

  const total = chunks.length + 1;
  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const reply = await ask(
      `This is part ${i + 1} of ${chunks.length} of a longer transcript.\n\n${segmentsToText(chunks[i])}\n\n` +
        'Write terse bullet notes for this part only: key points (keep [mm:ss] timestamps), decisions, ' +
        'action items with owners, and open questions. No preamble.'
    );
    notes.push(`### Part ${i + 1}\n${cleanReply(reply)}`);
    onProgress?.((i + 1) / total);
  }

  const final = await ask(
    `Below are notes taken from each part of one conversation, in order.\n\n${notes.join('\n\n')}\n\n` +
      `Merge them into a single summary of the whole conversation, removing duplicates.\n\n${format}`
  );
  onProgress?.(1);
  return cleanReply(final);
}

module.exports = { summarize, ollamaChat, listOllamaModels, cleanReply, SYSTEM_PROMPT, FINAL_FORMAT };
