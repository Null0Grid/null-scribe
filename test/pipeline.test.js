'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { chunkSegments, formatTimestamp, segmentsToText } = require('../src/pipeline/chunk');
const { parseWhisperJson, transcribe } = require('../src/pipeline/transcribe');
const { summarize, ollamaChat, listOllamaModels, cleanReply } = require('../src/pipeline/summarize');
const { buildDocument, claudeClipboardText, slugify } = require('../src/pipeline/markdown');
const { toWav, parseDuration } = require('../src/pipeline/audio');
const { runPipeline } = require('../src/pipeline');
const { createSessionStore } = require('../src/main/sessions');
const { createSettingsStore } = require('../src/main/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-test-'));
const seg = (start, text) => ({ start, end: start + 1000, text });

test('formatTimestamp', () => {
  assert.strictEqual(formatTimestamp(0), '00:00');
  assert.strictEqual(formatTimestamp(65_400), '01:05');
  assert.strictEqual(formatTimestamp(3_725_000), '1:02:05');
});

test('chunkSegments keeps segments whole and respects budget', () => {
  const segs = Array.from({ length: 50 }, (_, i) => seg(i * 1000, 'x'.repeat(100)));
  const chunks = chunkSegments(segs, 600);
  assert.ok(chunks.length > 1);
  assert.strictEqual(chunks.flat().length, 50);
  for (const c of chunks) assert.ok(segmentsToText(c).length <= 600 + 112);
  assert.strictEqual(chunkSegments([seg(0, 'y'.repeat(5000))], 600).length, 1);
});

test('parseWhisperJson reads offsets and drops silence markers', () => {
  const json = {
    transcription: [
      { offsets: { from: 0, to: 2400 }, text: ' Hello there.' },
      { offsets: { from: 2400, to: 3000 }, text: ' [BLANK_AUDIO]' },
      { offsets: { from: 3000, to: 4000 }, text: ' (music)' },
      { offsets: { from: 4000, to: 6000 }, text: ' Ship it Friday.' },
    ],
  };
  assert.deepStrictEqual(parseWhisperJson(json), [
    { start: 0, end: 2400, text: 'Hello there.' },
    { start: 4000, end: 6000, text: 'Ship it Friday.' },
  ]);
});

test('cleanReply strips fences and think blocks', () => {
  assert.strictEqual(cleanReply('```markdown\n## Overview\nHi\n```'), '## Overview\nHi');
  assert.strictEqual(cleanReply('<think>hmm</think>\n## Overview'), '## Overview');
});

test('summarize: single pass for short transcripts', async () => {
  const calls = [];
  const chat = async ({ messages }) => {
    calls.push(messages);
    return '## Overview\nShort talk.';
  };
  const out = await summarize({ segments: [seg(0, 'hi'), seg(1000, 'bye')], chat });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0][1].content, /\[00:00\] hi/);
  assert.strictEqual(out, '## Overview\nShort talk.');
});

