'use strict';

/**
 * Rename a speaker label ("Discord" → "Tom", "You" → "Luke") in a session's transcript and summary.
 *
 * Segments keep a `role` ("you" | "app") so the transcript colours stay right after renaming "You".
 * In the summary, app labels are proper nouns and are replaced wherever they appear as a whole word
 * ("Discord participants" becomes just the new name). "You" is an ordinary word in prose, so it is
 * only replaced where the summary uses it as a label: at the start of a list item or before a dash/colon.
 */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function cleanName(name) {
  return String(name ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 40);
}

/** Distinct speaker labels in first-appearance order. */
function speakersOf(segments) {
  const seen = [];
  for (const s of segments || []) if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  return seen;
}

function roleOf(seg) {
  return seg.role || (seg.speaker === 'You' ? 'you' : 'app');
}

function renameInSegments(segments, from, to) {
  return (segments || []).map((s) => (s.speaker === from ? { ...s, role: roleOf(s), speaker: to } : s));
}

function renameInSummary(summary, from, to, { wasYou = false } = {}) {
  if (!summary) return summary;
  const f = escapeRe(from);
  if (wasYou || from === 'You') {
    return summary
      .split('\n')
      .map((line) =>
        line
          // "- [ ] You — …", "- You: …", "* You - …"
          .replace(new RegExp(`^(\\s*[-*•]\\s+(?:\\[[ xX]\\]\\s+)?)${f}\\b`), `$1${to}`)
          // "… You — send…" / "You: …" anywhere (label use)
          .replace(new RegExp(`\\b${f}(?=\\s*[—–:]|\\s+-\\s)`, 'g'), to)
      )
      .join('\n');
  }
  return summary
    .replace(new RegExp(`\\b${f} (participants?|users?|callers?|side|team)\\b`, 'g'), to)
    .replace(new RegExp(`\\b${f}\\b`, 'g'), to);
}

/**
 * Returns { segments, rawSegments, summary } with `from` renamed to `to`.
 * Throws on an empty name or a name another speaker already uses.
 */
function renameSpeaker({ segments, rawSegments, summary, from, to }) {
  const name = cleanName(to);
  if (!name) throw new Error('Enter a name.');
  if (name === from) return { segments, rawSegments, summary, name };
  const current = speakersOf(segments);
  if (!current.includes(from)) throw new Error(`No speaker called "${from}" in this transcript.`);
  if (current.includes(name)) throw new Error(`"${name}" is already used by another speaker.`);
  const wasYou = (segments || []).some((s) => s.speaker === from && roleOf(s) === 'you');
  return {
    segments: renameInSegments(segments, from, name),
    rawSegments: rawSegments ? renameInSegments(rawSegments, from, name) : rawSegments,
    summary: renameInSummary(summary, from, name, { wasYou }),
    name,
  };
}

module.exports = { renameSpeaker, renameInSummary, speakersOf, roleOf, cleanName };
