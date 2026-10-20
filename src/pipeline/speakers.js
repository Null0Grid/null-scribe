'use strict';

/**
 * Merging per-track transcripts (Meeting mode) into one timeline.
 *
 * Each track is transcribed on its own, so every segment already knows its speaker
 * ("You" = microphone, otherwise the meeting app's name, e.g. "Discord"). The one wrinkle is echo: on speakers
 * (no headphones) the mic also hears the other people, so the same words can show up on
 * both tracks. A "You" segment that overlaps an app segment in time and has mostly the
 * same words is treated as echo and dropped.
 */

function words(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

function overlapCounts(a, b) {
  const A = words(a);
  const B = words(b);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return { shared, a: A.size, b: B.size };
}

/** Shared words relative to the longer line: high only when the lines are mostly the same. */
function similarity(a, b) {
  const { shared, a: na, b: nb } = overlapCounts(a, b);
  return na && nb ? shared / Math.max(na, nb) : 0;
}

/** Shared words relative to the shorter line: catches a mic fragment fully contained in the app line. */
function containment(a, b) {
  const { shared, a: na, b: nb } = overlapCounts(a, b);
  return na && nb ? shared / Math.min(na, nb) : 0;
}

function overlapRatio(a, b) {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const shorter = Math.max(1, Math.min(a.end - a.start, b.end - b.start));
  return overlap / shorter;
}

/**
 * Echo = same moment AND (mostly the same words, OR the mic line is a fragment wholly inside the
 * app line). A real reply that reuses a few words ("yeah, I can hear you" after "can you hear me?")
 * fails both tests and is kept.
 */
function isEcho(micSeg, themSegs, { minOverlap = 0.3, minSimilarity = 0.6, minContainment = 0.85, slackMs = 1500 } = {}) {
  const widened = { start: micSeg.start - slackMs, end: micSeg.end + slackMs };
  return themSegs.some(
    (t) =>
      overlapRatio(widened, t) >= minOverlap &&
      (similarity(micSeg.text, t.text) >= minSimilarity || containment(micSeg.text, t.text) >= minContainment)
  );
}

/**
 * tracks: [{ speaker, segments }] → one sorted list of { start, end, text, speaker }.
 * Returns { segments, droppedEcho }.
 */
function mergeTracks(tracks, opts) {
  const them = tracks.filter((t) => t.speaker !== 'You').flatMap((t) => t.segments);
  const merged = [];
  let droppedEcho = 0;
  for (const t of tracks) {
    for (const s of t.segments) {
      if (t.speaker === 'You' && them.length && isEcho(s, them, opts)) {
        droppedEcho++;
        continue;
      }
      merged.push({ ...s, speaker: t.speaker || undefined });
    }
  }
  merged.sort((a, b) => a.start - b.start || (a.speaker === 'You' ? -1 : 1));
  return { segments: merged, droppedEcho };
}

module.exports = { mergeTracks, isEcho, similarity };
