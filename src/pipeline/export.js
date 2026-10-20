'use strict';

/**
 * Downloads: audio in the five most common formats, transcript as .md / .txt / .html / .pdf.
 * (PDF is made by the Electron main process from the HTML; see main.js.)
 */

const { runFfmpeg } = require('./audio');
const { formatTimestamp } = require('./chunk');
const { renderMarkdown, escapeHtml } = require('../renderer/markdown');

const AUDIO_FORMATS = {
  mp3: { label: 'MP3', ext: 'mp3', note: 'plays everywhere', args: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
  m4a: { label: 'M4A (AAC)', ext: 'm4a', note: 'Apple / phones', args: ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'] },
  wav: { label: 'WAV', ext: 'wav', note: 'uncompressed', args: ['-c:a', 'pcm_s16le'] },
  flac: { label: 'FLAC', ext: 'flac', note: 'lossless, smaller', args: ['-c:a', 'flac'] },
  ogg: { label: 'OGG (Vorbis)', ext: 'ogg', note: 'open format', args: ['-c:a', 'libvorbis', '-q:a', '5'] },
};

const TRANSCRIPT_FORMATS = {
  md: { label: 'Markdown', ext: 'md' },
  txt: { label: 'Plain text', ext: 'txt' },
  pdf: { label: 'PDF', ext: 'pdf' },
  html: { label: 'Web page', ext: 'html' },
};

async function exportAudio(src, dest, format, { title, ffmpeg, signal } = {}) {
  const f = AUDIO_FORMATS[format];
  if (!f) throw new Error(`Unknown audio format: ${format}`);
  const meta = title ? ['-metadata', `title=${title}`, '-metadata', 'comment=Recorded with Null Scribe'] : [];
  await runFfmpeg(['-y', '-i', src, '-vn', ...f.args, ...meta, dest], { ffmpeg, signal });
  return dest;
}

function metaLines(meta) {
  const date = new Date(meta.createdAt);
  return [
    `Date: ${date.toLocaleString()}`,
    meta.durationMs ? `Duration: ${formatTimestamp(meta.durationMs)}` : null,
    meta.source ? `Source: ${meta.source}` : null,
  ].filter(Boolean);
}

/** Markdown → readable plain text (headings uppercased, checkboxes kept, emphasis removed). */
function markdownToText(md) {
  return String(md || '')
    .split('\n')
    .map((line) => {
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      if (h) return `\n${h[1].toUpperCase()}`;
      return line
        .replace(/^\s*[-*]\s+\[([ xX])\]\s+/, (_, x) => (x.trim() ? '  [x] ' : '  [ ] '))
        .replace(/^\s*[-*•]\s+/, '  • ')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function transcriptLine(s) {
  return `[${formatTimestamp(s.start)}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`;
}

function buildText({ meta, summary, segments }) {
  const rule = '='.repeat(Math.min(70, Math.max(10, meta.title.length)));
  return [
    meta.title,
    rule,
    ...metaLines(meta),
    '',
    'SUMMARY',
    '-------',
    markdownToText(summary || 'No summary.'),
    '',
    'TRANSCRIPT',
    '----------',
    ...segments.map(transcriptLine),
    '',
  ].join('\n');
}

/** Standalone, print-friendly HTML (also the source for the PDF). */
function buildHtml({ meta, summary, segments }) {
  const rows = segments
    .map((s) => {
      const spk = s.speaker ? `<span class="spk ${s.speaker === 'You' ? 'you' : 'app'}">${escapeHtml(s.speaker)}</span>` : '';
      return `<tr><td class="t">${formatTimestamp(s.start)}</td><td>${spk}${escapeHtml(s.text)}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Null Scribe">
<title>${escapeHtml(meta.title)}</title>
<style>
  :root { --text:#121624; --muted:#5a6178; --line:#d5dae6; --accent:#007f99; --pink:#c4126a; --green:#128a4a; --app:#c4126a; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.6 "IBM Plex Sans", -apple-system, "Segoe UI", "Noto Sans", sans-serif; color: var(--text); background: #fff; }
  main { max-width: 820px; margin: 0 auto; padding: 48px 32px 64px; }
  .brand { font: 700 12px "Silkscreen", "JetBrains Mono", ui-monospace, monospace; letter-spacing: .1em; color: var(--text); }
  .brand::after { content: ""; display: block; height: 2px; width: 120px; margin-top: 8px; background: linear-gradient(90deg, var(--accent), var(--pink)); }
  .brand b { color: var(--accent); }
  h1 { font-size: 28px; margin: 6px 0 4px; line-height: 1.25; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  .meta span + span::before { content: " · "; }
  section { margin-top: 28px; }
  section > h2.section { font: 600 11px ui-monospace, monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 6px; margin: 0 0 12px; }
  .summary h2 { font-size: 16px; margin: 20px 0 6px; }
  .summary h3, .summary h4 { font-size: 15px; margin: 16px 0 4px; }
  .summary ul, .summary ol { padding-left: 22px; margin: 6px 0; }
  .summary li { margin: 3px 0; }
  .summary li.task { list-style: none; margin-left: -20px; }
  .summary .box { display: inline-block; width: 13px; height: 13px; border: 1.5px solid #9aa5b1; border-radius: 3px; margin-right: 8px; vertical-align: -1px; font-size: 10px; line-height: 10px; text-align: center; color: var(--green); }
  .summary li.done { color: var(--muted); text-decoration: line-through; }
  .ts { font: 11px ui-monospace, monospace; color: var(--accent); }
  code { font: 13px ui-monospace, monospace; background: #f3f5f7; padding: 1px 4px; border-radius: 3px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 0; vertical-align: top; border-bottom: 1px solid #f0f2f5; }
  td.t { width: 64px; font: 12px ui-monospace, monospace; color: var(--muted); padding-top: 7px; }
  .spk { font: 600 10px ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; margin-right: 8px; }
  .spk.you { background: #e2f3f7; color: var(--accent); }
  .spk.app { background: #fbe6f0; color: var(--app); }
  footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
  @media print {
    main { padding: 0; max-width: none; }
    tr { break-inside: avoid; }
    section > h2.section { break-after: avoid; }
  }
</style>
</head>
<body>
<main>
  <div class="brand">NULL<b>//</b>SCRIBE</div>
  <h1>${escapeHtml(meta.title)}</h1>
  <div class="meta">${metaLines(meta).map((l) => `<span>${escapeHtml(l)}</span>`).join('')}</div>
  <section class="summary">
    <h2 class="section">Summary</h2>
    ${renderMarkdown(summary || 'No summary.')}
  </section>
  <section>
    <h2 class="section">Transcript</h2>
    <table>${rows}</table>
  </section>
  <footer>Transcribed and summarized on-device with Null Scribe. <span style="color:var(--pink)">Your data.</span> <span style="color:var(--accent)">Your grid.</span></footer>
</main>
</body>
</html>
`;
}

module.exports = { AUDIO_FORMATS, TRANSCRIPT_FORMATS, exportAudio, buildText, buildHtml, markdownToText };
