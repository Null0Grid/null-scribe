'use strict';

// Speaker renaming, subtitles, custom words, summary templates and audio auto-delete.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { renameSpeaker, speakersOf } = require('../src/pipeline/speaker-names');
const { buildSrt, buildVtt, buildCues, cueTime, buildHtml } = require('../src/pipeline/export');
const { parseWords, whisperPrompt, summaryNote } = require('../src/pipeline/glossary');
const { listTemplates, resolveTemplate, cleanCustom, BUILTIN } = require('../src/pipeline/templates');
const { summarize } = require('../src/pipeline/summarize');
const { transcribe } = require('../src/pipeline/transcribe');
const { pruneAudio, normalizeDays } = require('../src/main/retention');
const { createSessionStore } = require('../src/main/sessions');
const { createSettingsStore } = require('../src/main/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-feat-'));

/* ---------- speaker renaming ---------- */

const meeting = () => [
  { start: 0, end: 2000, text: 'Thanks for hopping on.', speaker: 'You' },
  { start: 2000, end: 4000, text: 'No problem, Discord is working fine.', speaker: 'Discord' },
  { start: 4000, end: 6000, text: 'You said Thursday?', speaker: 'You' },
];
const summary = [
  '## Overview',
  'You and the Discord participants went over the Q4 budget. You asked about Thursday.',
  '',
  '## Action items',
  '- [ ] Discord participants — send the spreadsheet by Wednesday',
  '- [ ] You — ask finance about the deadline',
  '- [x] You: book the room',
].join('\n');

test('rename an app speaker everywhere, including "Discord participants"', () => {
  const r = renameSpeaker({ segments: meeting(), rawSegments: meeting(), summary, from: 'Discord', to: 'Tom' });
  assert.deepStrictEqual(speakersOf(r.segments), ['You', 'Tom']);
  assert.strictEqual(r.segments[1].role, 'app');
  assert.strictEqual(r.rawSegments[1].speaker, 'Tom');
  // The words inside what people said are not touched.
  assert.strictEqual(r.segments[1].text, 'No problem, Discord is working fine.');
  assert.match(r.summary, /You and the Tom went over/);
  assert.match(r.summary, /- \[ \] Tom — send the spreadsheet/);
  assert.doesNotMatch(r.summary, /Discord/);
});

test('rename "You" only where it is used as a label, and keep its colour', () => {
  const r = renameSpeaker({ segments: meeting(), summary, from: 'You', to: 'Luke' });
  assert.deepStrictEqual(speakersOf(r.segments), ['Luke', 'Discord']);
  assert.strictEqual(r.segments[0].role, 'you');
  assert.match(r.summary, /- \[ \] Luke — ask finance/);
  assert.match(r.summary, /- \[x\] Luke: book the room/);
  // Ordinary prose "You" stays.
  assert.match(r.summary, /^You and the Discord participants/m);
  assert.match(r.summary, /You asked about Thursday/);
  // A second rename of the renamed speaker still finds it, and keeps role "you".
  const r2 = renameSpeaker({ segments: r.segments, summary: r.summary, from: 'Luke', to: 'Luke H' });
  assert.strictEqual(r2.segments[0].role, 'you');
  assert.match(r2.summary, /- \[ \] Luke H — ask finance/);
});

test('rename rejects empty, duplicate and unknown names', () => {
  assert.throws(() => renameSpeaker({ segments: meeting(), summary, from: 'Discord', to: '  ' }), /Enter a name/);
  assert.throws(() => renameSpeaker({ segments: meeting(), summary, from: 'Discord', to: 'You' }), /already used/);
  assert.throws(() => renameSpeaker({ segments: meeting(), summary, from: 'Zoom', to: 'Ann' }), /No speaker/);
  const same = renameSpeaker({ segments: meeting(), summary, from: 'Discord', to: 'Discord' });
  assert.strictEqual(same.summary, summary);
});

test('renamed speakers keep their colours in the HTML export', () => {
  const r = renameSpeaker({ segments: meeting(), summary, from: 'You', to: 'Luke' });
  const html = buildHtml({ meta: { title: 't', createdAt: new Date().toISOString() }, summary: r.summary, segments: r.segments });
  assert.match(html, /class="spk you">Luke</);
  assert.match(html, /class="spk app">Discord</);
});

/* ---------- subtitles ---------- */