test('summarize: map-reduce for long transcripts', async () => {
  const segs = Array.from({ length: 40 }, (_, i) => seg(i * 30_000, `sentence number ${i} `.repeat(10)));
  const prompts = [];
  const progress = [];
  const chat = async ({ messages }) => {
    prompts.push(messages[1].content);
    return prompts.length <= 4 ? `- note ${prompts.length}` : '## Overview\nMerged.';
  };
  const out = await summarize({ segments: segs, chunkChars: 2500, chat, onProgress: (p) => progress.push(p) });
  const nChunks = chunkSegments(segs, 2500).length;
  assert.strictEqual(prompts.length, nChunks + 1);
  assert.match(prompts.at(-1), /### Part 1/);
  assert.strictEqual(out, '## Overview\nMerged.');
  assert.strictEqual(progress.at(-1), 1);
});

test('summarize: empty transcript needs no model', async () => {
  const out = await summarize({ segments: [], chat: () => assert.fail('should not call') });
  assert.match(out, /No speech/);
});

test('ollamaChat + listOllamaModels against a fake Ollama server', async () => {
  let body;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }));
      if (req.url === '/api/chat') {
        body = JSON.parse(raw);
        return res.end(JSON.stringify({ message: { role: 'assistant', content: '## Overview\nOK' } }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}/`;
  try {
    assert.deepStrictEqual(await listOllamaModels(host), ['qwen2.5:7b']);
    const reply = await ollamaChat({ host, model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(reply, '## Overview\nOK');
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.model, 'qwen2.5:7b');
  } finally {
    server.close();
  }
  await assert.rejects(ollamaChat({ host: 'http://127.0.0.1:1', model: 'm', messages: [] }), /Could not reach Ollama/);
});

test('buildDocument and clipboard text', () => {
  const doc = buildDocument({
    title: 'Rack "planning"',
    createdAt: '2026-10-20T12:00:00.000Z',
    durationMs: 125_000,
    sourceName: 'a.m4a',
    summary: '## Overview\nTalked racks.',
    segments: [seg(0, 'hello')],
  });
  assert.match(doc, /^---\ntitle: "Rack \\"planning\\""/);
  assert.match(doc, /duration: 02:05/);
  assert.match(doc, /## Transcript\n\n\[00:00\] hello/);
  const clip = claudeClipboardText({ title: 'T', summary: 'S', segments: [seg(0, 'hello')] });
  assert.match(clip, /=== SUMMARY ===\nS/);
  assert.strictEqual(slugify('Café Plans: Q4!!'), 'cafe-plans-q4');
});

test('session and settings stores', () => {
  const dir = tmp();
  const store = createSessionStore(path.join(dir, 'sessions'));
  const meta = store.create({ title: 'One', source: 'x.wav' });
  store.update(meta.id, { status: 'done', durationMs: 5 });
  assert.strictEqual(store.list()[0].status, 'done');
  assert.throws(() => store.get('../etc'), /Invalid session id/);
  const m2 = store.create({ title: 'Two', source: 'y.wav' });
  store.recoverInterrupted();
  assert.strictEqual(store.get(m2.id).meta.status, 'error');
  store.remove(meta.id);
  assert.strictEqual(store.list().length, 1);

  const settings = createSettingsStore(dir);
  assert.strictEqual(settings.get().whisperModel, 'base.en');
  settings.set({ ollamaModel: 'llama3.1:8b', chunkChars: 10, bogus: 1 });
  assert.strictEqual(createSettingsStore(dir).get().ollamaModel, 'llama3.1:8b');
  assert.strictEqual(settings.get().chunkChars, 1500);
  assert.ok(!('bogus' in settings.get()));
});

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
})();

test('toWav converts real audio to 16 kHz mono', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmp();
  const src = path.join(dir, 'tone.mp3');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ac', '2', '-ar', '44100', src], { stdio: 'ignore' });
  const out = path.join(dir, 'out.wav');
  const { durationMs } = await toWav(src, out, { ffmpeg: 'ffmpeg' });
  assert.ok(Math.abs(durationMs - 3000) < 150, `duration ${durationMs}`);
  const header = fs.readFileSync(out).subarray(0, 44);
  assert.strictEqual(header.readUInt16LE(22), 1); // channels
  assert.strictEqual(header.readUInt32LE(24), 16000); // sample rate
  assert.strictEqual(parseDuration('Duration: 01:02:03.50,'), 3_723_500);
});

test('end-to-end runPipeline with a fake whisper binary and fake Ollama', { skip: process.platform === 'win32' || !hasFfmpeg }, async () => {
  const dir = tmp();
  // A stand-in for whisper-cli: prints progress like the real one and writes the same JSON shape.
  const fakeWhisper = path.join(dir, 'whisper-cli');
  fs.writeFileSync(
    fakeWhisper,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const of = args[args.indexOf('-of') + 1];
for (const p of [0, 50, 100]) process.stderr.write('whisper_print_progress_callback: progress = ' + p + '%\\n');
require('fs').writeFileSync(of + '.json', JSON.stringify({ transcription: [
  { offsets: { from: 0, to: 1500 }, text: ' We should move the cluster to the new rack.' },
  { offsets: { from: 1500, to: 3000 }, text: ' Luke will order the PDU by Friday.' }
]}));
`
  );
  fs.chmodSync(fakeWhisper, 0o755);
  const modelsDir = path.join(dir, 'models');
  fs.mkdirSync(modelsDir);
  fs.writeFileSync(path.join(modelsDir, 'ggml-base.en.bin'), Buffer.alloc(1_000_001));

  const src = path.join(dir, 'talk.mp3');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=duration=3', src], { stdio: 'ignore' });

  const stages = [];
  const result = await runPipeline({
    inputPath: src,
    sessionDir: path.join(dir, 'session'),
    title: 'Rack move',
    createdAt: new Date().toISOString(),
    settings: { whisperModel: 'base.en', ollamaHost: 'x', ollamaModel: 'm', language: 'en' },
    binDir: dir,
    modelsDir,
    onStage: (s) => stages.push(s.stage),
    deps: {
      toWav: (i, o, opts) => toWav(i, o, { ...opts, ffmpeg: 'ffmpeg' }),
      prepareSummarizer: async () => async () => '## Action items\n- [ ] Luke — order the PDU (by Friday)',
    },
  });
  assert.strictEqual(result.segments.length, 2);
  assert.match(result.doc, /order the PDU/);
  assert.ok(fs.existsSync(path.join(dir, 'session', 'document.md')));
  assert.ok(fs.existsSync(path.join(dir, 'session', 'transcript.json')));
  assert.deepStrictEqual([...new Set(stages)], ['convert', 'model', 'transcribe', 'summarize', 'done']);
});

