'use strict';

/**
 * Format milliseconds as mm:ss, or hh:mm:ss once past an hour.
 */
function formatTimestamp(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** One transcript line per segment: "[mm:ss] text", or "[mm:ss] You: text" when speakers are known. */
function segmentsToText(segments) {
  return segments.map((s) => `[${formatTimestamp(s.start)}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n');
}

/**
 * Split segments into groups whose rendered text stays under maxChars.
 * Never splits a segment; a single oversized segment becomes its own chunk.
 */
function chunkSegments(segments, maxChars = 6000) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const seg of segments) {
    const len = seg.text.length + 12; // timestamp prefix + newline
    if (current.length && size + len > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(seg);
    size += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

module.exports = { formatTimestamp, segmentsToText, chunkSegments };
