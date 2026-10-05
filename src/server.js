import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig, makeLogger } from './config.js';
import { Worker } from './worker.js';
import { ShotStore, describeShot, formatOcrLines } from './shots.js';
import { SessionManager, describeSession } from './sessions.js';
import { EvidenceManifest, describeEvidence } from './evidence.js';
import { applyOps } from './edit.js';
import { captureSession, runCommand, waitFor } from './terminal.js';
import { buildReport } from './report/index.js';
import { AWAIT_HINTS, findText } from './text.js';
import { EVIDENCE_PROMPT, SERVER_INSTRUCTIONS } from './instructions.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function createContext(cfg = loadConfig()) {
  const log = makeLogger(cfg);
  const worker = new Worker({ cacheDir: cfg.cacheDir, log });
  const ctx = { cfg, log, worker };
  ctx.shots = new ShotStore(cfg, worker);
  ctx.sessions = new SessionManager(ctx);
  ctx.evidence = new EvidenceManifest(cfg);
  return ctx;
}

// ------------------------------------------------------------------ schemas
const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const Point = z.object({ x: z.number(), y: z.number() });

const Op = z
  .object({
    op: z.enum(['crop', 'trim', 'pad', 'scale', 'frame', 'box', 'highlight', 'redact', 'label', 'badge', 'arrow']),
    rect: Rect.optional().describe('Target rectangle in pixels of the INPUT shot (x,y = top-left).'),
    rect_pct: Rect.optional().describe('Target rectangle as fractions 0..1 of the input shot size.'),
    text: z.string().optional().describe('Target = where this text appears (OCR, case-insensitive, tolerant to small OCR errors).'),
    regex: z.string().optional().describe('Target = OCR text matching this regex (case-insensitive).'),
    preset: z
      .enum(['ipv4', 'ipv6', 'mac', 'email', 'jwt', 'secret', 'password_value', 'hostname'])
      .optional()
      .describe('Built-in pattern, mainly for redact.'),
    lines: z.array(z.number()).optional().describe('OCR line range [from, to], 1-based as listed (L01, L02...).'),
    line: z.number().optional().describe('Single OCR line number.'),
    occurrence: z.string().optional().describe('"all" (default), "first", "last" or a 1-based number.'),
    from_text: z.string().optional().describe('crop: start at the line containing this text (last occurrence by default).'),
    to_text: z.string().optional().describe('crop: end at the first line containing this text after from_text.'),
    include_to: z.boolean().optional().describe('crop: include the to_text line (default true).'),
    full_width: z.boolean().optional().describe('crop: keep the full image width (default true for line/text-anchored crops).'),
    padding: z.number().optional().describe('Extra pixels around the target.'),
    size: z.number().optional().describe('pad: pixels on every side · label: font px · badge: diameter px.'),
    factor: z.number().optional().describe('scale factor'),
    width: z.number().optional().describe('scale to this width'),
    max_width: z.number().optional().describe('scale down only if wider'),
    margin: z.number().optional().describe('frame margin px'),
    bg: z.string().optional().describe('frame/pad background colour'),
    shadow: z.boolean().optional(),
    radius: z.number().optional(),
    color: z.string().optional().describe('Colour like "#E53935" (default red for box/arrow, yellow for highlight).'),
    thickness: z.number().optional(),
    opacity: z.number().optional().describe('highlight opacity 0..1 (default 0.35)'),
    style: z.enum(['pixelate', 'blur', 'solid']).optional().describe('redact style (default pixelate)'),
    label: z.string().optional().describe('label/badge text, or a caption tag attached to a box/highlight/arrow.'),
    position: z.enum(['right', 'left', 'above', 'below']).optional().describe('Where to put a label/badge relative to the target.'),
    number: z.number().optional().describe('badge number'),
    at: Point.optional().describe('label/badge position in input-shot pixels (instead of a target).'),
    from: Point.optional().describe('arrow start in input-shot pixels (default: to the lower right of the target).'),
    tolerance: z.number().optional().describe('trim colour tolerance'),
  })
  .describe('One image operation. Targets: rect | rect_pct | text | regex | preset | lines | line.');

const Evidence = z
  .object({
    caption: z.string().describe('What this image proves, in the report language.'),
    section: z.string().optional().describe('Report section / step name, e.g. "Câu 2" or "Step 3: Configure SSH".'),
    name: z.string().optional().describe('Short file name hint.'),
    description: z.string().optional().describe('Optional paragraph shown above the image.'),
  })
  .describe('Save the resulting image as report evidence right away.');

const Anchor = z
  .object({
    text: z.string().optional().describe('OCR text anchor (tolerant to small OCR errors).'),
    regex: z.string().optional().describe('OCR regex anchor.'),
    occurrence: z.enum(['first', 'last']).optional().describe('Which matching anchor to use (default last).'),
  })
  .refine((a) => a.text || a.regex, { message: 'anchor needs text or regex' });

// ------------------------------------------------------------------ helpers
function normOccurrence(ops) {
  return (ops || []).map((o) => {
    if (typeof o.occurrence === 'string' && /^\d+$/.test(o.occurrence)) return { ...o, occurrence: Number(o.occurrence) };
    return o;
  });
}

