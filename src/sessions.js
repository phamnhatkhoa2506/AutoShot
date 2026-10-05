import { isPromptLine } from './text.js';
import { ocrImage } from './shots.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHELLS = {
  powershell: { exe: 'powershell.exe', proc: 'powershell.exe', kind: 'powershell', clear: 'ctrl+l' },
  pwsh: { exe: 'pwsh.exe', proc: 'pwsh.exe', kind: 'powershell', clear: 'ctrl+l' },
  cmd: { exe: 'cmd.exe', proc: 'cmd.exe', kind: 'cmd', clear: 'cls' },
  wsl: { exe: 'wsl.exe', proc: 'wsl.exe', kind: 'bash', clear: 'ctrl+l' },
};

const TERMINAL_CLASSES = /^(CASCADIA_HOSTING_WINDOW_CLASS|ConsoleWindowClass)$/;

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function shellArgs(shell, marker, title) {
  if (shell.kind === 'powershell') {
    const parts = [`$global:__autoshot=${psQuote(marker)}`];
    if (title) parts.push(`$Host.UI.RawUI.WindowTitle=${psQuote(title)}`);
    return `-NoLogo -NoExit -Command "${parts.join('; ').replace(/"/g, '\\"')}"`;
  }
  if (shell.kind === 'cmd') {
    const t = title ? `title ${title.replace(/[&|<>^"]/g, '')}&` : '';
    return `/k "${t}rem ${marker}"`;
  }
  return '--cd ~';
}

