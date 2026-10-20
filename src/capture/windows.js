'use strict';

/**
 * Windows Meeting-mode capture via bin/win/scribe-audiotap.exe (native/audiotap/audiotap.cpp),
 * which uses Windows process loopback capture: audio from chosen processes only, plus the mic.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function helperPath(binDir) {
  const p = path.join(binDir, 'scribe-audiotap.exe');
  return fs.existsSync(p) ? p : null;
}

function windowsBuild() {
  const m = /^\d+\.\d+\.(\d+)/.exec(os.release());
  return m ? Number(m[1]) : 0;
}

async function available(binDir) {
  if (windowsBuild() && windowsBuild() < 19041) {
    return { ok: false, reason: 'Meeting mode needs Windows 10 version 2004 or newer.' };
  }
  if (!helperPath(binDir)) return { ok: false, reason: 'Meeting capture helper is missing. Please reinstall Null Scribe.' };
  return { ok: true };
}

const PRETTY = { zoom: 'Zoom', discord: 'Discord', teams: 'Microsoft Teams', 'ms-teams': 'Microsoft Teams', slack: 'Slack', spotify: 'Spotify', chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Firefox' };

function keyFromExe(exe) {
  return String(exe || '').toLowerCase().replace(/\.exe$/, '');
}

function prettyName(key) {
  return PRETTY[key] || key.replace(/^\w/, (c) => c.toUpperCase());
}

/** Raw helper "list" output → [{ pid, exe, active }]. */
function runList(binDir) {
  return new Promise((resolve, reject) => {
    const bin = helperPath(binDir);
    if (!bin) return reject(new Error('Meeting capture helper is missing.'));
    execFile(bin, ['list'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('['));
      if (!line) {
        const errLine = stdout.split(/\r?\n/).find((l) => l.includes('"error"'));
        return reject(new Error(errLine ? JSON.parse(errLine).message : 'Helper returned nothing'));
      }
      resolve(JSON.parse(line));
    });
  });
}

/** Group sessions by app: [{ id, name, pids, active }]. Excludes Null Scribe itself. */
function groupSessions(sessions, selfPids = [process.pid, process.ppid]) {
  const byKey = new Map();
  for (const s of sessions) {
    const key = keyFromExe(s.exe);
    if (!key || selfPids.includes(s.pid) || key === 'null scribe' || key === 'electron') continue;
    const entry = byKey.get(key) || { id: key, name: prettyName(key), pids: [], active: false, streams: 0 };
    entry.pids.push(s.pid);
    entry.streams += 1;
    entry.active = entry.active || !!s.active;
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One status entry per speaker (an app with several processes reports as one). */
function mergeStatus(tracks) {
  const by = new Map();
  for (const t of tracks) {
    const e = by.get(t.speaker) || { speaker: t.speaker, bytes: 0, peak: 0 };
    e.bytes += t.bytes;
    e.peak = Math.max(e.peak, t.peak || 0);
    by.set(t.speaker, e);
  }
  return [...by.values()];
}

/** Microphones: [{ id, name, isDefault }] (id is the Windows endpoint id). */
function listMics(binDir) {
  return new Promise((resolve, reject) => {
    const bin = helperPath(binDir);
    if (!bin) return reject(new Error('Meeting capture helper is missing.'));
    execFile(bin, ['list-mics'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('['));
      resolve(line ? JSON.parse(line).map((m) => ({ id: m.id, name: m.name, isDefault: m.default })) : []);
    });
  });
}

async function listSources(binDir) {
  return groupSessions(await runList(binDir));
}

async function startCapture({ appKeys, mic = true, micId = '', dir, onStatus, binDir }) {
  fs.mkdirSync(dir, { recursive: true });
  const keys = new Set(appKeys.map((k) => String(k).toLowerCase()));
  const groups = keys.size ? groupSessions(await runList(binDir)) : [];
  const pids = new Set();
  const pidName = new Map(); // pid → app display name, used as the speaker label ("Discord")
  const linkedApps = new Set();
  for (const g of groups) {
    if (!keys.has(g.id)) continue;
    g.pids.forEach((p) => {
      pids.add(p);
      pidName.set(p, g.name);
    });
    linkedApps.add(g.name);
  }
  // Helper track names are "you" or "app-<pid>".
  const speakerFor = (trackName) => {
    if (trackName === 'you') return 'You';
    const pid = Number(String(trackName).replace(/^app-/, ''));
    return pidName.get(pid) || 'App';
  };

  const args = ['capture', '--out-dir', dir, ...[...pids].flatMap((p) => ['--pid', String(p)])];
  if (mic) args.push('--mic');
  if (mic && micId) args.push('--mic-id', String(micId));
  if (!pids.size && !mic && !keys.size) throw new Error('Pick at least one app or turn on your microphone.');

  const proc = spawn(helperPath(binDir), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const started = Date.now();
  let lastError = null;
  let lastTracks = [];
  let stoppedEvent = null;
  let buf = '';

  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (ev.event === 'error') lastError = ev.message;
      if (ev.event === 'status') {
        lastTracks = ev.tracks;
        onStatus?.({
          elapsedMs: Date.now() - started,
          linkedApps: [...linkedApps],
          tracks: mergeStatus(ev.tracks.map((t) => ({ speaker: speakerFor(t.name), bytes: t.frames * 4, peak: t.peak }))),
          error: lastError,
        });
      }
      if (ev.event === 'stopped') stoppedEvent = ev;
    }
  });
  proc.stderr.on('data', (d) => (lastError = d.toString().trim() || lastError));
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  proc.on('error', (e) => (lastError = e.message));

  // Watch for chosen apps that start audio after recording began (e.g. joining the call late).
  let stopped = false;
  const watcher = (async () => {
    while (!stopped && keys.size) {
      await new Promise((r) => setTimeout(r, 3000));
      if (stopped) break;
      try {
        for (const g of groupSessions(await runList(binDir))) {
          if (!keys.has(g.id)) continue;
          for (const pid of g.pids) {
            if (pids.has(pid)) continue;
            pids.add(pid);
            pidName.set(pid, g.name);
            linkedApps.add(g.name);
            proc.stdin.write(`add ${pid}\n`);
          }
        }
      } catch (_) {
        /* transient; try again next round */
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      try {
        proc.stdin.write('stop\n');
        proc.stdin.end();
      } catch (_) {}
      const timeout = new Promise((r) => setTimeout(r, 10000));
      await Promise.race([exited, timeout]);
      if (proc.exitCode === null) proc.kill();
      await watcher.catch(() => {});
      const names = stoppedEvent?.tracks || lastTracks.map((t) => t.name);
      return names
        .map((n) => ({ path: path.join(dir, `${n}.wav`), speaker: speakerFor(n) }))
        .filter((t) => fs.existsSync(t.path) && fs.statSync(t.path).size > 44);
    },
    linkedApps: () => [...linkedApps],
    error: () => lastError,
    liveTracks: () =>
      lastTracks
        .map((t) => ({ path: path.join(dir, `${t.name}.wav`), speaker: speakerFor(t.name) }))
        .filter((t) => fs.existsSync(t.path)),
  };
}

module.exports = { available, listSources, listMics, startCapture, groupSessions, keyFromExe, windowsBuild };