function formatOutput(lines, max = 60) {
  if (!lines.length) return '(no output)';
  const body = lines.length > max ? [...lines.slice(0, Math.ceil(max / 2)), `… (${lines.length - max} lines omitted) …`, ...lines.slice(-Math.floor(max / 2))] : lines;
  return body.map((l) => `│ ${l}`).join('\n');
}

async function imageBlock(ctx, shotId, grid = false) {
  if (!ctx.cfg.inlineImages) return [];
  const p = await ctx.shots.preview(shotId, { grid });
  const note = p.scale < 0.999 ? [{ type: 'text', text: `(preview scaled ×${p.scale.toFixed(2)}; coordinates in tools are full-size pixels${grid ? ', grid labels are full-size pixels' : ''})` }] : [];
  return [...note, { type: 'image', data: p.data, mimeType: 'image/png' }];
}

function saveEvidence(ctx, shot, ev, extra = {}) {
  if (!ev) return null;
  return ctx.evidence.add(shot, { ...ev, command: extra.command, output: extra.output });
}

function captureInfo(cap, area = 'window') {
  return {
    method: cap.Method,
    clientX: cap.ClientX,
    clientY: cap.ClientY,
    dpi: cap.Dpi,
    area,
    screenX: cap.ScreenX,
    screenY: cap.ScreenY,
  };
}

function verification(ocr, required, minMatches = 1) {
  const matches = required.map((text) => ({ text, count: findText(ocr.lines, { text }).length }));
  const total = matches.reduce((n, m) => n + m.count, 0);
  return { verified: matches.every((m) => m.count > 0) && total >= minMatches, matches, total };
}

function tool(server, ctx, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return await handler(args ?? {});
    } catch (e) {
      ctx.log(`${name} failed: ${e.stack || e.message}`);
      return { content: [{ type: 'text', text: `Error in ${name}: ${e.message}` }], isError: true };
    }
  });
}

async function resolveCaptureTarget(ctx, a) {
  if (a.session) return { session: ctx.sessions.get(a.session) };
  if (a.handle || a.title || a.process) {
    const wins = await ctx.sessions.findWindows({ handle: a.handle, title: a.title, process: a.process });
    if (!wins.length) throw new Error('No matching window. Call list_windows.');
    if (wins.length > 1 && !a.handle) {
      throw new Error(`Several windows match; pass handle:\n${wins.map((w) => `  handle ${w.Handle} · ${w.Process} · "${w.Title}"`).join('\n')}`);
    }
    return { window: wins[0] };
  }
  if (a.region) return { region: a.region };
  return { screen: a.screen ?? 0 };
}

