#!/usr/bin/env node
'use strict';
/**
 * Run a recording through the real Null Scribe pipeline (whisper.cpp + built-in Llama 3.2 3B)
 * and compare it with a reference transcript.
 *
 *   node scripts/test-recording.js examples/budget-meeting/budget_meeting.mp3 examples/budget-meeting/transcript.md
 *   npm run test:recording -- budget_meeting.mp3 transcript.md
 *
 * Writes test-report.md with: the reference script, the raw transcript, the cleaned transcript,
 * the AI summary, word accuracy, and which key facts made it into the summary.
 * Models are downloaded on first run into ./.test-models (or reused from there).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPipeline } = require('../src/pipeline');
const { LocalLLM, findLlamaServer } = require('../src/pipeline/local-llm');
const { segmentsToText } = require('../src/pipeline/chunk');
const { cleanText } = require('../src/pipeline/cleanup');

const [audio, reference] = process.argv.slice(2);
if (!audio) {
  console.error('usage: node scripts/test-recording.js <audio file> [reference transcript]');
  process.exit(64);
}

const ROOT = path.join(__dirname, '..');
const osDir = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const binDir = process.env.NULL_SCRIBE_BIN_DIR || path.join(ROOT, 'bin', osDir);
const modelsDir = process.env.NULL_SCRIBE_MODELS_DIR || path.join(ROOT, '.test-models');

/** Reference file → plain spoken words (drops markdown, speaker names, stage directions). */
function referenceWords(md) {
  return md
    .split('\n')
    .filter((l) => !/^#/.test(l))
    .map((l) => l.replace(/^\*\*[^*]+:\*\*\s*/, '').replace(/\*?\[[^\]]*\]\*?/g, ' '))
    .join(' ');
}

function words(text) {
  return String(text)
    .toLowerCase()
    .replace(/[—–-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate (substitutions + deletions + insertions) / reference words. */
function wer(refText, hypText) {
  const r = words(refText);
  const h = words(hypText);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return { wer: prev[h.length] / Math.max(1, r.length), refWords: r.length, hypWords: h.length };
}

/** Optional fact checklist + gold-standard summary that live next to the reference transcript. */
function loadExtras(referencePath) {
  if (!referencePath) return {};
  const dir = path.dirname(path.resolve(referencePath));
  const factsFile = path.join(dir, 'facts.js');
  const goldFile = path.join(dir, 'reference-summary.md');
  return {
    facts: fs.existsSync(factsFile) ? require(factsFile) : null,
    gold: fs.existsSync(goldFile) ? fs.readFileSync(goldFile, 'utf8').trim() : null,
  };
}

function checkFacts(facts, text) {
  return Object.entries(facts).map(([label, tests]) => ({ label, ok: tests.every((re) => re.test(text)) }));
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-test-'));
  const llm = new LocalLLM({ bin: findLlamaServer(binDir) });
  const settings = { whisperModel: 'base.en', language: 'en', summaryEngine: 'builtin', builtinModel: 'llama3.2-3b', chunkChars: 6000 };
  const t0 = Date.now();
  let lastLine = '';
  try {
    const result = await runPipeline({
      inputPath: path.resolve(audio),
      sessionDir: work,
      title: path.basename(audio, path.extname(audio)),
      createdAt: new Date().toISOString(),
      settings,
      binDir,
      modelsDir,
      llm,
      onStage: ({ message }) => {
        if (message && message !== lastLine) process.stdout.write(`\r${message.padEnd(60)}`);
        lastLine = message;
      },
    });
    process.stdout.write('\n');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    const raw = segmentsToText(result.rawSegments);
    const clean = segmentsToText(result.segments);
    const ref = reference ? fs.readFileSync(reference, 'utf8') : null;

    const lines = [`# Null Scribe test: ${path.basename(audio)}`, '', `Processed in ${secs} s on ${os.cpus()[0]?.model || 'this CPU'} (${os.cpus().length} threads).`, ''];
    if (ref) {
      // Compare against the reference with stage directions removed; WER on raw speech, and on cleaned text vs cleaned reference.
      const refSpoken = referenceWords(ref);
      const rawScore = wer(refSpoken, result.rawSegments.map((s) => s.text).join(' '));
      const cleanScore = wer(cleanText(refSpoken), result.segments.map((s) => s.text).join(' '));
      lines.push('## Accuracy', '', '| Comparison | Word accuracy | Reference words | Transcript words |', '|---|---|---|---|');
      lines.push(`| Raw transcript vs your script | ${((1 - rawScore.wer) * 100).toFixed(1)}% | ${rawScore.refWords} | ${rawScore.hypWords} |`);
      lines.push(`| Cleaned transcript vs cleaned script | ${((1 - cleanScore.wer) * 100).toFixed(1)}% | ${cleanScore.refWords} | ${cleanScore.hypWords} |`, '');
      const { facts, gold } = loadExtras(reference);
      if (facts) {
        const app = checkFacts(facts, result.summary);
        const ref2 = gold ? checkFacts(facts, gold) : null;
        const score = (r) => `${r.filter((x) => x.ok).length}/${r.length}`;
        lines.push('## Key facts', '');
        lines.push(gold ? '| Fact | Reference (Claude) | Null Scribe (Llama 3.2 3B) |' : '| Fact | Null Scribe (Llama 3.2 3B) |');
        lines.push(gold ? '|---|---|---|' : '|---|---|');
        app.forEach((f, i) => lines.push(gold ? `| ${f.label} | ${ref2[i].ok ? '✅' : '❌'} | ${f.ok ? '✅' : '❌'} |` : `| ${f.label} | ${f.ok ? '✅' : '❌'} |`));
        lines.push(gold ? `| **Score** | **${score(ref2)}** | **${score(app)}** |` : `| **Score** | **${score(app)}** |`, '');
      }
      lines.push('## 1. Your script (reference)', '', ref.trim(), '');
    }
    lines.push('## 2. Raw transcript (whisper.cpp, verbatim)', '', '```', raw, '```', '');
    lines.push('## 3. Cleaned transcript', '', '```', clean, '```', '');
    lines.push('## 4. AI summary (Llama 3.2 3B, built-in)', '', result.summary, '');
    const extras = loadExtras(reference);
    if (extras.gold) lines.push('## 5. Reference summary (written by Claude from your script, for comparison)', '', extras.gold, '');
    fs.writeFileSync('test-report.md', lines.join('\n'));
    console.log(lines.slice(0, lines.indexOf('## 1. Your script (reference)') > 0 ? lines.indexOf('## 1. Your script (reference)') : 8).join('\n'));
    console.log(`\nFull report written to ${path.resolve('test-report.md')}`);
  } catch (err) {
    console.error(`\nTest failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    llm.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
