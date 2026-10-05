import fs from 'node:fs';
import path from 'node:path';
import { fold, similarity, slug, windowSimilarity } from './text.js';

// Every capture / edit result is a "shot" with a short id (s1, s2, ...). Derived shots keep
// the affine transform from their parent so OCR can be re-used instead of recomputed.
export class ShotStore {
  constructor(cfg, worker) {
    this.cfg = cfg;
    this.worker = worker;
    this.shots = new Map();
    this.ocrCache = new Map();
    this.seq = 0;
    this.indexPath = path.join(cfg.shotsDir, 'index.json');
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    fs.mkdirSync(path.join(this.cfg.shotsDir, 'previews'), { recursive: true });
    fs.mkdirSync(path.join(this.cfg.shotsDir, 'tmp'), { recursive: true });
    try {
      const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      this.seq = data.seq || 0;
      for (const s of data.shots || []) if (fs.existsSync(s.file)) this.shots.set(s.id, s);
    } catch {
      // fresh store
    }
  }

  persist() {
    const data = { seq: this.seq, shots: [...this.shots.values()] };
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 1));
  }

  allocate(label) {
    this.load();
    const id = `s${++this.seq}`;
    const file = path.join(this.cfg.shotsDir, `${id}${label ? '-' + slug(label, 32) : ''}.png`);
    return { id, file };
  }

  tmpFile(tag = 'tmp') {
    this.load();
    return path.join(this.cfg.shotsDir, 'tmp', `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  }

  add(meta) {
    this.load();
    const shot = { createdAt: new Date().toISOString(), ...meta };
    this.shots.set(shot.id, shot);
    this.persist();
    return shot;
  }

  get(id) {
    this.load();
    const key = String(id ?? '').trim();
    const shot = this.shots.get(key) || this.shots.get(`s${key}`);
    if (!shot) {
      const recent = [...this.shots.keys()].slice(-8).join(', ') || 'none yet';
      throw new Error(`Unknown shot '${id}'. Recent shots: ${recent}. Create one with capture or run_command(capture=...).`);
    }
    return shot;
  }

  /** OCR lines ({t, b:[x,y,w,h], w:[[text,x,y,w,h]...]}) in this shot's pixel space. */
  async ocr(id) {
    const shot = this.get(id);
    if (this.ocrCache.has(shot.id)) return this.ocrCache.get(shot.id);
    let result;
    if (shot.parent && shot.transform && this.shots.has(shot.parent) && !shot.noOcrInherit) {
      const parent = await this.ocr(shot.parent);
      result = { ...parent, lines: transformLines(parent.lines, shot.transform, shot.width, shot.height), inherited: shot.parent };
    } else {
      // console shots only need OCR to align the grid; others get the dual pass for recall
      result = await ocrImage(this.worker, shot.file, this.cfg.ocrScale, shot.console?.lines?.length ? 'plain' : 'dual');
      result.source = 'ocr';
      if (shot.console?.lines?.length) {
        const grid = gridFromConsole(result.lines, shot.console.lines);
        if (grid) {
          // exact console text laid out on the fitted character grid; keep window chrome OCR (title bar)
          const chrome = result.lines.filter((l) => l.b[1] + l.b[3] < grid.originY - 2);
          result = { ...result, lines: sortLines([...chrome, ...grid.lines]), source: 'console-grid', grid: { pitch: grid.pitch, charWidth: grid.cw } };
        }
      }
    }
    this.ocrCache.set(shot.id, result);
    return result;
  }

  async preview(id, { grid = false } = {}) {
    const shot = this.get(id);
    const dst = path.join(this.cfg.shotsDir, 'previews', `${shot.id}${grid ? '-grid' : ''}.png`);
    const r = await this.worker.call('preview', { src: shot.file, dst, maxWidth: this.cfg.previewMax, maxHeight: this.cfg.previewMax, grid });
    return { data: fs.readFileSync(dst).toString('base64'), scale: r.scale, file: dst };
  }
}

export function sortLines(lines) {
  // Windows OCR returns lines roughly in reading order but may interleave columns; sort
  // top-to-bottom, then left-to-right for lines sharing a baseline.
  return [...lines].sort((a, b) => {
    const dy = a.b[1] - b.b[1];
    const tol = Math.max(4, Math.min(a.b[3], b.b[3]) * 0.5);
    if (Math.abs(dy) > tol) return dy;
    return a.b[0] - b.b[0];
  });
}

function overlapRatio(a, b) {
  const x0 = Math.max(a[1], b[1]);
  const y0 = Math.max(a[2], b[2]);
  const x1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const y1 = Math.min(a[2] + a[4], b[2] + b[4]);
  if (x1 <= x0 || y1 <= y0) return 0;
  return ((x1 - x0) * (y1 - y0)) / Math.max(1, Math.min(a[3] * a[4], b[3] * b[4]));
}

/**
 * OCR an image. 'dual' = plain pass (accurate glyphs) + binarized pass (finds coloured /
 * dim text that the plain pass skips); binarized words are only added where the plain pass
 * found nothing, because binarization tends to misread digits.
 */
export async function ocrImage(worker, file, scale, mode = 'dual') {
  const plain = (await worker.call('ocr', { path: file, scale, binarize: false }, { timeoutMs: 90_000 })).ocr;
  let lines = plain.lines || [];
  if (mode === 'dual') {
    const bin = (await worker.call('ocr', { path: file, scale, binarize: true }, { timeoutMs: 90_000 })).ocr;
    const known = lines.flatMap((l) => l.w);
    for (const l of bin.lines || []) {
      const fresh = l.w.filter((w) => !known.some((k) => overlapRatio(k, w) > 0.25));
      if (fresh.length) lines = [...lines, { t: fresh.map((w) => w[0]).join(' '), b: boxOf(fresh), w: fresh }];
    }
  }
  return { ...plain, lines: mergeRows(lines) };
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function boxOf(words) {
  const x0 = Math.min(...words.map((w) => w[1]));
  const y0 = Math.min(...words.map((w) => w[2]));
  const x1 = Math.max(...words.map((w) => w[1] + w[3]));
  const y1 = Math.max(...words.map((w) => w[2] + w[4]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * Windows OCR often splits one terminal row into fragments ("PS C: ping" + "t 127.0.0.1").
 * Merge fragments that share a baseline and are not far apart horizontally into one row.
 */
export function mergeRows(lines) {
  const rows = [];
  for (const l of sortLines(lines)) {
    const cy = l.b[1] + l.b[3] / 2;
    const row = rows.find((r) => {
      if (Math.abs(r.cy - cy) > Math.max(4, Math.min(r.h, l.b[3]) * 0.45)) return false;
      const rx1 = Math.max(...r.parts.map((p) => p.b[0] + p.b[2]));
      const gap = l.b[0] - rx1;
      // OCR can drop a coloured word in the middle of a row, so allow wide gaps
      return gap < Math.max(r.h, l.b[3]) * 12;
    });
    if (row) row.parts.push(l);
    else rows.push({ cy, h: l.b[3], parts: [l] });
  }
  return sortLines(
    rows.map((r) => {
      if (r.parts.length === 1) return r.parts[0];
      const words = r.parts.flatMap((p) => p.w).sort((a, b) => a[1] - b[1]);
      return { t: words.map((w) => w[0]).join(' '), b: boxOf(words), w: words };
    }),
  );
}

function rowScore(ocrFold, conFold) {
  if (ocrFold.length < 4 || !conFold) return 0;
  if (conFold.includes(ocrFold)) return 0.95;
  return windowSimilarity(conFold, ocrFold);
}

/**
 * Align exact console rows with OCR rows of the same screenshot. Terminals draw a fixed
 * character grid, so a robust fit of row pitch / origin / char width turns the exact console
 * text into pixel-exact word boxes. Returns null when the alignment is not trustworthy.
 */
export function gridFromConsole(ocrRows, consoleLines) {
  const folded = consoleLines.map((l) => fold(l));
  const pairs = [];
  let last = -1;
  for (const r of ocrRows) {
    const t = fold(r.t);
    let best = -1;
    let bestS = 0;
    for (let i = last + 1; i < Math.min(consoleLines.length, last + 12); i++) {
      const s = rowScore(t, folded[i]);
      if (s > bestS + 0.02) {
        bestS = s;
        best = i;
      }
    }
    if (best >= 0 && bestS >= 0.72) {
      pairs.push({ row: best, r });
      last = best;
    }
  }
  if (pairs.length < 3) return null;
  const ratios = [];
  for (let i = 1; i < pairs.length; i++) {
    const dr = pairs[i].row - pairs[i - 1].row;
    if (dr > 0) ratios.push((pairs[i].r.b[1] - pairs[i - 1].r.b[1]) / dr);
  }
  const pitch = median(ratios);
  if (!(pitch > 6 && pitch < 90)) return null;
  const b = median(pairs.map((p) => p.r.b[1] - pitch * p.row));
  const fit = pairs.filter((p) => Math.abs(p.r.b[1] - (b + pitch * p.row)) <= pitch * 0.4);
  if (fit.length < Math.max(3, pairs.length * 0.6)) return null;

  // character width + x origin from rows whose OCR text covers the whole console row
  const cws = [];
  const x0s = [];
  for (const p of fit) {
    const line = consoleLines[p.row];
    const len = line.trim().length;
    if (len >= 4 && rowScore(fold(p.r.t), fold(line)) >= 0.85 && similarity(fold(p.r.t), fold(line)) >= 0.8) cws.push(p.r.b[2] / len);
  }
  let cw = median(cws);
  if (!(cw > 3 && cw < 40)) {
    const wordCw = fit.flatMap((p) => p.r.w.filter((w) => w[0].length >= 3).map((w) => w[3] / w[0].length));
    cw = median(wordCw);
  }
  if (!(cw > 3 && cw < 40)) return null;
  for (const p of fit) {
    const line = consoleLines[p.row];
    const lead = line.length - line.trimStart().length;
    x0s.push(p.r.b[0] - lead * cw);
  }
  const x0 = median(x0s);
  const h = Math.round(median(fit.map((p) => p.r.b[3])));
  const lines = [];
  consoleLines.forEach((line, row) => {
    if (!line.trim()) return;
    const y = Math.round(b + pitch * row);
    const words = [];
    for (const m of line.matchAll(/\S+/g)) {
      words.push([m[0], Math.round(x0 + m.index * cw), y, Math.max(1, Math.round(m[0].length * cw)), h]);
    }
    lines.push({ t: line.trimEnd().replace(/^\s+/, ''), b: boxOf(words), w: words, row });
  });
  return { lines, pitch, cw, originY: Math.round(b - (pitch - h) / 2) };
}

export function transformLines(lines, t, width, height) {
  const out = [];
  for (const line of lines) {
    const words = [];
    for (const w of line.w) {
      const x = w[1] * t.s + t.tx;
      const y = w[2] * t.s + t.ty;
      const ww = w[3] * t.s;
      const hh = w[4] * t.s;
      const cx = x + ww / 2;
      const cy = y + hh / 2;
      if (cx < 0 || cy < 0 || cx > width || cy > height) continue;
      words.push([w[0], Math.round(x), Math.round(y), Math.round(ww), Math.round(hh)]);
    }
    if (!words.length) continue;
    const x0 = Math.min(...words.map((w) => w[1]));
    const y0 = Math.min(...words.map((w) => w[2]));
    const x1 = Math.max(...words.map((w) => w[1] + w[3]));
    const y1 = Math.max(...words.map((w) => w[2] + w[4]));
    out.push({ t: words.map((w) => w[0]).join(' '), b: [x0, y0, x1 - x0, y1 - y0], w: words });
  }
  return sortLines(out);
}

/** Compose transforms: first `a` (orig -> mid), then `b` (mid -> final). */
export function composeTransform(a, b) {
  return { s: a.s * b.s, tx: a.tx * b.s + b.tx, ty: a.ty * b.s + b.ty };
}

export function describeShot(shot) {
  const parts = [`shot ${shot.id}`, `${shot.width}×${shot.height}px`];
  if (shot.kind) parts.push(shot.kind);
  if (shot.parent) parts.push(`from ${shot.parent}`);
  if (shot.source?.title) parts.push(`window "${shot.source.title}"`);
  const origin = shot.captureInfo?.screenX != null && shot.captureInfo?.screenY != null
    ? `\n  screen origin: (${shot.captureInfo.screenX},${shot.captureInfo.screenY}) absolute px`
    : '';
  return `${parts.join(' · ')}${origin}\n  file: ${shot.file}`;
}

export function formatOcrLines(lines, { max = 80 } = {}) {
  const out = lines.slice(0, max).map((l, i) => `L${String(i + 1).padStart(2, '0')} [${l.b.join(',')}] ${l.t}`);
  if (lines.length > max) out.push(`… ${lines.length - max} more lines`);
  return out.join('\n');
}
