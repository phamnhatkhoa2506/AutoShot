import { analyzeScreen, findCommandLine, isPromptLine } from './text.js';
import { applyOps } from './edit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Capture a session window as a new shot (PrintWindow first, so no focus change is needed). */
export async function captureSession(ctx, s, { label, area = 'window', method = 'auto', command } = {}) {
  await ctx.sessions.ensureAlive(s);
  const { id, file } = ctx.shots.allocate(label);
  const cap = (await ctx.worker.call('capture_window', { handle: s.handle, area, method, out: file })).capture;
  const win = await ctx.sessions.windowInfo(s);
  // exact text of the visible console rows at capture time -> pixel-exact text boxes later
  let consoleText = null;
  if (s.textSource === 'console' && s.consolePid) {
    try {
      const t = await ctx.sessions.readText(s);
      if (t.source === 'console') consoleText = { lines: t.lines };
    } catch {
      // fall back to OCR only
    }
  }
  return ctx.shots.add({
    console: consoleText,
    id,
    file,
    width: cap.Width,
    height: cap.Height,
    kind: 'window',
    label,
    session: s.id,
    command,
    source: { handle: s.handle, title: win.Title, className: win.ClassName, process: win.Process },
    captureInfo: { method: cap.Method, clientX: cap.ClientX, clientY: cap.ClientY, dpi: cap.Dpi, area, screenX: cap.ScreenX, screenY: cap.ScreenY },
  });
}

/** Height of the window chrome (title bar / Windows Terminal tab strip) at the top of a window shot. */
export function headerHeight(shot, ocrLines) {
  const ci = shot.captureInfo || {};
  if (ci.area === 'client' || shot.kind !== 'window') return 0;
  if (ci.clientY > 0) return ci.clientY;
  if (/CASCADIA/.test(shot.source?.className || '')) {
    const guess = Math.round(40 * ((ci.dpi || 96) / 96));
    const firstBody = ocrLines.find((l) => l.b[1] >= guess * 0.8);
    return firstBody ? Math.min(guess, Math.max(0, firstBody.b[1] - 4)) : guess;
  }
  return 0;
}

/**
 * Work out the crop that shows exactly "prompt + command + its output" on a window shot.
 * mode: block | block_titled | content
 */
