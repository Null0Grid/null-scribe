'use strict';

const { formatTimestamp, segmentsToText } = require('./chunk');

function slugify(text) {
  return (
    String(text || 'conversation')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'conversation'
  );
}

function yamlString(s) {
  return JSON.stringify(String(s ?? ''));
}

/** Build the .md document saved for a session (and sent to Null Notes). */
function buildDocument({ title, createdAt, durationMs, sourceName, summary, segments }) {
  const date = new Date(createdAt);
  const front = [
    '---',
    `title: ${yamlString(title)}`,
    `date: ${date.toISOString()}`,
    `duration: ${formatTimestamp(durationMs || 0)}`,
    `source: ${yamlString(sourceName || 'recording')}`,
    'app: null-scribe',
    'tags: [scribe, conversation]',
    '---',
  ].join('\n');
  return `${front}\n\n# ${title}\n\n${summary.trim()}\n\n## Transcript\n\n${segmentsToText(segments)}\n`;
}

/** Text placed on the clipboard for "Open in Claude". */
function claudeClipboardText({ title, summary, segments }) {
  return [
    `I recorded a conversation ("${title}") and transcribed it locally with Null Scribe.`,
    'Below is an auto-generated summary followed by the full timestamped transcript.',
    'The transcript comes from speech recognition, so some words may be mis-heard.',
    'Please read it so I can ask you questions about it.',
    '',
    '=== SUMMARY ===',
    summary.trim(),
    '',
    '=== TRANSCRIPT ===',
    segmentsToText(segments),
  ].join('\n');
}

function defaultTitle(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `Conversation ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

module.exports = { slugify, buildDocument, claudeClipboardText, defaultTitle };