test('SRT: numbered cues, comma times, speaker prefix, no raw tags', () => {
  const srt = buildSrt([
    { start: 1500, end: 4000, text: 'Hello <there>, everyone.', speaker: 'You' },
    { start: 65_250, end: 66_000, text: 'Hi.' },
  ]);
  const blocks = srt.trim().split(/\n\n/);
  assert.strictEqual(blocks.length, 2);
  assert.match(blocks[0], /^1\n00:00:01,500 --> 00:00:04,000\nYou: Hello ‹there›, everyone\.$/);
  assert.match(blocks[1], /^2\n00:01:05,250 --> 00:01:06,000\nHi\.$/);
});

test('WebVTT: header, dot times, voice tags, escaping', () => {
  const vtt = buildVtt([{ start: 0, end: 1200, text: 'A & B <ok>', speaker: 'Discord' }], { title: 'Q4 --> review' });
  assert.match(vtt, /^WEBVTT - Q4 → review\n\n/);
  assert.match(vtt, /00:00:00\.000 --> 00:00:01\.200\n<v Discord>A &amp; B &lt;ok&gt;\n/);
});

test('cues: long lines wrap, long segments split, short ones stay readable, no overlaps', () => {
  const long = 'word '.repeat(60).trim();
  const cues = buildCues([
    { start: 0, end: 20_000, text: long },
    { start: 19_000, end: 19_050, text: 'Ok.' },
  ]);
  assert.ok(cues.length > 2);
  for (const c of cues) {
    assert.ok(c.lines.length <= 2);
    for (const l of c.lines) assert.ok(l.length <= 42);
    assert.ok(c.end > c.start);
  }
  for (let i = 0; i < cues.length - 1; i++) assert.ok(cues[i].end <= cues[i + 1].start);
  assert.ok(cues.at(-1).end - cues.at(-1).start >= 700);
  assert.strictEqual(cueTime(3_723_004, ','), '01:02:03,004');
});

/* ---------- custom words ---------- */

test('custom words: parsed from commas/new lines, de-duplicated, capped prompt', () => {
  const words = parseWords('Proxmox, ZimaBoard\nNULLGRID;  proxmox ,, Tom Reyes\n');
  assert.deepStrictEqual(words, ['Proxmox', 'ZimaBoard', 'NULLGRID', 'Tom Reyes']);
  assert.strictEqual(whisperPrompt(words), 'Glossary: Proxmox, ZimaBoard, NULLGRID, Tom Reyes.');
  assert.strictEqual(whisperPrompt([]), '');
  const many = Array.from({ length: 100 }, (_, i) => `Term${i}`);
  assert.ok(whisperPrompt(many).length <= 600);
  assert.match(summaryNote(words), /Proxmox, ZimaBoard, NULLGRID, Tom Reyes/);
});