export async function blockGeometry(ctx, s, shot, { command, mode = 'block', includePrompt = false } = {}) {
  const ocr = await ctx.shots.ocr(shot.id);
  const W = shot.width;
  const H = shot.height;
  const header = headerHeight(shot, ocr.lines);
  const lines = ocr.lines.filter((l) => l.b[1] >= header - 2);
  const notes = [];
  if (!lines.length) return { ops: [], notes: ['OCR found no text in the window; returning the full window.'] };

  const tops = lines.map((l) => l.b[1]);
  const gaps = [];
  for (let i = 1; i < tops.length; i++) {
    const d = tops[i] - tops[i - 1];
    if (d >= 8 && d <= 80) gaps.push(d);
  }
  const pitch = median(gaps) || Math.round(median(lines.map((l) => l.b[3])) * 1.35) || 18;
  const pad = Math.max(6, Math.round(pitch * 0.55));
  const texts = lines.map((l) => l.t);

  const cmdIdx = command ? findCommandLine(texts, command) : -1;
  let after = [];
  for (let i = cmdIdx + 1; i < lines.length; i++) after.push(i);
  if (s.kind === 'attached' && cmdIdx >= 0) {
    // other apps (MobaXterm, PuTTY ...) have UI chrome; follow the terminal column
    const cx = lines[cmdIdx].b[0];
    const col = [];
    let prevY = lines[cmdIdx].b[1];
    for (const i of after) {
      const l = lines[i];
      if (l.b[1] - prevY > pitch * 6) break;
      if (l.b[0] >= cx - pitch && l.b[0] <= cx + W * 0.6) {
        col.push(i);
        prevY = l.b[1];
      }
    }
    after = col;
  }
  const lastIdx = after.length ? after[after.length - 1] : cmdIdx;
  const promptIdx = lastIdx > cmdIdx && isPromptLine(texts[lastIdx], s.promptRe) ? lastIdx : -1;
  let endIdx = lastIdx;
  if (promptIdx >= 0 && !includePrompt) endIdx = after.length > 1 ? after[after.length - 2] : cmdIdx;
  if (endIdx < cmdIdx) endIdx = cmdIdx;
  if (endIdx < 0) endIdx = lines.length - 1;

  let top;
  if (cmdIdx >= 0) top = lines[cmdIdx].b[1] - pad;
  else {
    top = Math.max(header, lines[0].b[1] - pad);
    notes.push('The command line is not visible any more (scrolled off or cleared), so the crop starts at the top of the terminal area. For long output, re-run with clear_before=true, enlarge the window, or split the output into several commands.');
  }
  const endLine = lines[endIdx];
  const bottom = Math.min(H, endLine.b[1] + endLine.b[3] + pad);
  top = Math.max(header, Math.min(top, bottom - 4));

  let x0 = 0;
  let x1 = W;
  if (s.kind === 'attached' && cmdIdx >= 0) {
    const seedY = Math.max(0, lines[cmdIdx].b[1] - Math.max(2, Math.round((pitch - lines[cmdIdx].b[3]) / 2)));
    const ext = (await ctx.worker.call('row_extent', { path: shot.file, y: seedY, x: Math.max(0, lines[cmdIdx].b[0] - 2), tolerance: 18 })).extent;
    if (ext[1] - ext[0] >= W * 0.25) {
      x0 = ext[0];
      x1 = ext[1] + 1;
    }
  }

  // never cut through neighbouring text: stop half-way into the gap to the next line
  const overlapsX = (l) => l.b[0] < x1 && l.b[0] + l.b[2] > x0;
  const refTop = cmdIdx >= 0 ? lines[cmdIdx].b[1] : lines[0].b[1];
  const above = lines.filter((l) => l.b[1] + l.b[3] <= refTop && overlapsX(l)).pop();
  if (above) top = Math.max(top, Math.round((above.b[1] + above.b[3] + refTop) / 2));
  const endBottom = endLine.b[1] + endLine.b[3];
  const below = lines.find((l) => l.b[1] >= endBottom && overlapsX(l));
  let bottomY = bottom;
  if (below) bottomY = Math.min(bottom, Math.round((endBottom + below.b[1]) / 2));

  let ops;
  if (mode === 'content') {
    ops = [{ op: 'crop', rect: { x: 0, y: 0, w: W, h: bottomY } }];
  } else {
    ops = [{ op: 'crop', rect: { x: x0, y: top, w: x1 - x0, h: bottomY - top } }];
    if (mode === 'block_titled') {
      if (header > 0) ops.push({ op: 'prepend', src: shot.file, x: x0, y: 0, w: x1 - x0, h: header });
      else notes.push('This window has no separate title bar to keep; returned a plain block.');
    }
  }
  return { ops, notes, cmdFound: cmdIdx >= 0, promptFound: promptIdx >= 0 };
}

