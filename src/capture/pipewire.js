'use strict';

/**
 * Linux Meeting-mode capture on PipeWire.
 *
 * How it works:
 *  - A private recording node ("tap") is created per app with pw-record. It isn't connected to anything
 *    by default (node.autoconnect=false) but keeps running (node.always-process=true), so its
 *    track stays time-aligned with the mic track even while nobody is talking.
 *  - Every app's audio is its own PipeWire stream tagged with its name/binary. We link only the
 *    chosen apps' output ports into the tap with pw-link. Other apps (Spotify, games) are never linked.
 *  - Links are additive: the user still hears everything normally.
 *  - A watcher re-scans every ~1.5 s and links new streams (e.g. Discord reconnecting, Zoom
 *    creating a new stream when you join a breakout room).
 *  - Each chosen app gets its own tap and track, labeled with the app's name ("Discord", "Zoom").
 *  - The mic is recorded separately from the default input → "You" track.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TAP_PREFIX = 'null-scribe-tap';
const RATE = 48000;

function run(cmd, args, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

async function available() {
  for (const tool of ['pw-dump', 'pw-record', 'pw-link']) {
    try {
      await run('which', [tool]);
    } catch (_) {
      return { ok: false, reason: `PipeWire tools not found (${tool}). Install the "pipewire-bin" package.` };
    }
  }
  try {
    await run('pw-dump', ['--version']);
    await dump();
  } catch (err) {
    return { ok: false, reason: 'PipeWire is not running for this user session.' };
  }
  return { ok: true };
}

async function dump() {
  return JSON.parse(await run('pw-dump', [], { timeout: 8000 }));
}

/** Stable key used to pick an app across sessions: its binary, else its app name, else node name. */
function appKey(props) {
  return String(props['application.process.binary'] || props['application.name'] || props['node.name'] || '').toLowerCase();
}

// Friendly names for apps whose stream names are cryptic (Zoom reports "ZOOM VoiceEngine").
const PRETTY = {
  zoom: 'Zoom',
  discord: 'Discord',
  'teams-for-linux': 'Microsoft Teams',
  teams: 'Microsoft Teams',
  slack: 'Slack',
  spotify: 'Spotify',
  chrome: 'Google Chrome',
  chromium: 'Chromium',
  firefox: 'Firefox',
  signal: 'Signal',
  'signal-desktop': 'Signal',
  telegram: 'Telegram',
  'telegram-desktop': 'Telegram',
};

function appName(props) {
  const key = appKey(props);
  if (PRETTY[key]) return PRETTY[key];
  const raw = props['application.name'] || props['application.process.binary'] || props['node.name'] || 'Unknown app';
  return String(raw).replace(/^\w/, (c) => c.toUpperCase());
}

/** Parse pw-dump output into output streams (apps playing audio) and ports. */
function parseGraph(objects) {
  const streams = [];
  const ports = [];
  const nodes = new Map();
  for (const o of objects) {
    if (o.type === 'PipeWire:Interface:Node') {
      const props = o.info?.props || {};
      nodes.set(o.id, props);
      if (props['media.class'] === 'Stream/Output/Audio' && !String(props['node.name'] || '').startsWith('null-scribe')) {
        streams.push({ nodeId: o.id, key: appKey(props), name: appName(props), pid: props['application.process.id'] });
      }
    } else if (o.type === 'PipeWire:Interface:Port') {
      const props = o.info?.props || {};
      ports.push({
        id: o.id,
        nodeId: props['node.id'],
        direction: o.info?.direction, // 'input' | 'output'
        channel: props['audio.channel'] || 'MONO',
        monitor: props['port.monitor'] === true || props['port.monitor'] === 'true',
      });
    }
  }
  return { streams, ports, nodes };
}

/** Apps currently playing audio, grouped (one entry per app even if it has several streams). */
async function listSources() {
  const { streams } = parseGraph(await dump());
  const byKey = new Map();
  for (const s of streams) {
    if (!s.key) continue;
    const entry = byKey.get(s.key) || { id: s.key, name: s.name, streams: 0 };
    entry.streams += 1;
    byKey.set(s.key, entry);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pair an app's output ports with the tap's input ports by channel.
 * Mono outputs go to both tap channels; unknown layouts fall back to FL/FR in order.
 */
function planLinks(outPorts, tapIn) {
  const tapBy = Object.fromEntries(tapIn.map((p) => [p.channel, p.id]));
  const links = [];
  const outs = outPorts.filter((p) => !p.monitor);
  for (const [i, p] of outs.entries()) {
    if (p.channel === 'MONO' || outs.length === 1) {
      for (const id of tapIn.map((t) => t.id)) links.push([p.id, id]);
    } else if (tapBy[p.channel] !== undefined) {
      links.push([p.id, tapBy[p.channel]]);
    } else {
      const fallback = tapIn[i % tapIn.length];
      if (fallback) links.push([p.id, fallback.id]);
    }
  }
  return links;
}

function waitExit(proc, ms) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      resolve();
    }, ms);
    proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a meeting capture. Returns a handle with stop() → [{ path, speaker }].
 * onStatus({ elapsedMs, linkedApps, tracks: [{ speaker, bytes }] }) fires about once a second.
 */