// ------------------------------------------------------------------ server
export function createServer(ctx = createContext()) {
  const server = new McpServer({ name: 'autoshot', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

  tool(
    server,
    ctx,
    'list_windows',
    {
      title: 'List windows',
      description:
        'List visible top-level windows (handle, process, title, size, position) and the open AutoShot sessions. Use it to find an existing terminal/app to attach_window to, or a window to capture.',
      inputSchema: {
        filter: z.string().optional().describe('Case-insensitive substring of title or process name.'),
        include_all: z.boolean().optional().describe('Also list untitled/tool windows.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ filter, include_all }) => {
      const wins = (await ctx.worker.call('list_windows', { includeAll: !!include_all })).windows;
      const f = filter?.toLowerCase();
      const rows = wins
        .filter((w) => !f || w.Title.toLowerCase().includes(f) || w.Process.toLowerCase().includes(f))
        .map((w) => `handle ${w.Handle} · ${w.Process} · "${w.Title}" · ${w.Width}×${w.Height} at (${w.X},${w.Y})${w.Minimized ? ' · minimized' : ''}${w.Foreground ? ' · foreground' : ''}`);
      const sess = ctx.sessions.list().map((s) => `${s.id} "${s.name}" → window ${s.handle}`);
      const screens = (await ctx.worker.call('screens')).screens.map((s) => `monitor ${s.Index}: ${s.Width}×${s.Height} at (${s.X},${s.Y})${s.Primary ? ' primary' : ''}`);
      return {
        content: [{ type: 'text', text: `${rows.length} window(s):\n${rows.join('\n') || '(none)'}\n\nSessions: ${sess.join(', ') || 'none'}\n${screens.join('\n')}` }],
      };
    },
  );

  tool(
    server,
    ctx,
    'capture_from_shot',
    {
      title: 'Crop or re-capture a region from a shot',
      description:
        'Use a rectangle measured in an existing shot, not desktop coordinates. rect is in the same full-size pixel space as that shot\'s OCR boxes and grid. Default fresh=false crops the existing pixels. fresh=true captures the same rectangle again from the live screen; it is only available for a direct screen shot with a known absolute screen origin.',
      inputSchema: {
        shot: z.string().describe('Source shot whose pixel space rect uses.'),
        rect: Rect.describe('Rectangle in SOURCE SHOT pixels.'),
        padding: z.number().min(0).optional().describe('Extra pixels around rect; clamped to the source shot.'),
        fresh: z.boolean().optional().describe('Default false. Re-capture live pixels instead of cropping the saved shot.'),
        label: z.string().optional(),
        with_text: z.boolean().optional(),
        grid: z.boolean().optional(),
        evidence: Evidence.optional(),
      },
    },
    async (a) => {
      const base = ctx.shots.get(a.shot);
      let shot;
      if (!a.fresh) {
        shot = await applyOps(ctx, base, [{ op: 'crop', rect: a.rect, padding: a.padding ?? 0 }], { label: a.label });
      } else {
        const ci = base.captureInfo;
        if (base.kind !== 'screen' || base.parent || ci?.screenX == null || ci?.screenY == null) {
          throw new Error('fresh=true needs a direct screen shot with screen origin metadata. Use fresh=false for a derived/window shot, or capture the relevant screen first.');
        }
        const pad = a.padding ?? 0;
        const x0 = Math.max(0, Math.floor(a.rect.x - pad));
        const y0 = Math.max(0, Math.floor(a.rect.y - pad));
        const x1 = Math.min(base.width, Math.ceil(a.rect.x + a.rect.w + pad));
        const y1 = Math.min(base.height, Math.ceil(a.rect.y + a.rect.h + pad));
        if (x1 - x0 < 2 || y1 - y0 < 2) throw new Error('rect is empty after clamping to the source shot.');
        const { id, file } = ctx.shots.allocate(a.label || base.label);
        const cap = (await ctx.worker.call('capture_rect', {
          x: ci.screenX + x0,
          y: ci.screenY + y0,
          width: x1 - x0,
          height: y1 - y0,
          out: file,
        })).capture;
        shot = ctx.shots.add({
          id,
          file,
          width: cap.Width,
          height: cap.Height,
          kind: 'screen',
          label: a.label || base.label,
          source: { derivedFrom: base.id, liveRecapture: true },
          captureInfo: captureInfo(cap, 'region'),
        });
      }
      const text = [describeShot(shot), `source shot: ${base.id}${a.fresh ? ' (fresh live re-capture)' : ' (pixel crop)'}`];
      if (a.with_text) {
        const ocr = await ctx.shots.ocr(shot.id);
        text.push(`OCR (${ocr.lines.length} lines, [x,y,w,h] in ${shot.id} pixels):\n${formatOcrLines(ocr.lines)}`);
      }
      const ev = saveEvidence(ctx, shot, a.evidence, { command: base.command });
      if (ev) text.push(`saved evidence ${describeEvidence(ev)}`);
      return { content: [{ type: 'text', text: text.join('\n') }, ...(await imageBlock(ctx, shot.id, !!a.grid))] };
    },
  );

  tool(
    server,
    ctx,
    'refine_capture',
    {
      title: 'Crop by OCR anchor and verify the result',
      description:
        'Find an OCR anchor in a shot, crop its line or a line range ending at to_text, then verify required text exists in the result. This verifies readable text only; the agent must still judge the visual/semantic target.',
      inputSchema: {
        shot: z.string(),
        anchor: Anchor,
        to_text: z.string().optional().describe('End the crop at the first matching OCR line after the anchor.'),
        full_width: z.boolean().optional().describe('Keep full shot width (default true).'),
        padding: z.number().min(0).optional(),
        verify: z
          .object({
            must_include: z.array(z.string()).min(1).optional().describe('Each string must occur in the cropped OCR.'),
            min_matches: z.number().int().min(1).optional().describe('Minimum total required-text matches (default 1).'),
          })
          .optional(),
        label: z.string().optional(),
        with_text: z.boolean().optional(),
        grid: z.boolean().optional(),
        evidence: Evidence.optional(),
      },
    },
    async (a) => {
      const base = ctx.shots.get(a.shot);
      const baseOcr = await ctx.shots.ocr(base.id);
      const hits = findText(baseOcr.lines, { text: a.anchor.text, regex: a.anchor.regex });
      if (!hits.length) throw new Error(`anchor not found in ${base.id}. Use view_shot with_text=true to inspect OCR before retrying.`);
      const hit = a.anchor.occurrence === 'first' ? hits[0] : hits[hits.length - 1];
      let endLine = hit.lineIndex;
      if (a.to_text) {
        const endHit = findText(baseOcr.lines, { text: a.to_text }).find((h) => h.lineIndex >= hit.lineIndex);
        if (!endHit) throw new Error(`to_text "${a.to_text}" was not found after the anchor.`);
        endLine = endHit.lineIndex;
      }
      const shot = await applyOps(ctx, base, [{
        op: 'crop',
        lines: [hit.lineIndex + 1, endLine + 1],
        full_width: a.full_width ?? true,
        padding: a.padding,
      }], { label: a.label });
      const ocr = await ctx.shots.ocr(shot.id);
      const required = a.verify?.must_include ?? (a.anchor.text ? [a.anchor.text] : []);
      const check = required.length ? verification(ocr, required, a.verify?.min_matches ?? 1) : { verified: true, matches: [], total: 0 };
      const text = [describeShot(shot), `anchor: ${hit.text} (line ${hit.lineIndex + 1} of ${base.id})`, `verified: ${check.verified}`, `verification: ${JSON.stringify(check.matches)}`];
      if (a.with_text) text.push(`OCR (${ocr.lines.length} lines, [x,y,w,h] in ${shot.id} pixels):\n${formatOcrLines(ocr.lines)}`);
      if (a.evidence && !check.verified) text.push('evidence not saved because verification failed.');
      else {
        const ev = saveEvidence(ctx, shot, a.evidence, { command: base.command });
        if (ev) text.push(`saved evidence ${describeEvidence(ev)}`);
      }
      return { content: [{ type: 'text', text: text.join('\n') }, ...(await imageBlock(ctx, shot.id, !!a.grid))] };
    },
  );

  tool(
    server,
    ctx,
    'open_terminal',
    {
      title: 'Open a real terminal window',
      description:
        'Open a new, visible terminal window (Windows Terminal or classic console) running PowerShell, cmd or WSL, and return a session id. Input goes straight into its console buffer (no focus stealing, immune to IMEs) and output is read exactly. Pass ssh="user@host" to connect right away (if a password is requested, ask the user to type it in the window).',
      inputSchema: {
        shell: z.enum(['powershell', 'pwsh', 'cmd', 'wsl']).optional().describe('Default powershell.'),
        host: z.enum(['auto', 'wt', 'conhost']).optional().describe('wt = Windows Terminal (modern look), conhost = classic console. Default auto (wt if installed).'),
        cwd: z.string().optional().describe('Working directory.'),
        title: z.string().optional().describe('Fixed window title (shows in screenshots).'),
        name: z.string().optional().describe('Friendly session name.'),
        cols: z.number().optional().describe('Windows Terminal columns (with rows).'),
        rows: z.number().optional().describe('Windows Terminal rows (with cols).'),
        width: z.number().optional().describe('Window width in px.'),
        height: z.number().optional().describe('Window height in px.'),
        x: z.number().optional(),
        y: z.number().optional(),
        ssh: z.string().optional().describe('Run `ssh <value>` after opening, e.g. "student@10.0.0.5" or "-p 2222 user@host".'),
        prompt_regex: z.string().optional().describe('Custom prompt regex if the shell prompt is unusual.'),
      },
    },
    async (a) => {
      const s = await ctx.sessions.open(a);
      const win = await ctx.sessions.windowInfo(s);
      const lines = [`Opened ${describeSession(s, win)}`, s.ready ? `ready · prompt: ${s.lastPrompt || '?'}` : 'warning: no shell prompt detected yet (the machine may be slow); run_command will still wait for completion.'];
      if (a.ssh) {
        const r = await runCommand(ctx, s, { command: `ssh ${a.ssh}`, timeout_ms: 30_000, settle_ms: 800 });
        lines.push(`ssh ${a.ssh}: ${r.status}${r.awaiting ? ` - "${r.awaiting.line}"` : ''}`);
        if (r.awaiting) lines.push(AWAIT_HINTS[r.awaiting.kind]);
        lines.push(formatOutput(r.screenTail.slice(-8), 8));
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  tool(
    server,
    ctx,
    'attach_window',
    {
      title: 'Attach to an existing window',
      description:
        'Turn an already open window (MobaXterm/PuTTY SSH tab, VS Code, a classic console, any app) into a session so you can run commands in it and capture it. Classic consoles get exact console I/O; other apps use clipboard paste (Shift+Insert) and OCR.',
      inputSchema: {
        handle: z.number().optional().describe('Window handle from list_windows (most precise).'),
        title: z.string().optional().describe('Title substring.'),
        process: z.string().optional().describe('Process name, e.g. "MobaXterm" or "putty".'),
        index: z.number().optional().describe('Pick among several matches.'),
        name: z.string().optional(),
        console_pid: z.number().optional().describe('PID of the shell inside it, if known (enables exact console text).'),
        input_method: z.enum(['paste', 'type']).optional().describe('How to enter text in non-console apps (default paste).'),
        paste_chord: z.string().optional().describe('Paste shortcut for the app (default "shift+insert"; e.g. "ctrl+shift+v").'),
        prompt_regex: z.string().optional(),
      },
    },
    async (a) => {
      const s = await ctx.sessions.attach(a);
      const win = await ctx.sessions.windowInfo(s);
      return { content: [{ type: 'text', text: `Attached ${describeSession(s, win)}` }] };
    },
  );

  tool(
    server,
    ctx,
    'manage_session',
    {
      title: 'Manage sessions',
      description: 'list / info / focus / resize / move / rename / close (close shuts a window you opened; detach forgets an attached window without closing it).',
      inputSchema: {
        action: z.enum(['list', 'info', 'focus', 'resize', 'move', 'rename', 'close', 'detach']),
        session: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        name: z.string().optional(),
      },
    },
    async (a) => {
      if (a.action === 'list') {
        const rows = [];
        for (const s of ctx.sessions.list()) {
          let win = null;
          try {
            win = await ctx.sessions.windowInfo(s);
          } catch {
            // closed
          }
          rows.push(describeSession(s, win));
        }
        return { content: [{ type: 'text', text: rows.join('\n') || 'No sessions. Use open_terminal or attach_window.' }] };
      }
      const s = ctx.sessions.get(a.session);
      switch (a.action) {
        case 'focus':
          return { content: [{ type: 'text', text: `focus: ${(await ctx.worker.call('focus', { handle: s.handle })).method}` }] };
        case 'resize':
        case 'move': {
          const r = await ctx.worker.call('move', { handle: s.handle, x: a.x ?? null, y: a.y ?? null, width: a.width || 0, height: a.height || 0 });
          return { content: [{ type: 'text', text: describeSession(s, r.window) }] };
        }
        case 'rename':
          s.name = a.name || s.name;
          return { content: [{ type: 'text', text: `renamed ${s.id} → ${s.name}` }] };
        case 'close':
          if (s.kind === 'attached') {
            ctx.sessions.sessions.delete(s.id);
            return { content: [{ type: 'text', text: `Detached ${s.id} (an attached window is never closed by AutoShot).` }] };
          }
          await ctx.sessions.close(s);
          return { content: [{ type: 'text', text: `Closed ${s.id}.` }] };
        case 'detach':
          ctx.sessions.sessions.delete(s.id);
          return { content: [{ type: 'text', text: `Detached ${s.id}.` }] };
        default: {
          const win = await ctx.sessions.windowInfo(s);
          return { content: [{ type: 'text', text: describeSession(s, win) }] };
        }
      }
    },
  );

  tool(
    server,
    ctx,
    'run_command',
    {
      title: 'Run a command (and capture it)',
      description:
        'Type a command into a session, press Enter and wait until it has really finished (prompt returned, `expect` regex seen, input requested, or timeout). Returns the output text. With capture="block" the screenshot is auto-cropped to exactly prompt+command+output; "block_titled" keeps the window title bar on top; "content" = whole window minus empty space; "window" = full window. Add ops to annotate/redact in the same call and evidence={caption} to save it for the report.',
      inputSchema: {
        session: z.string(),
        command: z.string().describe('Exact command line to type (single line).'),
        capture: z.enum(['none', 'block', 'block_titled', 'content', 'window']).optional().describe('Default none.'),
        clear_before: z.boolean().optional().describe('Clear the screen first for a clean, focused shot.'),
        expect: z.string().optional().describe('Regex that signals completion (for commands that do not return to a prompt, e.g. servers, `tail -f`).'),
        timeout_ms: z.number().optional().describe('Default 45000.'),
        settle_ms: z.number().optional().describe('How long the screen must stay unchanged (default 600).'),
        include_prompt: z.boolean().optional().describe('Include the fresh prompt line below the output in the crop.'),
        ops: z.array(Op).optional().describe('Extra edit ops applied after the auto-crop (coordinates = the full window shot).'),
        label: z.string().optional().describe('File name hint.'),
        evidence: Evidence.optional(),
        max_output_lines: z.number().optional().describe('Lines of output text to return (default 60).'),
      },
    },
    async (a) => {
      const s = ctx.sessions.get(a.session);
      const r = await runCommand(ctx, s, { ...a, ops: normOccurrence(a.ops) });
      const head = {
        done: '✔ finished',
        expect: '✔ expected text appeared',
        awaiting: '⏸ waiting for input',
        timeout: '⌛ still running (timeout reached)',
      }[r.status];
      const text = [
        `${head} after ${(r.elapsedMs / 1000).toFixed(1)}s · session ${s.id} · text: ${r.source === 'console' ? 'exact console buffer' : 'OCR (may contain small misreads)'}`,
      ];
      if (r.awaiting) text.push(`prompt: "${r.awaiting.line}"\n→ ${AWAIT_HINTS[r.awaiting.kind]}`);
      if (r.status === 'timeout') {
        text.push('The command has not finished. Call wait_for to keep waiting, or send_input keys=["ctrl+c"] to stop it.');
        text.push(`screen tail:\n${formatOutput(r.screenTail, 12)}`);
      } else {
        text.push(`output (${r.output.length} line${r.output.length === 1 ? '' : 's'}):\n${formatOutput(r.output, a.max_output_lines ?? 60)}`);
      }
      if (r.truncatedTop && r.status === 'done') text.push('note: the command line itself is no longer on screen (output longer than the window or screen cleared).');
      for (const n of r.notes) text.push(`note: ${n}`);
      const content = [];
      if (r.shot) {
        text.push(`${describeShot(r.shot)}${r.baseShot && r.baseShot !== r.shot ? `\n  full window: ${r.baseShot.id}` : ''}`);
        const ev = saveEvidence(ctx, r.shot, a.evidence, { command: a.command, output: r.output });
        if (ev) text.push(`saved evidence ${describeEvidence(ev)}`);
      }
      content.push({ type: 'text', text: text.join('\n') });
      if (r.shot) content.push(...(await imageBlock(ctx, r.shot.id)));
      return { content };
    },
  );

  tool(
    server,
    ctx,
    'send_input',
    {
      title: 'Send text / keys',
      description:
        'Low-level input for interactive programs: type text and/or press keys (e.g. ["enter"], ["ctrl+c"], ["y","enter"], ["q"], ["up"], ["tab"]). Returns the screen tail afterwards. Never use it to type passwords.',
      inputSchema: {
        session: z.string(),
        text: z.string().optional(),
        keys: z.array(z.string()).optional().describe('Pressed after the text. Chords like "ctrl+c", "shift+tab", "alt+f4" are allowed.'),
        enter: z.boolean().optional().describe('Press Enter after text/keys.'),
        method: z.enum(['console', 'type', 'paste']).optional().describe('Override the input method.'),
        wait_ms: z.number().optional().describe('Wait before reading the screen back (default 500).'),
      },
    },
    async (a) => {
      const s = ctx.sessions.get(a.session);
      const steps = [];
      if (a.text) steps.push({ text: a.text });
      const keys = [...(a.keys || []), ...(a.enter ? ['enter'] : [])];
      if (keys.length) steps.push({ keys });
      if (!steps.length) throw new Error('Nothing to send: give text and/or keys.');
      const r = await ctx.sessions.input(s, steps, { method: a.method });
      await new Promise((res) => setTimeout(res, a.wait_ms ?? 500));
      const t = await ctx.sessions.readText(s);
      const tail = t.lines.filter((l) => l.trim()).slice(-12);
      return { content: [{ type: 'text', text: `sent via ${r.method}.\nscreen tail:\n${formatOutput(tail, 12)}` }] };
    },
  );

  tool(
    server,
    ctx,
    'wait_for',
    {
      title: 'Wait for the terminal',
      description:
        'Wait until a session shows a prompt again (default) or text matching `text` (regex), e.g. after the user typed a password, or for a long build. Returns status and the screen tail.',
      inputSchema: {
        session: z.string(),
        text: z.string().optional().describe('Regex to wait for.'),
        timeout_ms: z.number().optional().describe('Default 60000.'),
        settle_ms: z.number().optional(),
      },
    },
    async (a) => {
      const s = ctx.sessions.get(a.session);
      const r = await waitFor(ctx, s, { expect: a.text, timeoutMs: a.timeout_ms ?? 60_000, settleMs: a.settle_ms ?? 600 });
      const tail = (r.text?.lines ?? []).filter((l) => l.trim()).slice(-15);
      const extra = r.analysis?.awaiting ? `\nprompt: "${r.analysis.awaiting.line}" → ${AWAIT_HINTS[r.analysis.awaiting.kind]}` : '';
      return { content: [{ type: 'text', text: `${r.status} after ${(r.elapsedMs / 1000).toFixed(1)}s${extra}\nscreen tail:\n${formatOutput(tail, 15)}` }] };
    },
  );

  tool(
    server,
    ctx,
    'read_screen',
    {
      title: 'Read screen text',
      description:
        'Read what a session shows right now as text: exact console text for managed sessions, OCR otherwise (with_boxes adds pixel boxes). Cheap way to check state without an image.',
      inputSchema: {
        session: z.string(),
        with_boxes: z.boolean().optional().describe('OCR only: include [x,y,w,h] per line.'),
        scrollback: z.number().optional().describe('Classic console only: extra lines above the visible area.'),
        max_lines: z.number().optional().describe('Default 80 (last lines).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const s = ctx.sessions.get(a.session);
      const t = await ctx.sessions.readText(s, { extra: a.scrollback || 0 });
      const max = a.max_lines ?? 80;
      let body;
      if (t.source === 'ocr' && a.with_boxes) body = formatOcrLines(t.ocrLines.slice(-max), { max });
      else {
        const lines = t.lines.slice(0, (t.cursorRow ?? t.lines.length - 1) + 1);
        body = lines.slice(-max).join('\n');
      }
      return { content: [{ type: 'text', text: `source: ${t.source === 'console' ? 'exact console buffer' : 'OCR'}${t.title ? ` · title "${t.title}"` : ''}\n${body}` }] };
    },
  );

  tool(
    server,
    ctx,
    'capture',
    {
      title: 'Capture a screenshot',
      description:
        'Capture a session, any window (handle/title/process), a monitor, or a screen region. Window method auto prefers PrintWindow (works when covered); method screen captures visible desktop pixels for better fidelity in browsers/apps but includes anything overlapping the window and may bring it to foreground. Returns a shot id + preview; with_text adds OCR lines (L01..) with pixel boxes so you can crop/annotate precisely; grid overlays pixel rulers on the preview. Optional ops are applied immediately; evidence saves the result.',
      inputSchema: {
        session: z.string().optional(),
        handle: z.number().optional(),
        title: z.string().optional(),
        process: z.string().optional(),
        screen: z.number().optional().describe('Monitor index (see list_windows); -1 = all monitors.'),
        region: Rect.optional().describe('Absolute screen rectangle.'),
        method: z.enum(['auto', 'screen', 'print']).optional().describe('Window capture method. screen captures visible desktop pixels and works best for visible browser/app windows; it may include overlapping windows. auto prefers PrintWindow and falls back to screen.'),
        area: z.enum(['window', 'client']).optional().describe('window = with title bar (default), client = content only.'),
        with_text: z.boolean().optional().describe('Return OCR lines with boxes (default false).'),
        grid: z.boolean().optional().describe('Draw a pixel grid on the preview.'),
        ops: z.array(Op).optional(),
        label: z.string().optional(),
        evidence: Evidence.optional(),
      },
    },
    async (a) => {
      const target = await resolveCaptureTarget(ctx, a);
      let base;
      if (target.session) base = await captureSession(ctx, target.session, { label: a.label, area: a.area || 'window', method: a.method || 'auto' });
      else {
        const { id, file } = ctx.shots.allocate(a.label);
        let cap;
        let source = {};
        if (target.window) {
          cap = (await ctx.worker.call('capture_window', { handle: target.window.Handle, area: a.area || 'window', method: a.method || 'auto', out: file })).capture;
          source = { handle: target.window.Handle, title: target.window.Title, className: target.window.ClassName, process: target.window.Process };
        } else if (target.region) {
          cap = (await ctx.worker.call('capture_rect', { x: target.region.x, y: target.region.y, width: target.region.w, height: target.region.h, out: file })).capture;
        } else {
          cap = (await ctx.worker.call('capture_screen', { index: target.screen, out: file })).capture;
        }
        base = ctx.shots.add({
          id,
          file,
          width: cap.Width,
          height: cap.Height,
          kind: target.window ? 'window' : 'screen',
          label: a.label,
          source,
          captureInfo: captureInfo(cap, a.area || 'window'),
        });
      }
      const final = a.ops?.length ? await applyOps(ctx, base, normOccurrence(a.ops), { label: a.label }) : base;
      const text = [describeShot(final)];
      if (final !== base) text.push(`  base capture: ${base.id}`);
      if (a.with_text) {
        const ocr = await ctx.shots.ocr(final.id);
        text.push(`OCR (${ocr.lines.length} lines, [x,y,w,h] in ${final.id} pixels):\n${formatOcrLines(ocr.lines)}`);
      }
      const ev = saveEvidence(ctx, final, a.evidence);
      if (ev) text.push(`saved evidence ${describeEvidence(ev)}`);
      return { content: [{ type: 'text', text: text.join('\n') }, ...(await imageBlock(ctx, final.id, !!a.grid))] };
    },
  );

  tool(
    server,
    ctx,
    'view_shot',
    {
      title: 'View a shot',
      description: 'Look at an existing shot again: preview (optionally with a pixel grid) and/or its OCR lines with boxes. Use before cropping by rect or line numbers.',
      inputSchema: {
        shot: z.string(),
        grid: z.boolean().optional(),
        with_text: z.boolean().optional().describe('Default true.'),
        image: z.boolean().optional().describe('Default true.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const shot = ctx.shots.get(a.shot);
      const text = [describeShot(shot)];
      if (a.with_text !== false) {
        const ocr = await ctx.shots.ocr(shot.id);
        text.push(`OCR (${ocr.lines.length} lines, [x,y,w,h]):\n${formatOcrLines(ocr.lines)}`);
      }
      return { content: [{ type: 'text', text: text.join('\n') }, ...(a.image === false ? [] : await imageBlock(ctx, shot.id, !!a.grid))] };
    },
  );

  tool(
    server,
    ctx,
    'edit_shot',
    {
      title: 'Crop / annotate / redact',
      description:
        'Apply ops in order to a shot and get a NEW shot (the original is kept). Examples: {"op":"crop","from_text":"ipconfig","to_text":"Default Gateway"} · {"op":"crop","lines":[3,9]} · {"op":"highlight","text":"192.168.1.10"} · {"op":"box","regex":"active \\\\(running\\\\)","label":"running"} · {"op":"redact","preset":"password_value"} · {"op":"trim"} · {"op":"frame"}. All coordinates are pixels of the input shot.',
      inputSchema: {
        shot: z.string(),
        ops: z.array(Op).min(1),
        label: z.string().optional(),
        with_text: z.boolean().optional().describe('Return OCR lines of the result.'),
        grid: z.boolean().optional(),
        evidence: Evidence.optional(),
      },
    },
    async (a) => {
      const base = ctx.shots.get(a.shot);
      const shot = await applyOps(ctx, base, normOccurrence(a.ops), { label: a.label });
      const text = [describeShot(shot)];
      if (a.with_text) {
        const ocr = await ctx.shots.ocr(shot.id);
        text.push(`OCR:\n${formatOcrLines(ocr.lines)}`);
      }
      const ev = saveEvidence(ctx, shot, a.evidence, { command: base.command });
      if (ev) text.push(`saved evidence ${describeEvidence(ev)}`);
      return { content: [{ type: 'text', text: text.join('\n') }, ...(await imageBlock(ctx, shot.id, !!a.grid))] };
    },
  );

  tool(
    server,
    ctx,
    'save_evidence',
    {
      title: 'Save as evidence',
      description: 'Add a shot to the report evidence list (copied to <output>/evidence/NN-name.png) with a caption. replace=<evidence id> swaps the image of an existing item.',
      inputSchema: {
        shot: z.string(),
        caption: z.string(),
        section: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        replace: z.string().optional(),
      },
    },
    async (a) => {
      const shot = ctx.shots.get(a.shot);
      const item = ctx.evidence.add(shot, { caption: a.caption, section: a.section, name: a.name, description: a.description, replace: a.replace, command: shot.command });
      return { content: [{ type: 'text', text: `saved ${describeEvidence(item)}\n(total ${ctx.evidence.list().length} item(s); file ${ctx.evidence.absPath(item)})` }] };
    },
  );

  tool(
    server,
    ctx,
    'manage_evidence',
    {
      title: 'Manage evidence list',
      description: 'list / update (caption, section, description) / remove / reorder (ids in the wanted order) / clear (needs confirm=true).',
      inputSchema: {
        action: z.enum(['list', 'update', 'remove', 'reorder', 'clear']),
        id: z.string().optional(),
        caption: z.string().optional(),
        section: z.string().optional(),
        description: z.string().optional(),
        order: z.array(z.string()).optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (a) => {
      let msg = '';
      switch (a.action) {
        case 'update':
          msg = `updated ${describeEvidence(ctx.evidence.update(a.id, a))}\n`;
          break;
        case 'remove':
          msg = `removed ${describeEvidence(ctx.evidence.remove(a.id))}\n`;
          break;
        case 'reorder':
          if (!a.order?.length) throw new Error('reorder needs order=[ids]');
          ctx.evidence.reorder(a.order);
          msg = 'reordered\n';
          break;
        case 'clear':
          if (!a.confirm) throw new Error('clear deletes every evidence item and its image copy; pass confirm=true to proceed.');
          ctx.evidence.clear();
          msg = 'cleared\n';
          break;
        default:
          break;
      }
      const items = ctx.evidence.list();
      return { content: [{ type: 'text', text: `${msg}${items.length} evidence item(s) in ${ctx.cfg.outputDir}:\n${items.map(describeEvidence).join('\n') || '(none)'}` }] };
    },
  );

  tool(
    server,
    ctx,
    'build_report',
    {
      title: 'Build the report',
      description:
        'Assemble saved evidence into a report: a new docx (default), markdown or html, or insert into the user\'s existing .docx (template) - after/before/replacing the paragraph that contains an anchor text, or at {{e1}} placeholder paragraphs; with neither, images are appended. Captions are numbered ("<caption_prefix> N: caption").',
      inputSchema: {
        format: z.enum(['docx', 'markdown', 'html']).optional(),
        output: z.string().optional().describe('Output file path (default <output dir>/report.<ext>).'),
        title: z.string().optional(),
        subtitle: z.string().optional(),
        author: z.string().optional(),
        date: z.string().optional(),
        lang: z.string().optional().describe('html lang attribute'),
        caption_prefix: z.string().optional().describe('Default "Figure"; e.g. "Hình" for Vietnamese.'),
        start_number: z.number().optional(),
        include_commands: z.boolean().optional().describe('Show the command above each image.'),
        include_output: z.boolean().optional().describe('Add the output text below each image.'),
        evidence: z.array(z.string()).optional().describe('Subset / order of evidence ids (default: all in list order).'),
        image_max_width: z.number().optional().describe('Max image width in px (default 600 ≈ page width).'),
        embed_images: z.boolean().optional().describe('html: embed images (default true).'),
        template: z.string().optional().describe('Existing .docx to insert into (a copy is written to output).'),
        placements: z
          .array(
            z.object({
              anchor: z.string().describe('Text of the paragraph to anchor to (e.g. a question heading).'),
              evidence: z.array(z.string()),
              position: z.enum(['after', 'before', 'replace']).optional(),
              occurrence: z.string().optional().describe('"first" (default), "last" or a number'),
            }),
          )
          .optional(),
        overwrite_template: z.boolean().optional(),
      },
    },
    async (a) => {
      const placements = a.placements?.map((p) => ({ ...p, occurrence: p.occurrence && /^\d+$/.test(p.occurrence) ? Number(p.occurrence) : p.occurrence }));
      const r = await buildReport(ctx, { ...a, placements });
      return {
        content: [{ type: 'text', text: `Report written: ${r.path}\nformat ${r.format} · ${r.count} image(s)${r.inserted ? ` · inserted: ${r.inserted.join(', ')}` : ''}` }],
      };
    },
  );

  server.registerPrompt(
    'evidence_report',
    {
      title: 'Screenshot evidence report',
      description: 'Plan and execute a task in real terminals, capture only the screenshots that prove each step, and build the report.',
      argsSchema: {
        task: z.string().optional().describe('The task or the path of the document describing it.'),
        format: z.string().optional().describe('docx (default), markdown, html, or "insert into <file.docx>".'),
        language: z.string().optional().describe('Report language, e.g. Vietnamese.'),
      },
    },
    ({ task, format, language }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: EVIDENCE_PROMPT({ task, format, language }) } }],
    }),
  );

  return server;
}