/* ---------- built-in 3B engine ---------- */

const { LocalLLM } = require('../src/pipeline/local-llm');
const { prepareSummarizer, engineLabel } = require('../src/pipeline/engine');

// Stand-in for llama-server: parses --port, answers /health (503 for the first poll, like a loading model)
// and the OpenAI-style /v1/chat/completions endpoint.
function writeFakeLlamaServer(dir) {
  const p = path.join(dir, 'llama-server');
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
const http = require('http');
const a = process.argv.slice(2);
const port = Number(a[a.indexOf('--port') + 1]);
const model = a[a.indexOf('-m') + 1];
let polls = 0;
http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    if (req.url === '/health') { res.statusCode = polls++ < 1 ? 503 : 200; return res.end('{}'); }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ choices: [{ message: { content: '## Overview\\nfrom ' + require('path').basename(model) + ' (' + body.messages.length + ' msgs)' } }] }));
    }
    res.statusCode = 404; res.end();
  });
}).listen(port, '127.0.0.1');
`
  );
  fs.chmodSync(p, 0o755);
  return p;
}

test('LocalLLM starts llama-server, chats, reuses it, and stops', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  const llm = new LocalLLM({ bin: writeFakeLlamaServer(dir), idleMs: 0 });
  const model = path.join(dir, 'm.gguf');
  try {
    await llm.start(model);
    const firstPid = llm.proc.pid;
    const reply = await llm.chat({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] });
    assert.strictEqual(reply, '## Overview\nfrom m.gguf (2 msgs)');
    await llm.start(model); // same model → same process
    assert.strictEqual(llm.proc.pid, firstPid);
  } finally {
    llm.stop();
  }
  assert.strictEqual(llm.proc, null);
  await assert.rejects(llm.chat({ messages: [] }), /not running/);
});

test('LocalLLM reports a missing binary and a crashing server', async () => {
  await assert.rejects(new LocalLLM({ bin: null }).start('x'), /build:engines/);
  if (process.platform === 'win32') return;
  const dir = tmp();
  const bad = path.join(dir, 'llama-server');
  fs.writeFileSync(bad, '#!/bin/sh\necho "error: failed to load model" >&2\nexit 1\n');
  fs.chmodSync(bad, 0o755);
  await assert.rejects(new LocalLLM({ bin: bad }).start('x'), /failed to start: .*failed to load model/);
});

test('prepareSummarizer: builtin engine downloads then starts; ollama engine skips both', async () => {
  const calls = [];
  const fakeLlm = { start: async (f) => calls.push(['start', f]), chat: async () => 'local reply' };
  const status = [];
  const chat = await prepareSummarizer({
    settings: { summaryEngine: 'builtin', builtinModel: 'llama3.2-3b' },
    modelsDir: '/models',
    llm: fakeLlm,
    onStatus: (_p, m) => status.push(m),
    deps: { ensureLlmModel: async (name) => (calls.push(['download', name]), `/models/${name}.gguf`) },
  });
  assert.deepStrictEqual(calls, [['download', 'llama3.2-3b'], ['start', '/models/llama3.2-3b.gguf']]);
  assert.strictEqual(await chat({ messages: [] }), 'local reply');
  assert.ok(status.includes('Loading summary model'));
  assert.strictEqual(engineLabel({ summaryEngine: 'builtin', builtinModel: 'qwen2.5-3b' }), 'Qwen 2.5 3B');

  const ollama = await prepareSummarizer({ settings: { summaryEngine: 'ollama', ollamaHost: 'http://127.0.0.1:1', ollamaModel: 'x' }, llm: fakeLlm });
  assert.strictEqual(calls.length, 2);
  await assert.rejects(ollama({ messages: [] }), /Could not reach Ollama/);
});

test('settings default to the built-in engine and reject bad values', () => {
  const s = createSettingsStore(tmp());
  assert.strictEqual(s.get().summaryEngine, 'builtin');
  assert.strictEqual(s.get().builtinModel, 'llama3.2-3b');
  assert.strictEqual(s.set({ summaryEngine: 'nope' }).summaryEngine, 'builtin');
  assert.strictEqual(s.set({ summaryEngine: 'ollama' }).summaryEngine, 'ollama');
});

test('transcribe reports a missing binary clearly', async () => {
  await assert.rejects(transcribe({ bin: null, model: 'm', wav: 'w' }), /build:engines/);
});

/* ---------- first-run setup ---------- */

const setupMod = require('../src/main/setup');

test('setup: lists what is missing and downloads it in order', async () => {
  const dir = tmp();
  const cfg = { whisperModel: 'base.en', summaryEngine: 'builtin', builtinModel: 'llama3.2-3b' };
  let st = await setupMod.status(cfg, dir, { 'whisper-cli': '/x', 'llama-server': '/y' });
  assert.strictEqual(st.ready, false);
  assert.deepStrictEqual(st.items.map((i) => i.kind), ['whisper', 'llm']);
  assert.strictEqual(st.neededMb, 142 + 2020);

  const order = [];
  const events = [];
  await setupMod.downloadMissing(cfg, dir, {
    onProgress: (e) => events.push(e),
    deps: {
      ensureModel: async (name, d) => { order.push(name); fs.writeFileSync(path.join(d, `ggml-${name}.bin`), Buffer.alloc(1_000_001)); },
      ensureLlmModel: async (name, d, o) => { order.push(name); o.onProgress(0.5); fs.writeFileSync(path.join(d, 'Llama-3.2-3B-Instruct-Q4_K_M.gguf'), ''); },
    },
  });
  assert.deepStrictEqual(order, ['base.en', 'llama3.2-3b']);
  assert.ok(events.some((e) => e.id === 'llm:llama3.2-3b' && e.progress === 0.5));

  // Ollama engine only needs the speech model; missing engine binaries block readiness.
  st = await setupMod.status({ ...cfg, summaryEngine: 'ollama' }, dir, { 'whisper-cli': '/x', 'llama-server': null });
  assert.deepStrictEqual(st.items.map((i) => i.kind), ['whisper']);
  assert.deepStrictEqual(st.missingEngines, ['llama-server']);
  assert.strictEqual(st.ready, false);
});

/* ---------- Meeting mode ---------- */

const { mergeTracks, isEcho, similarity } = require('../src/pipeline/speakers');
const pwMod = require('../src/capture/pipewire');
const winMod = require('../src/capture/windows');
const { groupBySpeaker } = require('../src/pipeline');

test('mergeTracks interleaves You and app tracks by time and drops mic echo', () => {
  const you = [
    { start: 0, end: 2000, text: 'Hi everyone, thanks for joining.' },
    { start: 5200, end: 7000, text: 'we should ship the beta friday' }, // echo of Them
    { start: 9000, end: 11000, text: 'I can send the deck tonight.' },
  ];
  const them = [
    { start: 2500, end: 4500, text: 'No problem, glad to be here.' },
    { start: 5000, end: 7000, text: 'We should ship the beta on Friday.' },
  ];
  const { segments, droppedEcho } = mergeTracks([
    { speaker: 'You', segments: you },
    { speaker: 'Discord', segments: them },
    { speaker: 'Zoom', segments: [{ start: 12000, end: 13000, text: 'Zoom side checking in.' }] },
  ]);
  assert.strictEqual(droppedEcho, 1);
  assert.deepStrictEqual(segments.map((s) => s.speaker), ['You', 'Discord', 'Discord', 'You', 'Zoom']);
  assert.match(segmentsToText(segments), /\[00:02\] Discord: No problem/);
  assert.ok(isEcho({ start: 5000, end: 6500, text: 'ship the beta friday' }, them)); // fragment of the app line
  // A genuine reply that shares words with the question must be kept.
  assert.strictEqual(isEcho({ start: 0, end: 1500, text: 'Yeah, I can hear you fine.' }, [{ start: 0, end: 1500, text: 'Hey, can you hear me okay?' }]), false);
  assert.ok(similarity('a b', 'c d') === 0);
  assert.strictEqual(isEcho({ start: 20000, end: 21000, text: 'ship the beta friday' }, them), false); // too far apart
});

test('groupBySpeaker merges files per speaker, mic first', () => {
  const g = groupBySpeaker([
    { path: 'a', speaker: 'Discord' },
    { path: 'b', speaker: 'You' },
    { path: 'c', speaker: 'Discord' },
    { path: 'd', speaker: 'Zoom' },
  ]);
  assert.deepStrictEqual(g, [
    { speaker: 'You', files: ['b'] },
    { speaker: 'Discord', files: ['a', 'c'] },
    { speaker: 'Zoom', files: ['d'] },
  ]);
});

test('PipeWire graph parsing and link planning', () => {
  const objs = [
    { id: 10, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Stream/Output/Audio', 'application.name': 'ZOOM VoiceEngine', 'application.process.binary': 'zoom' } } },
    { id: 11, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Stream/Output/Audio', 'application.name': 'Spotify' } } },
    { id: 12, type: 'PipeWire:Interface:Node', info: { props: { 'media.class': 'Stream/Input/Audio', 'node.name': 'null-scribe-tap-1' } } },
    { id: 20, type: 'PipeWire:Interface:Port', info: { direction: 'output', props: { 'node.id': 10, 'audio.channel': 'FL' } } },
    { id: 21, type: 'PipeWire:Interface:Port', info: { direction: 'output', props: { 'node.id': 10, 'audio.channel': 'FR' } } },
    { id: 22, type: 'PipeWire:Interface:Port', info: { direction: 'output', props: { 'node.id': 11, 'audio.channel': 'MONO' } } },
  ];
  const g = pwMod.parseGraph(objs);
  assert.deepStrictEqual(g.streams.map((s) => s.key), ['zoom', 'spotify']);
  const tapIn = [{ id: 30, channel: 'FL' }, { id: 31, channel: 'FR' }];
  assert.deepStrictEqual(pwMod.planLinks(g.ports.filter((p) => p.nodeId === 10), tapIn), [[20, 30], [21, 31]]);
  assert.deepStrictEqual(pwMod.planLinks(g.ports.filter((p) => p.nodeId === 11), tapIn), [[22, 30], [22, 31]]); // mono → both
});

test('Windows session grouping', () => {
  const groups = winMod.groupSessions(
    [
      { pid: 100, exe: 'Zoom.exe', active: true },
      { pid: 101, exe: 'Zoom.exe', active: false },
      { pid: 200, exe: 'Spotify.exe', active: true },
      { pid: 300, exe: 'Null Scribe.exe', active: true },
    ],
    [999]
  );
  assert.deepStrictEqual(
    groups.map((g) => [g.id, g.name, g.pids, g.active]),
    [
      ['spotify', 'Spotify', [200], true],
      ['zoom', 'Zoom', [100, 101], true],
    ]
  );
});

test('runPipeline with meeting tracks labels speakers and skips silent tracks', { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const you = path.join(dir, 'you.wav');
  const them = path.join(dir, 'them.wav');
  const silent = path.join(dir, 'app-2.wav');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=700:duration=2', '-ac', '1', '-ar', '48000', you], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-ar', '48000', them], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2', silent], { stdio: 'ignore' });

  const transcribed = [];
  let systemPrompt = '';
  const result = await runPipeline({
    tracks: [
      { path: them, speaker: 'Discord' },
      { path: silent, speaker: 'Discord' },
      { path: you, speaker: 'You' },
    ],
    sessionDir: path.join(dir, 's'),
    title: 'Standup',
    createdAt: new Date().toISOString(),
    sourceName: 'Meeting: Zoom',
    settings: { whisperModel: 'base.en', language: 'en' },
    modelsDir: dir,
    deps: {
      toWav: (i, o, opts) => toWav(i, o, { ...opts, ffmpeg: 'ffmpeg' }),
      mixToWav: (i, o, opts) => require('../src/pipeline/audio').mixToWav(i, o, { ...opts, ffmpeg: 'ffmpeg' }),
      maxVolumeDb: (f, opts) => require('../src/pipeline/audio').maxVolumeDb(f, { ...opts, ffmpeg: 'ffmpeg' }),
      ensureModel: async () => 'model.bin',
      whisperBin: 'fake',
      transcribe: async ({ wav }) => {
        transcribed.push(path.basename(wav));
        return wav.includes('you') ? [{ start: 0, end: 900, text: 'Morning all.' }] : [{ start: 1000, end: 1900, text: 'Morning, ready when you are.' }];
      },
      prepareSummarizer: async () => async ({ messages }) => ((systemPrompt = messages[0].content), '## Overview\nStandup.'),
    },
  });
  assert.deepStrictEqual(transcribed, ['track-you.wav', 'track-discord.wav']);
  assert.deepStrictEqual(result.segments.map((s) => s.speaker), ['You', 'Discord']);
  assert.match(result.doc, /\[00:00\] You: Morning all\.\n\[00:01\] Discord: Morning/);
  assert.match(systemPrompt, /name\s+of the app/);
  assert.ok(fs.existsSync(path.join(dir, 's', 'audio.wav')));
  assert.match(result.doc, /source: "Meeting: Zoom"/);
});

/* ---------- live transcript ---------- */

const { LiveTranscriber, readWavLayout, peakOf } = require('../src/main/live');

function pcmTone(seconds, freq, rate = 48000, channels = 1, amp = 0.3) {
  const frames = Math.round(seconds * rate);
  const buf = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = freq ? Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767) : 0;
    for (let c = 0; c < channels; c++) buf.writeInt16LE(v, (i * channels + c) * 2);
  }
  return buf;
}

function growingWav(file, channels) {
  // Header with data size 0, like a recorder that hasn't closed the file yet.
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(0, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(48000, 24); h.writeUInt32LE(48000 * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(0, 40);
  fs.writeFileSync(file, h);
  return (buf) => fs.appendFileSync(file, buf);
}

test('LiveTranscriber transcribes new audio per track, offsets it, skips silence, filters echo', async () => {
  const dir = tmp();
  const youWav = path.join(dir, 'you.wav');
  const appWav = path.join(dir, 'app-discord.wav');
  const addYou = growingWav(youWav, 1);
  const addApp = growingWav(appWav, 2);
  assert.deepStrictEqual(readWavLayout(youWav), { format: 1, channels: 1, rate: 48000, blockAlign: 2, bits: 16, dataOffset: 44 });

  const calls = [];
  const got = [];
  const live = new LiveTranscriber({
    getTracks: () => [{ path: appWav, speaker: 'Discord' }, { path: youWav, speaker: 'You' }],
    whisperBin: 'w', model: 'm', workDir: path.join(dir, 'live'),
    onSegments: (s) => got.push(...s),
    deps: {
      toWav: async (i, o) => fs.copyFileSync(i, o),
      transcribe: async ({ wav }) => {
        calls.push(path.basename(wav));
        return wav.includes('app-discord') ? [{ start: 500, end: 1500, text: 'Can you hear me okay?' }] : [{ start: 600, end: 1400, text: 'can you hear me okay' }];
      },
    },
  });

  addApp(pcmTone(7, 300, 48000, 2)); // 7 s of Discord audio
  addYou(pcmTone(7, 0)); // 7 s of silence on the mic
  await live.tick();
  assert.deepStrictEqual(calls, ['app-discord-0.wav']); // mic chunk was silent → skipped
  assert.deepStrictEqual(got, [{ start: 500, end: 1500, text: 'Can you hear me okay?', speaker: 'Discord' }]);

  // Next 7 s: Discord says the same line again at 7.5 s, and the mic picks it up from the speakers.
  addApp(pcmTone(7, 300, 48000, 2));
  addYou(pcmTone(7, 700));
  await live.tick();
  assert.deepStrictEqual(calls, ['app-discord-0.wav', 'app-discord-336000.wav', 'you-336000.wav']);
  assert.deepStrictEqual(got.map((g) => [g.speaker, g.start]), [['Discord', 500], ['Discord', 7500]], 'echoed mic line must be filtered');

  // Only 3 s more: below the 6 s minimum, so nothing runs yet.
  addApp(pcmTone(3, 300, 48000, 2));
  await live.tick();
  assert.strictEqual(calls.length, 3);
  assert.ok(peakOf(pcmTone(0.1, 440)) > 0.25 && peakOf(pcmTone(0.1, 0)) === 0);
  live.stop();
});

/* ---------- downloads ---------- */

const exporter = require('../src/pipeline/export');

const sampleDoc = {
  meta: { title: 'Budget <Review>', createdAt: '2026-10-20T13:00:00.000Z', durationMs: 95_000, source: 'Meeting: Discord' },
  summary: '## Overview\nTalked **Q4** budget.\n\n## Action items\n- [ ] You — send spreadsheet\n- [x] Discord participants — confirm date',
  segments: [
    { start: 0, end: 2000, text: 'Is the deadline Thursday?', speaker: 'You' },
    { start: 2500, end: 4000, text: 'Yes, Thursday end of day.', speaker: 'Discord' },
  ],
};

test('text export is clean plain text', () => {
  const txt = exporter.buildText(sampleDoc);
  assert.match(txt, /^Budget <Review>\n=+\nDate: /);
  assert.match(txt, /\nOVERVIEW\nTalked Q4 budget\./);
  assert.match(txt, /  \[ \] You — send spreadsheet\n  \[x\] Discord participants/);
  assert.match(txt, /\[00:02\] Discord: Yes, Thursday end of day\./);
  assert.doesNotMatch(txt, /\*\*|##/);
});

test('html export is standalone and escapes content', () => {
  const html = exporter.buildHtml(sampleDoc);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Budget &lt;Review&gt;<\/title>/);
  assert.match(html, /<strong>Q4<\/strong>/);
  assert.match(html, /<span class="spk app">Discord<\/span>Yes, Thursday/);
  assert.doesNotMatch(html, /<script|https?:\/\/(?!www\.w3)/); // no scripts, no external resources
});

test('audio export produces all five formats with the right codecs', { skip: !hasFfmpeg }, async () => {
  const dir = tmp();
  const src = path.join(dir, 'master.flac');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ar', '48000', '-ac', '2', '-c:a', 'flac', src], { stdio: 'ignore' });
  const expected = { mp3: 'mp3', m4a: 'aac', wav: 'pcm_s16le', flac: 'flac', ogg: 'vorbis' };
  for (const [fmt, codec] of Object.entries(expected)) {
    const out = path.join(dir, `out.${exporter.AUDIO_FORMATS[fmt].ext}`);
    await exporter.exportAudio(src, out, fmt, { title: 'Budget Review', ffmpeg: 'ffmpeg' });
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', out]).toString());
    assert.strictEqual(probe.streams[0].codec_name, codec, fmt);
    assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.15, `${fmt} duration ${probe.format.duration}`);
    const title = probe.format.tags?.title || probe.format.tags?.TITLE || probe.streams[0].tags?.title || probe.streams[0].tags?.TITLE;
    if (fmt !== 'wav') assert.strictEqual(title, 'Budget Review', `${fmt} title tag`);
  }
});

/* ---------- transcript cleanup ---------- */

const { cleanText, cleanSegments } = require('../src/pipeline/cleanup');

test('cleanup removes fillers, stutters and stage directions but keeps meaning', () => {
  assert.strictEqual(cleanText("So, um, we're — we're about twelve percent over."), "So we're about twelve percent over.");
  assert.strictEqual(cleanText("What's the — what's the big number looking like?"), "What's the big number looking like?");
  assert.strictEqual(cleanText("And then there's, uh, the contractor hours."), "And then there's the contractor hours.");
  assert.strictEqual(cleanText('*[laughs]* Good.'), 'Good.');
  assert.strictEqual(cleanText('defend. Um, what about next quarter?'), 'Defend. What about next quarter?');
  // Self-corrections and real words stay.
  assert.strictEqual(cleanText('By Friday, I think? Or, no, Thursday.'), 'By Friday, I think? Or, no, Thursday.');
  assert.strictEqual(cleanText('I know, I know, I\'m kidding.'), "I know, I know, I'm kidding.");
  assert.deepStrictEqual(cleanSegments([{ start: 0, end: 1, text: 'Um, uh.' }, { start: 1, end: 2, text: 'Okay.' }]).map((s) => s.text), ['Okay.']);
});

/* ---------- Null Notes + Null Drive integrations ---------- */

const notesInt = require('../src/integrations/notes');
const driveInt = require('../src/integrations/drive');

test('Null Notes: vault detection from Null Notes settings.json', () => {
  const home = tmp();
  const cfgDir = path.join(home, '.config', 'dev.nullgrid.notes');
  const v1 = path.join(home, 'Homelab Vault');
  const v2 = path.join(home, 'Work');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(v1);
  fs.mkdirSync(v2);
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ last: v1, recent: [v1, v2, path.join(home, 'deleted-vault')] }));
  const vaults = notesInt.detectVaults({ env: {}, platform: 'linux', home });
  assert.deepStrictEqual(vaults.map((v) => v.name), ['Homelab Vault', 'Work']); // missing vault skipped, no duplicates
  // Store (MSIX) installs keep settings under the package folder on Windows.
  const c = notesInt.notesSettingsCandidates({ APPDATA: 'C:\\Users\\l\\AppData\\Roaming' }, 'win32', 'C:\\Users\\l');
  assert.match(c[0], /dev\.nullgrid\.notes[\\/]settings\.json$/);
});

test('Null Notes: note gets a Null Notes id in frontmatter and never overwrites', () => {
  const vault = tmp();
  const md = '---\ntitle: "Q4 Budget"\napp: null-scribe\n---\n\n# Q4 Budget\n\nBody';
  const a = notesInt.sendToNotes({ vault, title: 'Q4 Budget: Review?', createdAt: '2026-10-20T13:30:00Z', markdown: md });
  const b = notesInt.sendToNotes({ vault, title: 'Q4 Budget: Review?', createdAt: '2026-10-20T13:30:00Z', markdown: md });
  assert.strictEqual(path.relative(vault, a.file), path.join('Scribe', '2026-10-20 Q4 Budget Review.md'));
  assert.strictEqual(path.basename(b.file), '2026-10-20 Q4 Budget Review (2).md');
  assert.notStrictEqual(a.id, b.id);
  const text = fs.readFileSync(a.file, 'utf8');
  // Same shape Null Notes writes: "---\nid: <uuid>\n" as the first frontmatter line.
  assert.match(text, /^---\nid: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\ntitle: "Q4 Budget"\n/);
  assert.strictEqual(a.link, `nullnotes://open?id=${a.id}`);
  assert.ok(!fs.readdirSync(path.join(vault, 'Scribe')).some((f) => f.endsWith('.tmp')));
  assert.strictEqual(notesInt.withNoteId('# no frontmatter', 'x'), '---\nid: x\n---\n# no frontmatter');
  assert.throws(() => notesInt.sendToNotes({ vault: path.join(vault, 'nope'), title: 't', createdAt: '2026', markdown: '' }), /not found/);
});