test('custom words reach whisper.cpp as --prompt', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  const bin = path.join(dir, 'whisper-cli');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify(a));
require('fs').writeFileSync(a[a.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: [{ offsets: { from: 0, to: 900 }, text: ' Proxmox.' }] }));
`
  );
  fs.chmodSync(bin, 0o755);
  const wav = path.join(dir, 'a.wav');
  fs.writeFileSync(wav, 'x');
  await transcribe({ bin, model: 'm', wav, prompt: 'Glossary: Proxmox.' });
  let args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
  assert.strictEqual(args[args.indexOf('--prompt') + 1], 'Glossary: Proxmox.');
  await transcribe({ bin, model: 'm', wav });
  args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
  assert.ok(!args.includes('--prompt'));
});

/* ---------- summary templates ---------- */

test('templates: built-ins plus custom ones; unknown ids fall back to Meeting', () => {
  const custom = [{ id: 'custom-abc', name: 'Homelab', instructions: '## Changes\nEvery change with the device name.' }];
  const all = listTemplates(custom);
  assert.deepStrictEqual(all.map((t) => t.id), ['meeting', 'lecture', 'interview', 'standup', 'one-on-one', 'custom-abc']);
  assert.strictEqual(resolveTemplate('lecture').name, 'Lecture / class');
  assert.match(resolveTemplate('lecture').format, /## Key concepts and definitions/);
  assert.match(resolveTemplate('custom-abc', custom).format, /Every change with the device name/);
  assert.strictEqual(resolveTemplate('nope', custom).id, 'meeting');
  assert.strictEqual(resolveTemplate(undefined).format, BUILTIN[0].format);
});

test('templates: bad custom entries are dropped or repaired', () => {
  const out = cleanCustom([
    { id: 'custom-1', name: 'Good', instructions: 'x' },
    { id: 'meeting', name: 'Clash', instructions: 'y' }, // can't reuse a built-in id
    { name: '', instructions: 'z' },
    { name: 'No text', instructions: '  ' },
    'junk',
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 'custom-1');
  assert.match(out[1].id, /^custom-/);
  assert.notStrictEqual(out[1].id, 'meeting');
});

test('summarize uses the chosen template and the custom-words note', async () => {
  const seen = [];
  const chat = async ({ messages }) => {
    seen.push(messages);
    return '## Main topics\n- Subnets';
  };
  await summarize({
    segments: [{ start: 0, end: 1000, text: 'Today: subnetting.' }],
    chat,
    format: resolveTemplate('lecture').format,
    glossaryNote: summaryNote(['VLAN', 'OPNsense']),
  });
  assert.match(seen[0][0].content, /spell them exactly like this.*VLAN, OPNsense/);
  assert.match(seen[0][1].content, /## Key concepts and definitions/);
  assert.doesNotMatch(seen[0][1].content, /## Decisions/);
});

test('settings: templates, custom words and retention are validated', () => {
  const dir = tmp();
  const s = createSettingsStore(dir);
  assert.strictEqual(s.get().summaryTemplate, 'meeting');
  assert.strictEqual(s.get().audioRetentionDays, 0);
  let next = s.set({
    customTemplates: [{ id: 'custom-x', name: 'Homelab', instructions: 'List changes.' }],
    summaryTemplate: 'custom-x',
    audioRetentionDays: '30',
    customWords: 'Proxmox',
  });
  assert.strictEqual(next.summaryTemplate, 'custom-x');
  assert.strictEqual(next.audioRetentionDays, 30);
  next = s.set({ summaryTemplate: 'deleted-one', audioRetentionDays: 45 });
  assert.strictEqual(next.summaryTemplate, 'meeting');
  assert.strictEqual(next.audioRetentionDays, 0);
  // Deleting the default custom template falls back to Meeting.
  s.set({ summaryTemplate: 'custom-x' });
  assert.strictEqual(s.set({ customTemplates: [] }).summaryTemplate, 'meeting');
});

/* ---------- audio auto-delete ---------- */

test('audio auto-delete: only old sessions, only audio files, marks the session', () => {
  const dir = tmp();
  const store = createSessionStore(dir);
  const now = Date.parse('2026-10-21T12:00:00Z');
  const mk = (daysAgo, status = 'done') => {
    const m = store.create({ title: `t${daysAgo}`, source: 'x' });
    store.update(m.id, { status, createdAt: new Date(now - daysAgo * 86400000).toISOString() });
    const d = store.dirOf(m.id);
    for (const f of ['audio.wav', 'master.flac', 'track-discord.wav', 'summary.md', 'document.md']) fs.writeFileSync(path.join(d, f), 'data');
    fs.writeFileSync(path.join(d, 'transcript.json'), '[]');
    return m.id;
  };
  const old = mk(40);
  const recent = mk(3);
  const processing = mk(60, 'processing');

  assert.deepStrictEqual(pruneAudio(store, 0, { now }), []); // Never
  const removed = pruneAudio(store, 30, { now });
  assert.deepStrictEqual(removed.map((r) => r.id), [old]);
  assert.strictEqual(removed[0].files, 3);

  const left = (id) => fs.readdirSync(store.dirOf(id)).sort();
  assert.deepStrictEqual(left(old), ['document.md', 'meta.json', 'summary.md', 'transcript.json']);
  assert.ok(store.get(old).meta.audioDeletedAt);
  assert.ok(left(recent).includes('audio.wav'));
  assert.ok(left(processing).includes('audio.wav'));
  assert.deepStrictEqual(pruneAudio(store, 30, { now }), []); // nothing left to do

  assert.strictEqual(pruneAudio(store, 1, { now }).length, 1); // the 3-day-old one
  assert.strictEqual(normalizeDays('180'), 180);
  assert.strictEqual(normalizeDays(2), 0);
});

/* ---------- Word and LibreOffice downloads ---------- */

const JSZip = require('jszip');
const { buildDocx, buildOdt, parseSummary } = require('../src/pipeline/office');
const { TRANSCRIPT_FORMATS } = require('../src/pipeline/export');

const officeDoc = () => ({
  meta: { title: 'Q4 <Budget> & Review', createdAt: '2026-10-20T13:30:00.000Z', durationMs: 98000, source: 'Meeting: Discord' },
  summary: '## Overview\nBudget is **12%** over.\n\n## Key points\n- Licenses [00:39]\n\n## Action items\n- [ ] Tom — send the spreadsheet\n- [x] You — book the room',
  segments: [
    { start: 0, end: 2000, text: 'Okay, are we recording?', speaker: 'Luke', role: 'you' },
    { start: 6000, end: 8000, text: 'Fine & awake \u0007<ok>', speaker: 'Tom', role: 'app' },
  ],
});

/** Small well-formedness check: every opened tag is closed in order (no XML parser in Node). */
function balanced(xml) {
  const stack = [];
  for (const m of xml.replace(/<\?[^>]*\?>/g, '').matchAll(/<(\/?)([a-zA-Z][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]);
  }
  return stack.length === 0;
}

test('download menu lists Word and LibreOffice documents', () => {
  assert.deepStrictEqual(TRANSCRIPT_FORMATS.docx, { label: 'Document (Microsoft Word)', ext: 'docx' });
  assert.deepStrictEqual(TRANSCRIPT_FORMATS.odt, { label: 'Document (LibreOffice)', ext: 'odt' });
});

test('summary Markdown becomes headings, bullets, tasks and timestamp runs', () => {
  const b = parseSummary(officeDoc().summary);
  assert.deepStrictEqual(b.map((x) => x.type), ['heading', 'para', 'heading', 'bullet', 'heading', 'task', 'task']);
  assert.deepStrictEqual(b[1].runs, [{ text: 'Budget is ' }, { text: '12%', bold: true }, { text: ' over.' }]);
  assert.ok(b[3].runs.some((r) => r.ts && r.text === '00:39'));
  assert.strictEqual(b[6].done, true);
});

test('.docx: Word document with headings, checkboxes and the transcript table', async () => {
  const buf = await buildDocx({ ...officeDoc(), letter: true });
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(balanced(xml));
  assert.match(xml, /Q4 &lt;Budget&gt; &amp; Review/);
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /w:pStyle w:val="Heading2"/);
  assert.match(xml, /☐/);
  assert.match(xml, /☑/);
  assert.match(xml, /<w:tbl>/);
  assert.match(xml, /Fine &amp; awake &lt;ok&gt;/); // control character dropped, rest escaped
  assert.doesNotMatch(xml, /\u0007/);
  assert.match(xml, /w:pgSz w:w="12240" w:h="15840"/); // Letter
  const a4 = await JSZip.loadAsync(await buildDocx({ ...officeDoc(), letter: false }));
  assert.match(await a4.file('word/document.xml').async('string'), /w:pgSz w:w="11906" w:h="16838"/);
  assert.match(await zip.file('docProps/core.xml').async('string'), /Null Scribe/);
});

test('.odt: valid OpenDocument package (mimetype first and stored) with the same content', async () => {
  const buf = await buildOdt({ ...officeDoc(), letter: false });
  // First local file header: name "mimetype", compression method 0 (stored).
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);
  assert.strictEqual(buf.readUInt16LE(8), 0);
  assert.strictEqual(buf.toString('latin1', 30, 38), 'mimetype');
  assert.strictEqual(buf.toString('latin1', 38, 38 + 39), 'application/vnd.oasis.opendocument.text');
  const zip = await JSZip.loadAsync(buf);
  for (const f of ['content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml']) assert.ok(balanced(await zip.file(f).async('string')), f);
  const content = await zip.file('content.xml').async('string');
  assert.match(content, /text:h text:style-name="Heading_20_1" text:outline-level="1">Summary/);
  assert.match(content, /text:outline-level="2">Action items/);
  assert.match(content, /☐/);
  assert.match(content, /<table:table table:name="Transcript"/);
  assert.match(content, /T_you">Luke</);
  assert.match(content, /T_app">Tom</);
  assert.match(content, /Fine &amp; awake &lt;ok&gt;/);
  assert.doesNotMatch(content, /\u0007/);
  assert.match(await zip.file('styles.xml').async('string'), /fo:page-width="21.0cm" fo:page-height="29.7cm"/);
});
