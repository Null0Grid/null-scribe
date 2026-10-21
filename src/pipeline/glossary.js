'use strict';

/**
 * Custom words: names and terms the user wants spelled right (Proxmox, ZimaBoard, NULLGRID…).
 * They go to whisper.cpp as its initial prompt, which biases recognition toward those spellings,
 * and to the summarizer so it uses the same spellings.
 */

const MAX_WORDS = 100;
const MAX_PROMPT_CHARS = 600; // whisper's prompt is capped at ~224 tokens; stay well under

function parseWords(text) {
  const out = [];
  for (const w of String(text || '').split(/[\n,;]+/)) {
    const word = w.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (word && !out.some((x) => x.toLowerCase() === word.toLowerCase())) out.push(word);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

/** Initial prompt for whisper.cpp, or '' when there are no words. */
function whisperPrompt(words) {
  if (!words?.length) return '';
  let prompt = 'Glossary:';
  for (const w of words) {
    const next = `${prompt} ${w},`;
    if (next.length > MAX_PROMPT_CHARS) break;
    prompt = next;
  }
  return prompt.replace(/,$/, '.');
}

/** Line added to the summarizer's system prompt. */
function summaryNote(words) {
  if (!words?.length) return '';
  return `The speaker uses these names and terms; spell them exactly like this, even where the transcript mis-heard them: ${words.join(', ')}.`;
}

module.exports = { parseWords, whisperPrompt, summaryNote, MAX_WORDS };
