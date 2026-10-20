'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

/** Find llama.cpp's llama-server inside binDir. */
function findLlamaServer(binDir) {
  const p = path.join(binDir, `llama-server${process.platform === 'win32' ? '.exe' : ''}`);
  return fs.existsSync(p) ? p : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs llama-server as a private child process bound to 127.0.0.1 and talks to its
 * OpenAI-compatible /v1/chat/completions endpoint. Started on demand, stopped after idleMs.
 */
class LocalLLM {
  constructor({ bin, ctxSize = 8192, threads, idleMs = 5 * 60 * 1000 } = {}) {
    this.bin = bin;
    this.ctxSize = ctxSize;
    this.threads = threads || Math.max(1, Math.min(8, os.cpus().length - 1));
    this.idleMs = idleMs;
    this.proc = null;
    this.port = null;
    this.modelFile = null;
    this.starting = null;
    this.idleTimer = null;
    this.log = '';
  }

  /** Start (or reuse) the server for modelFile. Resolves once /health reports ready. */
  async start(modelFile, { signal, timeoutMs = 180000 } = {}) {
    if (this.proc && this.modelFile === modelFile) return;
    if (this.starting) await this.starting.catch(() => {});
    if (this.proc && this.modelFile === modelFile) return;
    this.stop();
    if (!this.bin || !fs.existsSync(this.bin)) {
      throw new Error('Built-in summarizer (llama-server) not found. Run "npm run build:engines" (see README).');
    }
    this.starting = this._start(modelFile, signal, timeoutMs);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async _start(modelFile, signal, timeoutMs) {
    const port = await freePort();
    const args = ['-m', modelFile, '--host', '127.0.0.1', '--port', String(port), '-c', String(this.ctxSize), '-t', String(this.threads), '--no-webui'];
    this.log = '';
    const proc = spawn(this.bin, args, { windowsHide: true });
    const capture = (d) => (this.log = (this.log + d.toString()).slice(-8000));
    proc.stdout.on('data', capture);
    proc.stderr.on('data', capture);
    let exited = false;
    proc.on('exit', () => {
      exited = true;
      if (this.proc === proc) {
        this.proc = null;
        this.modelFile = null;
      }
    });
    proc.on('error', (err) => {
      exited = true;
      this.log += `\n${err.message}`;
    });
    this.proc = proc;
    this.port = port;
    this.modelFile = modelFile;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        this.stop();
        throw new Error('Cancelled');
      }
      if (exited) {
        const lines = this.log.trim().split('\n');
        const errLines = lines.filter((l) => /\bE\b|error|failed/i.test(l));
        const detail = (errLines.length ? errLines.slice(-2) : lines.slice(-2)).join(' ').replace(/\s+/g, ' ');
        throw new Error(`Built-in summarizer failed to start: ${detail}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return; // 503 while the model is still loading
      } catch (_) {
        /* not listening yet */
      }
      await sleep(400);
    }
    this.stop();
    throw new Error('Built-in summarizer took too long to load the model.');
  }

  /** Same signature as ollamaChat, so summarize() can use either engine. */
  async chat({ messages, signal }) {
    if (!this.proc) throw new Error('Built-in summarizer is not running');
    clearTimeout(this.idleTimer);
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, temperature: 0.2, stream: false, max_tokens: 1500 }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new Error('Cancelled');
      throw new Error(`Built-in summarizer stopped responding: ${err.message}`);
    } finally {
      this._armIdle();
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Built-in summarizer error HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Built-in summarizer returned no text');
    return content;
  }

  _armIdle() {
    clearTimeout(this.idleTimer);
    if (this.idleMs > 0) {
      this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
      this.idleTimer.unref?.();
    }
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (this.proc) {
      try {
        this.proc.kill();
      } catch (_) {
        /* already gone */
      }
    }
    this.proc = null;
    this.modelFile = null;
  }
}

module.exports = { LocalLLM, findLlamaServer };
