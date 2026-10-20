'use strict';

/**
 * Transcript cleanup: turns verbatim speech into readable text without changing meaning.
 *
 *   "So, um, the — the, uh, the projections part."  →  "So, the projections part."
 *
 * Removes:  filler sounds (um, uh, er, hmm…), stage directions ([laughs], *[laughs]*),
 *           stutters and false-start repeats ("I — I", "we — we", "the, uh, the").
 * Keeps:    every real word, self-corrections ("Friday, I think? Or, no, Thursday"),
 *           and anything that could carry meaning ("like", "you know", "okay").
 *
 * Deterministic and instant (no AI), so it can't invent or drop content.
 * The raw transcript is always kept as well.
 */

const FILLERS = ['um+', 'uh+', 'uhm+', 'erm+', 'er', 'ah+', 'hmm+', 'mm+', 'mhm'];
const FILLER_RE = new RegExp(`(^|[\\s,—–-])(?:${FILLERS.join('|')})(?=[\\s,.!?—–-]|$)[,.]?`, 'gi');

function cleanText(text) {
  let t = String(text);

  // Stage directions: [laughs], *[laughs]*, (laughs), (inaudible)
  t = t.replace(/\*?\[[^\]]*\]\*?/g, ' ').replace(/\((?:laughs?|laughter|inaudible|crosstalk|sighs?|coughs?)\)/gi, ' ');

  // Fillers wrapped in commas existed only for the filler: "there's, uh, the" → "there's the".
  const F = `(?:${FILLERS.join('|')})`;
  t = t.replace(new RegExp(`,\\s*${F}\\s*,\\s*`, 'gi'), ' ');
  // Remaining filler sounds, with the comma that usually follows them.
  for (let i = 0; i < 3; i++) t = t.replace(FILLER_RE, '$1');

  // Stutters / false-start repeats of 1–3 words across a dash: "what's the — what's the", "Did I — did I".
  const phraseRepeat = /\b((?:[\w']+\s+){0,2}[\w']+)[,\s]*[—–-]\s*\1\b/gi;
  // Single-word repeats with a comma or space: "the, the", "I I".
  const wordRepeat = /\b([\w']+)(?:,\s+|\s+)\1\b/gi;
  for (let i = 0; i < 4; i++) t = t.replace(phraseRepeat, '$1').replace(wordRepeat, '$1');

  // Tidy dashes and punctuation left behind.
  t = t
    .replace(/\s*[—–]\s*(?=[,.!?]|$)/g, '') // dangling dash at end / before punctuation
    .replace(/^\s*[—–-]\s*/, '') // leading dash
    .replace(/\s+([,.!?;:])/g, '$1') // space before punctuation
    .replace(/,\s*,+/g, ',') // double commas
    .replace(/([,;:])(?=[.!?])/g, '') // ",." → "."
    .replace(/^[\s,;:.]+/, '') // leading punctuation
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Capitalize the start of the line and of each sentence (a removed "Um," can leave "what about…").
  t = t.replace(/^([a-z])/, (c) => c.toUpperCase()).replace(/([.!?]\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase());
  return t;
}

/** Clean every segment; drops segments that were nothing but filler. */
function cleanSegments(segments) {
  return segments.map((s) => ({ ...s, text: cleanText(s.text) })).filter((s) => /[\p{L}\p{N}]/u.test(s.text));
}

module.exports = { cleanText, cleanSegments };