/** Mock Null Drive following docs/API.md: Bearer auth, /api/v1/me, PUT /files/{path} with If-Match / X-Content-SHA256. */
async function mockDrive({ e2ee = 'off' } = {}) {
  const files = new Map(); // path -> { sha, data, version }
  let version = 0;
  const tokens = { full: 'tok-full', search: 'tok-search' };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!req.url.startsWith('/api/v1/')) return send(404, { error: { code: 'not_found', message: 'no' } });
      if (auth !== tokens.full && auth !== tokens.search) return send(401, { error: { code: 'unauthorized', message: 'bad token' } });
      if (req.method === 'GET' && req.url === '/api/v1/me') {
        return send(200, { user: { id: 1, username: 'luke', e2ee }, device: { name: auth === tokens.full ? 'Null Scribe' : 'Null Search' } });
      }
      if (req.url.startsWith('/api/v1/files/') && req.method === 'PUT') {
        if (auth === tokens.search) return send(403, { error: { code: 'forbidden', message: 'search-only token' } });
        if (e2ee !== 'off') return send(409, { error: { code: 'e2ee_client_required', message: 'encrypted account' } });
        const p = decodeURIComponent(req.url.slice('/api/v1/files/'.length));
        const body = Buffer.concat(chunks);
        const sha = require('crypto').createHash('sha256').update(body).digest('hex');
        if (req.headers['x-content-sha256'] && req.headers['x-content-sha256'] !== sha) return send(400, { error: { code: 'hash_mismatch', message: 'hash' } });
        const cur = files.get(p);
        const ifMatch = req.headers['if-match'];
        if (cur && cur.sha === sha) return send(200, { path: p, size: body.length, sha256: sha, version: cur.version });
        if (cur && ifMatch === undefined) return send(428, { error: { code: 'precondition_required', message: 'need If-Match' } });
        if (cur && String(ifMatch).replace(/"/g, '') !== String(cur.version)) return send(409, { error: { code: 'conflict', message: `current version is ${cur.version}`, current: { path: p, version: cur.version } } });
        files.set(p, { sha, data: body, version: ++version });
        return send(cur ? 200 : 201, { path: p, size: body.length, sha256: sha, version });
      }
      send(404, { error: { code: 'not_found', message: 'no route' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, files, tokens, address: `127.0.0.1:${server.address().port}` };
}

test('Null Drive: check, upload without overwriting, and clear errors', async () => {
  const d = await mockDrive();
  try {
    const info = await driveInt.checkDrive({ address: d.address, token: d.tokens.full });
    assert.deepStrictEqual([info.username, info.device, info.e2ee], ['luke', 'Null Scribe', 'off']);
    assert.strictEqual(info.base, `http://${d.address}`); // scheme added

    const files = [
      { name: '2026-10-20 Q4 Budget Review.md', data: Buffer.from('# Q4\nfirst') },
      { name: '2026-10-20 Q4 Budget Review.pdf', data: Buffer.from('%PDF-1.4 fake') },
    ];
    const r1 = await driveInt.uploadToDrive({ address: `http://${d.address}/`, token: d.tokens.full, folder: 'Null Scribe', files });
    assert.deepStrictEqual(r1.uploaded.map((u) => u.path), ['Null Scribe/2026-10-20 Q4 Budget Review.md', 'Null Scribe/2026-10-20 Q4 Budget Review.pdf']);

    // Same name, different content → never overwrite; goes to "(2)".
    const r2 = await driveInt.uploadToDrive({ address: d.address, token: d.tokens.full, files: [{ name: '2026-10-20 Q4 Budget Review.md', data: Buffer.from('# Q4\nsecond') }] });
    assert.strictEqual(r2.uploaded[0].path, 'Null Scribe/2026-10-20 Q4 Budget Review (2).md');
    assert.strictEqual(d.files.get('Null Scribe/2026-10-20 Q4 Budget Review.md').data.toString(), '# Q4\nfirst');

    // Same content again → idempotent (no duplicate file).
    const r3 = await driveInt.uploadToDrive({ address: d.address, token: d.tokens.full, files: [files[0]] });
    assert.strictEqual(r3.uploaded[0].path, 'Null Scribe/2026-10-20 Q4 Budget Review.md');
    assert.strictEqual(d.files.size, 3);

    await assert.rejects(driveInt.checkDrive({ address: d.address, token: 'wrong' }), (e) => e.code === 'unauthorized');
    await assert.rejects(driveInt.uploadToDrive({ address: d.address, token: d.tokens.search, files }), (e) => e.code === 'forbidden' && /only search/.test(e.message));
    await assert.rejects(driveInt.checkDrive({ address: '', token: 'x' }), (e) => e.code === 'no_address');
  } finally {
    d.server.close();
  }
  await assert.rejects(driveInt.checkDrive({ address: '127.0.0.1:1', token: 'x' }), (e) => e.code === 'unreachable');
});

test('Null Drive: encrypted accounts are detected before uploading', async () => {
  const d = await mockDrive({ e2ee: 'on' });
  try {
    const info = await driveInt.checkDrive({ address: d.address, token: d.tokens.full });
    assert.strictEqual(info.e2ee, 'on');
    await assert.rejects(
      driveInt.uploadToDrive({ address: d.address, token: d.tokens.full, files: [{ name: 'a.md', data: Buffer.from('x') }] }),
      (e) => e.code === 'e2ee' && /Null Notes/.test(e.message)
    );
    assert.strictEqual(d.files.size, 0);
  } finally {
    d.server.close();
  }
});