export class SessionManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.sessions = new Map();
    this.seq = 0;
  }

  get worker() {
    return this.ctx.worker;
  }

  list() {
    return [...this.sessions.values()];
  }

  get(id) {
    const s = this.sessions.get(String(id ?? '').trim());
    if (!s) {
      const ids = this.list().map((x) => `${x.id} (${x.name})`).join(', ') || 'none';
      throw new Error(`Unknown session '${id}'. Open sessions: ${ids}. Use open_terminal or attach_window first.`);
    }
    return s;
  }

  register(s) {
    s.id = `t${++this.seq}`;
    s.name = s.name || s.id;
    this.sessions.set(s.id, s);
    return s;
  }

  async ensureAlive(s) {
    const r = await this.worker.call('alive', { handle: s.handle });
    if (!r.alive) {
      this.sessions.delete(s.id);
      throw new Error(`Session ${s.id} window was closed. Open or attach a new session.`);
    }
  }

  async windowInfo(s) {
    return (await this.worker.call('describe', { handle: s.handle })).window;
  }

  // ------------------------------------------------------------------ open
  async open(opts = {}) {
    const shellName = opts.shell || 'powershell';
    const shell = SHELLS[shellName];
    if (!shell) throw new Error(`Unsupported shell '${shellName}'. Use one of: ${Object.keys(SHELLS).join(', ')}.`);
    let host = opts.host || this.ctx.cfg.defaultHost;
    if (host === 'auto') host = this.ctx.cfg.hasWindowsTerminal ? 'wt' : 'conhost';
    if (host === 'wt' && !this.ctx.cfg.hasWindowsTerminal) throw new Error('Windows Terminal (wt.exe) is not installed; use host "conhost".');

    const marker = `autoshot-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const args = shellArgs(shell, marker, opts.title);
    const before = new Set((await this.worker.call('list_windows', { includeAll: true })).windows.map((w) => w.Handle));
    const t0 = Date.now();

    if (host === 'wt') {
      let wtArgs = '-w new';
      if (opts.cols && opts.rows) wtArgs += ` --size ${opts.cols},${opts.rows}`;
      if (opts.x != null && opts.y != null) wtArgs += ` --pos ${opts.x},${opts.y}`;
      wtArgs += ' new-tab';
      if (opts.title) wtArgs += ` --title "${opts.title.replace(/"/g, '')}" --suppressApplicationTitle`;
      if (opts.cwd) wtArgs += ` -d "${opts.cwd}"`;
      // wt treats ';' as a sub-command separator
      wtArgs += ` ${shell.exe} ${args.replace(/;/g, '\\;')}`;
      await this.worker.call('launch', { exe: 'wt.exe', args: wtArgs, cwd: opts.cwd || '' });
    } else {
      await this.worker.call('launch', { exe: 'conhost.exe', args: `${shell.exe} ${args}`, cwd: opts.cwd || '' });
    }

    const wantClass = host === 'wt' ? 'CASCADIA_HOSTING_WINDOW_CLASS' : 'ConsoleWindowClass';
    let win = null;
    while (!win && Date.now() - t0 < 25_000) {
      await sleep(250);
      const wins = (await this.worker.call('list_windows', { includeAll: true })).windows;
      win = wins.find((w) => !before.has(w.Handle) && w.ClassName === wantClass && w.Width > 50);
    }
    if (!win) throw new Error(`The terminal window did not appear within 25s (host ${host}). The machine may be busy; try again.`);

    let shellPid = 0;
    for (let i = 0; i < 20 && !shellPid; i++) {
      const p = await this.worker.call('find_process', { name: shell.proc, marker: shell.kind === 'bash' ? '' : marker, afterMs: t0 });
      shellPid = p.pid;
      if (!shellPid) await sleep(300);
    }

    const s = this.register({
      name: opts.name || opts.title || `${shellName}`,
      kind: 'managed',
      shell: shellName,
      shellKind: shell.kind,
      clearKey: shell.clear,
      host,
      handle: win.Handle,
      consolePid: shellPid || 0,
      inputMethod: shellPid ? 'console' : 'keyboard',
      textSource: shellPid ? 'console' : 'ocr',
      promptRe: opts.prompt_regex ? new RegExp(opts.prompt_regex) : null,
      createdAt: new Date().toISOString(),
    });

    if (opts.width || opts.height) {
      await this.worker.call('move', { handle: s.handle, x: opts.x ?? null, y: opts.y ?? null, width: opts.width || 0, height: opts.height || 0 });
    } else if (host === 'conhost' && opts.x != null && opts.y != null) {
      await this.worker.call('move', { handle: s.handle, x: opts.x, y: opts.y });
    }

    const ready = await this.waitReady(s, 30_000);
    s.ready = ready;
    return s;
  }

  async waitReady(s, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const txt = await this.readText(s);
        const last = [...txt.lines].reverse().find((l) => l.trim());
        if (last && isPromptLine(last, s.promptRe)) {
          s.lastPrompt = last.trim();
          return true;
        }
      } catch {
        // console not ready yet
      }
      await sleep(400);
    }
    return false;
  }

  // ------------------------------------------------------------------ attach
  async findWindows({ handle, title, process: proc }) {
    const wins = (await this.worker.call('list_windows', { includeAll: false })).windows;
    if (handle) return wins.filter((w) => w.Handle === Number(handle));
    const t = title ? String(title).toLowerCase() : null;
    const p = proc ? String(proc).toLowerCase().replace(/\.exe$/, '') : null;
    return wins.filter((w) => (!t || w.Title.toLowerCase().includes(t)) && (!p || w.Process.toLowerCase() === p));
  }

  async attach(opts = {}) {
    if (!opts.handle && !opts.title && !opts.process) throw new Error('Give handle, title or process (see list_windows).');
    let wins = await this.findWindows(opts);
    if (!wins.length && opts.handle) {
      const d = await this.worker.call('describe', { handle: Number(opts.handle) });
      wins = [d.window];
    }
    if (!wins.length) throw new Error('No matching window. Call list_windows to see what is open.');
    if (wins.length > 1 && opts.index == null) {
      const list = wins.map((w, i) => `  [${i}] handle ${w.Handle} · ${w.Process} · "${w.Title}"`).join('\n');
      throw new Error(`Several windows match; pass handle (or index):\n${list}`);
    }
    const win = wins[Math.min(Number(opts.index ?? 0), wins.length - 1)];

    let consolePid = Number(opts.console_pid || 0);
    if (!consolePid && win.ClassName === 'ConsoleWindowClass') {
      const candidates = [win.Pid, ...(await this.worker.call('children', { pid: win.Pid })).children.map((c) => c.pid)];
      for (const pid of candidates) {
        try {
          const r = JSON.parse((await this.worker.call('console_read', { pid })).raw);
          if (r.ok) {
            consolePid = pid;
            break;
          }
        } catch {
          // not attachable
        }
      }
    }
    const s = this.register({
      name: opts.name || win.Title || win.Process,
      kind: 'attached',
      shell: 'unknown',
      shellKind: /cmd/i.test(win.Title) ? 'cmd' : 'unknown',
      clearKey: null,
      host: win.Process,
      handle: win.Handle,
      consolePid,
      inputMethod: consolePid ? 'console' : opts.input_method || 'paste',
      pasteChord: opts.paste_chord || 'shift+insert',
      textSource: consolePid ? 'console' : 'ocr',
      promptRe: opts.prompt_regex ? new RegExp(opts.prompt_regex) : null,
      createdAt: new Date().toISOString(),
    });
    return s;
  }

  // ------------------------------------------------------------------ io
  /** steps: [{text}|{keys:[...]}|{sleep}] ; method override: 'console' | 'type' | 'paste' */
  async input(s, steps, { method } = {}) {
    await this.ensureAlive(s);
    const m = method || s.inputMethod;
    if (m === 'console' && s.consolePid) {
      try {
        return await this.worker.call('console_input', { pid: s.consolePid, steps });
      } catch (e) {
        if (!/CONSOLE_INPUT_FAILED|AttachConsole/.test(e.message)) throw e;
        // shell exited (e.g. `exit` from ssh + shell) - fall back to keyboard input
        s.consolePid = 0;
        s.inputMethod = 'type';
        s.textSource = 'ocr';
      }
    }
    const kbSteps = steps.map((st) => {
      if (st.text != null && (m === 'paste' || (s.inputMethod === 'paste' && m !== 'type'))) {
        return { paste: st.text, chord: s.pasteChord || 'shift+insert' };
      }
      return st;
    });
    const r = await this.worker.call('input', { handle: s.handle, steps: kbSteps, restoreFocus: this.ctx.cfg.restoreFocus }, { timeoutMs: 60_000 });
    return { ...r, method: m === 'console' ? 'type' : m };
  }

  /**
   * Current screen text. Console sessions: exact buffer text. Others: OCR of a fresh capture.
   * Returns { source, lines, cursorRow?, title?, ocrLines?, capture? }
   */
  async readText(s, { extra = 0 } = {}) {
    if (s.textSource === 'console' && s.consolePid) {
      const r = JSON.parse((await this.worker.call('console_read', { pid: s.consolePid, extra })).raw);
      if (!r.ok) {
        if (/AttachConsole/.test(r.error)) {
          s.consolePid = 0;
          s.textSource = 'ocr';
          s.inputMethod = 'type';
        } else throw new Error(r.error);
      } else {
        const lines = r.lines;
        return { source: 'console', lines, cursorRow: r.cursorY - r.start, cursorX: r.cursorX, cols: r.cols, title: r.title, hasScrollback: r.bufferRows > r.bottom - r.top + 1 };
      }
    }
    const file = this.ctx.shots.tmpFile('read');
    const cap = (await this.worker.call('capture_window', { handle: s.handle, area: 'window', method: 'auto', out: file })).capture;
    const ocrLines = (await ocrImage(this.worker, file, this.ctx.cfg.ocrScale, 'dual')).lines;
    return { source: 'ocr', lines: ocrLines.map((l) => l.t), ocrLines, capture: cap, file };
  }

  async close(s) {
    try {
      await this.worker.call('close', { handle: s.handle });
    } finally {
      this.sessions.delete(s.id);
    }
  }
}

export function describeSession(s, win) {
  const how = s.kind === 'managed' ? `managed ${s.shell} in ${s.host === 'wt' ? 'Windows Terminal' : 'classic console'}` : `attached ${s.host}`;
  const geo = win ? ` · ${win.Width}×${win.Height} at (${win.X},${win.Y})${win.Minimized ? ' minimized' : ''} · title "${win.Title}"` : '';
  const io = s.consolePid
    ? `input: console buffer (no focus needed) · text: exact console text (pid ${s.consolePid})`
    : `input: ${s.inputMethod === 'paste' ? 'clipboard paste' : 'keyboard'} (window gets focus briefly) · text: OCR`;
  return `session ${s.id} "${s.name}" · ${how} · window ${s.handle}${geo}\n  ${io}`;
}

export { TERMINAL_CLASSES };