/** Microphones / input devices: [{ id, name }] where id is the PipeWire node.name. */
async function listMics() {
  const objs = await dump();
  const mics = [];
  for (const o of objs) {
    if (o.type !== 'PipeWire:Interface:Node') continue;
    const p = o.info?.props || {};
    const cls = String(p['media.class'] || '');
    if (!cls.startsWith('Audio/Source') || String(p['node.name'] || '').startsWith('null-scribe')) continue;
    mics.push({ id: p['node.name'], name: p['node.description'] || p['node.nick'] || p['node.name'] });
  }
  return mics.sort((a, b) => a.name.localeCompare(b.name));
}

/** Display name for an app key: friendly name if known, else what the stream calls itself. */
function nameForKey(key, streams = []) {
  if (PRETTY[key]) return PRETTY[key];
  const s = streams.find((x) => x.key === key);
  return s ? s.name : key.replace(/^\w/, (c) => c.toUpperCase());
}

async function startCapture({ appKeys, mic = true, micId = '', dir, onStatus }) {
  fs.mkdirSync(dir, { recursive: true });
  const keys = [...new Set(appKeys.map((k) => String(k).toLowerCase()).filter(Boolean))];
  const procs = [];
  const tracks = [];
  let initialStreams = [];
  try {
    initialStreams = parseGraph(await dump()).streams;
  } catch (_) {}

  const record = (args, file, speaker, extra = {}) => {
    const proc = spawn('pw-record', [...args, file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    proc.on('error', (e) => (err += e.message));
    procs.push(proc);
    const t = { path: file, speaker, proc, err: () => err, ...extra };
    tracks.push(t);
    return t;
  };

  // One private tap per app, so each app gets its own track labeled with its name ("Discord", "Zoom").
  const stamp = `${process.pid}-${Date.now()}`;
  for (const [i, key] of keys.entries()) {
    const tapName = `${TAP_PREFIX}-${stamp}-${i}`;
    const safe = key.replace(/[^a-z0-9._-]+/g, '_') || `app${i}`;
    record(
      ['--target', '0', '--rate', String(RATE), '--channels', '2', '-P',
        `{ node.name = "${tapName}" node.description = "Null Scribe capture (${safe})" node.autoconnect = false node.always-process = true media.role = "Production" }`],
      path.join(dir, `app-${safe}.wav`),
      nameForKey(key, initialStreams),
      { key, tapName }
    );
  }
  if (mic) {
    const target = micId ? ['--target', String(micId)] : []; // empty = system default input
    record([...target, '--rate', String(RATE), '--channels', '1', '-P', '{ node.name = "null-scribe-mic" media.role = "Communication" }'], path.join(dir, 'you.wav'), 'You');
  }
  if (!tracks.length) throw new Error('Pick at least one app or turn on your microphone.');

  const started = Date.now();
  const made = new Set(); // "out->in" links already created
  const linkedApps = new Set();
  let stopped = false;
  let lastError = null;

  async function linkPass() {
    if (!keys.length) return;
    const { streams, ports, nodes } = parseGraph(await dump());
    for (const t of tracks) {
      if (!t.key) continue;
      let tapId = null;
      for (const [id, props] of nodes) if (props['node.name'] === t.tapName) tapId = id;
      if (tapId === null) continue; // tap not up yet
      const tapIn = ports.filter((p) => p.nodeId === tapId && p.direction === 'input').sort((a, b) => a.channel.localeCompare(b.channel));
      if (!tapIn.length) continue;
      await linkAppToTap(t, streams, ports, tapIn);
    }
  }

  async function linkAppToTap(track, streams, ports, tapIn) {
    for (const s of streams) {
      if (s.key !== track.key) continue;
      if (!PRETTY[s.key]) track.speaker = s.name; // stream may report a better name once it starts
      const outs = ports.filter((p) => p.nodeId === s.nodeId && p.direction === 'output');
      for (const [o, i] of planLinks(outs, tapIn)) {
        const k = `${o}->${i}`;
        if (made.has(k)) continue;
        try {
          await run('pw-link', [String(o), String(i)]);
          made.add(k);
          linkedApps.add(s.name);
        } catch (err) {
          if (/exist/i.test(err.stderr || '')) made.add(k);
          else lastError = (err.stderr || err.message).trim();
        }
      }
    }
  }

  // Watcher: link new streams + report status.
  const loop = (async () => {
    while (!stopped) {
      try {
        await linkPass();
      } catch (err) {
        lastError = err.message;
      }
      for (const t of tracks) {
        if (t.proc.exitCode !== null && !stopped) lastError = `Recorder for ${t.speaker} stopped: ${t.err().trim() || 'exit ' + t.proc.exitCode}`;
      }
      onStatus?.({
        elapsedMs: Date.now() - started,
        linkedApps: [...linkedApps],
        tracks: tracks.map((t) => ({ speaker: t.speaker, bytes: safeSize(t.path) })),
        error: lastError,
      });
      await sleep(1500);
    }
  })();

  return {
    async stop() {
      stopped = true;
      for (const p of procs) {
        try {
          p.kill('SIGINT'); // pw-record finalizes the WAV header on SIGINT
        } catch (_) {}
      }
      await Promise.all(procs.map((p) => waitExit(p, 4000)));
      await loop.catch(() => {});
      return tracks.filter((t) => safeSize(t.path) > 44).map((t) => ({ path: t.path, speaker: t.speaker }));
    },
    linkedApps: () => [...linkedApps],
    liveTracks: () => tracks.map((t) => ({ path: t.path, speaker: t.speaker })),
  };
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
}

module.exports = { available, listSources, listMics, startCapture, parseGraph, planLinks, appKey };
