import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(here, '..', 'native', 'worker.ps1');

// Owns the long-lived PowerShell worker (native/worker.ps1). Requests are serialized:
// the worker is single threaded and most actions touch global UI state (focus, input).
export class Worker {
  constructor({ cacheDir, log = () => {} }) {
    this.cacheDir = cacheDir;
    this.log = log;
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.info = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', WORKER_SCRIPT, '-CacheDir', this.cacheDir],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.proc = proc;
      let stderr = '';
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        reject(err);
      };
      const startTimer = setTimeout(() => fail(new Error(`AutoShot worker did not start within 90s. ${stderr.trim()}`)), 90_000);

      createInterface({ input: proc.stdout }).on('line', (line) => {
        const text = line.trim();
        if (!text.startsWith('{')) return;
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.type === 'ready') {
          clearTimeout(startTimer);
          settled = true;
          this.info = msg;
          this.log(`worker ready (pid ${msg.pid}, dpi ${msg.dpi})`);
          resolve(msg);
          return;
        }
        if (msg.type === 'fatal') {
          clearTimeout(startTimer);
          fail(new Error(msg.error));
          return;
        }
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result ?? {});
        else entry.reject(new WorkerError(msg.error));
      });
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      proc.on('exit', (code) => {
        this.log(`worker exited with code ${code}`);
        clearTimeout(startTimer);
        fail(new Error(`AutoShot worker exited during startup (code ${code}). ${stderr.trim()}`));
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new WorkerError(`worker exited (code ${code})`));
        }
        this.pending.clear();
        this.proc = null;
        this.ready = null;
      });
      proc.on('error', fail);
    });
    return this.ready;
  }

  call(action, params = {}, { timeoutMs = 30_000 } = {}) {
    const run = async () => {
      await this.start();
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new WorkerError(`worker action '${action}' timed out after ${timeoutMs} ms`));
          this.restart();
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.proc.stdin.write(JSON.stringify({ id, action, params }) + '\n');
      });
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  restart() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // already gone
      }
    }
    this.proc = null;
    this.ready = null;
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {
        // already gone
      }
    }
    this.proc = null;
    this.ready = null;
  }
}

export class WorkerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkerError';
    const m = /^([A-Z_]+):\s*/.exec(message || '');
    this.code = m ? m[1] : undefined;
  }
}