/** Wait until the terminal settles: prompt back, expected text shown, input requested, or timeout. */
export async function waitFor(ctx, s, { command = null, expect = null, settleMs = 600, timeoutMs = 45_000, promptRe = null } = {}) {
  const expectRe = expect ? new RegExp(expect, 'im') : null;
  const t0 = Date.now();
  const key = `wait-${s.id}`;
  let consoleMode = s.textSource === 'console' && !!s.consolePid;
  if (!consoleMode) await ctx.worker.call('probe_reset', { key });
  let lastSig = null;
  let lastChange = Date.now();
  let lastOcrAt = 0;
  let text = null;
  let analysis = null;
  const finish = (status) => ({ status, elapsedMs: Date.now() - t0, analysis, text });

  for (;;) {
    let fresh = false;
    if (consoleMode) {
      text = await ctx.sessions.readText(s, { extra: s.host === 'conhost' ? 300 : 0 });
      if (text.source !== 'console') consoleMode = false;
      const sig = `${text.lines.join('\n')}|${text.cursorRow},${text.cursorX}`;
      if (sig !== lastSig) {
        lastSig = sig;
        lastChange = Date.now();
      }
      fresh = true;
    } else {
      const ch = (await ctx.worker.call('probe', { handle: s.handle, key })).changed;
      if (ch < 0 || ch > 3) lastChange = Date.now();
      const stable = Date.now() - lastChange >= settleMs;
      if (stable || Date.now() - lastOcrAt > 5000 || !text) {
        text = await ctx.sessions.readText(s);
        lastOcrAt = Date.now();
        fresh = true;
      }
    }
    const stableFor = Date.now() - lastChange;
    if (fresh) {
      analysis = analyzeScreen(text.lines, { command, promptRe: promptRe || s.promptRe, expectRe });
      const cursorOnPrompt = text.source === 'console' && analysis.lastIdx === text.cursorRow;
      if (analysis.state === 'expect') return finish('expect');
      if (analysis.state === 'done' && (stableFor >= settleMs || (cursorOnPrompt && stableFor >= 250))) {
        if (analysis.lastIdx >= 0) s.lastPrompt = String(text.lines[analysis.lastIdx]).trim();
        return finish('done');
      }
      if (analysis.state === 'awaiting' && stableFor >= settleMs) return finish('awaiting');
    }
    if (Date.now() - t0 > timeoutMs) return finish('timeout');
    await sleep(consoleMode ? 120 : 200);
  }
}

export async function clearScreen(ctx, s) {
  const k = s.clearKey || (s.shellKind === 'cmd' ? 'cls' : 'ctrl+l');
  if (k === 'cls' || k === 'clear') await ctx.sessions.input(s, [{ text: k }, { keys: ['enter'] }]);
  else await ctx.sessions.input(s, [{ keys: [k] }]);
  await waitFor(ctx, s, { command: null, settleMs: 350, timeoutMs: 8000 });
}

/** Type a command, wait for it to finish and optionally capture a precisely cropped shot. */
export async function runCommand(ctx, s, opts) {
  const command = String(opts.command ?? '');
  await ctx.sessions.ensureAlive(s);
  if (opts.clear_before) await clearScreen(ctx, s);
  const inputRes = await ctx.sessions.input(s, [{ text: command }, { keys: ['enter'] }], { method: opts.input_method });
  const w = await waitFor(ctx, s, {
    command,
    expect: opts.expect,
    settleMs: opts.settle_ms ?? 600,
    timeoutMs: opts.timeout_ms ?? ctx.cfg.commandTimeoutMs,
  });
  const result = {
    status: w.status,
    elapsedMs: w.elapsedMs,
    input: inputRes.method,
    source: w.text?.source,
    output: w.analysis?.output ?? [],
    truncatedTop: !!w.analysis?.truncatedTop,
    awaiting: w.analysis?.awaiting ?? null,
    screenTail: (w.text?.lines ?? []).filter((l) => l.trim()).slice(-12),
    notes: [],
    shot: null,
    baseShot: null,
  };
  const mode = opts.capture || 'none';
  if (mode !== 'none') {
    // small grace period so the final frame is painted
    await sleep(120);
    const base = await captureSession(ctx, s, { label: opts.label || command, command });
    result.baseShot = base;
    if (mode === 'window') result.shot = base;
    else {
      const geo = await blockGeometry(ctx, s, base, { command, mode, includePrompt: !!opts.include_prompt });
      result.notes.push(...geo.notes);
      const ops = [...geo.ops, ...(opts.ops || [])];
      result.shot = ops.length ? await applyOps(ctx, base, ops, { label: opts.label || command }) : base;
    }
  }
  return result;
}
