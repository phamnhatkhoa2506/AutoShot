import fs from 'node:fs';
import { findText, fold, pickOccurrence, unionBoxes, windowSimilarity } from './text.js';
import { formatOcrLines } from './shots.js';

// Edit pipeline. Every coordinate the agent gives (rect, at, from) is in the pixel space of
// the INPUT shot - the same space as its OCR boxes and its preview grid. We keep the affine
// transform input->current so later ops still land correctly after crops/pads/scales.

const TEXT_KEYS = ['text', 'regex', 'preset', 'lines', 'line', 'from_text', 'to_text'];

export function opsNeedOcr(ops) {
  return ops.some((op) => TEXT_KEYS.some((k) => op[k] != null));
}

function lineBox(l) {
  return { x: l.b[0], y: l.b[1], w: l.b[2], h: l.b[3] };
}

function notFound(what, ocr) {
  const sample = ocr ? formatOcrLines(ocr.lines, { max: 30 }) : '(no OCR)';
  return new Error(`${what} not found in the image. OCR sees:\n${sample}\nAdjust the text (OCR may misread characters), use regex, lines, or a rect.`);
}

function toCur(box, geo) {
  const { s, tx, ty } = geo.t;
  return { x: box.x * s + tx, y: box.y * s + ty, w: box.w * s, h: box.h * s };
}

function clampBox(b, geo) {
  const x0 = Math.max(0, Math.round(b.x));
  const y0 = Math.max(0, Math.round(b.y));
  const x1 = Math.min(geo.w, Math.round(b.x + b.w));
  const y1 = Math.min(geo.h, Math.round(b.y + b.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

function grow(b, p) {
  return { x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p };
}

/** Line indices containing `text`: exact matches if any, otherwise only the best fuzzy matches. */
function lineIndices(ocr, text) {
  const raw = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const plain = [];
  ocr.lines.forEach((l, i) => {
    if (l.t.toLowerCase().replace(/\s+/g, ' ').includes(raw)) plain.push(i);
  });
  if (plain.length) return plain;
  const target = fold(text);
  const folded = [];
  ocr.lines.forEach((l, i) => {
    if (fold(l.t).includes(target)) folded.push(i);
  });
  if (folded.length) return folded;
  const scored = ocr.lines.map((l, i) => ({ i, s: windowSimilarity(fold(l.t), target) })).filter((x) => x.s >= 0.8);
  if (!scored.length) return [];
  const best = Math.max(...scored.map((x) => x.s));
  return scored.filter((x) => x.s >= best - 0.01).map((x) => x.i);
}

/** Clamp a full-width line band so it stops half-way into the gaps to the neighbouring lines. */
function clampToNeighbours(ocr, fromIdx, toIdx, box, geo) {
  const lines = ocr.lines;
  const first = lines[fromIdx];
  const last = lines[toIdx];
  const prev = lines.slice(0, fromIdx).filter((l) => l.b[1] + l.b[3] <= first.b[1]).pop();
  const next = lines.slice(toIdx + 1).find((l) => l.b[1] >= last.b[1] + last.b[3]);
  let y0 = box.y;
  let y1 = box.y + box.h;
  if (prev) y0 = Math.max(y0, toCur({ x: 0, y: (prev.b[1] + prev.b[3] + first.b[1]) / 2, w: 0, h: 0 }, geo).y);
  if (next) y1 = Math.min(y1, toCur({ x: 0, y: (last.b[1] + last.b[3] + next.b[1]) / 2, w: 0, h: 0 }, geo).y);
  return { ...box, y: y0, h: Math.max(1, y1 - y0) };
}

/** All boxes an op targets, in CURRENT image coordinates. */
function resolveTargets(op, geo, ocr) {
  const boxes = [];
  if (op.rect) boxes.push(toCur(op.rect, geo));
  if (op.rect_pct) {
    const r = op.rect_pct;
    boxes.push(toCur({ x: r.x * geo.base.w, y: r.y * geo.base.h, w: r.w * geo.base.w, h: r.h * geo.base.h }, geo));
  }
  if (op.lines != null || op.line != null) {
    const [a, b] = op.lines ?? [op.line, op.line];
    const sel = ocr.lines.slice(Math.max(0, a - 1), Math.max(a, b));
    if (!sel.length) throw notFound(`Lines ${a}-${b}`, ocr);
    boxes.push(toCur(unionBoxes(sel.map(lineBox)), geo));
  }
  if (op.text != null || op.regex != null || op.preset != null) {
    const hits = pickOccurrence(findText(ocr.lines, { text: op.text, regex: op.regex, preset: op.preset }), op.occurrence ?? 'all');
    if (!hits.length) {
      if (op.preset && op.op === 'redact') return boxes; // nothing sensitive of that kind: fine
      throw notFound(op.text != null ? `Text "${op.text}"` : op.regex != null ? `Regex /${op.regex}/` : `Preset ${op.preset}`, ocr);
    }
    for (const h of hits) boxes.push(toCur(h.box, geo));
  }
  return boxes;
}

function anchorFor(box, position, geo, gap = 8) {
  switch (position) {
    case 'left':
      return { x: Math.round(box.x - gap), y: Math.round(box.y + box.h / 2), anchor: 'mr' };
    case 'above':
      return { x: Math.round(box.x), y: Math.round(box.y - gap / 2), anchor: 'bl' };
    case 'below':
      return { x: Math.round(box.x), y: Math.round(box.y + box.h + gap / 2), anchor: 'tl' };
    default: {
      const x = box.x + box.w + gap;
      if (x > geo.w - 60) return { x: Math.round(box.x - gap), y: Math.round(box.y + box.h / 2), anchor: 'mr' };
      return { x: Math.round(x), y: Math.round(box.y + box.h / 2), anchor: 'ml' };
    }
  }
}

function labelOp(text, box, op, geo) {
  const a = anchorFor(box, op.position || 'right', geo);
  return { op: 'label', text: String(text), x: a.x, y: a.y, anchor: a.anchor, color: op.label_color || '#FFFFFF', bg: op.label_bg || op.color || '', size: op.size || 15 };
}

/** Resolve one agent op into worker ops; returns the new geometry. */
export function resolveOp(op, geo, ocr) {
  const out = [];
  const g = { ...geo, t: { ...geo.t } };
  let flushAfter = false;
  switch (op.op) {
    case 'crop': {
      let box;
      let band = null;
      const textAnchored = op.from_text != null || op.to_text != null || op.lines != null || op.line != null;
      if (op.lines != null || op.line != null) {
        const [a, b] = op.lines ?? [op.line, op.line];
        band = [Math.max(0, a - 1), Math.min(ocr.lines.length - 1, Math.max(a, b) - 1)];
      }
      if (op.from_text != null || op.to_text != null) {
        const froms = op.from_text != null ? lineIndices(ocr, op.from_text) : [0];
        if (!froms.length) throw notFound(`from_text "${op.from_text}"`, ocr);
        const fromIdx = (op.occurrence ?? 'last') === 'first' ? froms[0] : froms[froms.length - 1];
        let toIdx = ocr.lines.length - 1;
        if (op.to_text != null) {
          const tos = lineIndices(ocr, op.to_text).filter((i) => i >= fromIdx);
          if (!tos.length) throw notFound(`to_text "${op.to_text}" (after line ${fromIdx + 1})`, ocr);
          toIdx = op.include_to === false ? tos[0] - 1 : tos[0];
        }
        band = [fromIdx, Math.max(fromIdx, toIdx)];
        const sel = ocr.lines.slice(band[0], band[1] + 1);
        box = toCur(unionBoxes(sel.map(lineBox)), g);
      } else {
        const boxes = resolveTargets(op, g, ocr);
        if (!boxes.length) throw new Error('crop needs rect, rect_pct, lines, text/regex, or from_text/to_text');
        box = unionBoxes(boxes);
      }
      const fullWidth = op.full_width ?? textAnchored;
      const pad = op.padding ?? (op.rect || op.rect_pct ? 0 : 10);
      let r = grow(box, pad);
      if (band && op.padding == null) r = clampToNeighbours(ocr, band[0], band[1], r, g);
      if (fullWidth) r = { x: 0, y: r.y, w: g.w, h: r.h };
      r = clampBox(r, g);
      if (r.w < 2 || r.h < 2) throw new Error(`crop region is empty after clamping to the ${g.w}×${g.h} image`);
      out.push({ op: 'crop', ...r });
      g.t.tx -= r.x;
      g.t.ty -= r.y;
      g.w = r.w;
      g.h = r.h;
      break;
    }
    case 'trim':
      out.push({ op: 'trim', tolerance: op.tolerance ?? 24, padding: op.padding ?? 10 });
      flushAfter = true;
      break;
    case 'pad': {
      const p = typeof op.size === 'number' ? { top: op.size, right: op.size, bottom: op.size, left: op.size } : { top: 0, right: 0, bottom: 0, left: 0, ...(op.sides || {}) };
      out.push({ op: 'pad', ...p, color: op.color || '#FFFFFF' });
      g.t.tx += p.left;
      g.t.ty += p.top;
      g.w += p.left + p.right;
      g.h += p.top + p.bottom;
      break;
    }
    case 'scale': {
      let f = op.factor;
      if (op.width) f = op.width / g.w;
      if (op.max_width) f = Math.min(1, op.max_width / g.w);
      if (!f || f <= 0) throw new Error('scale needs factor, width or max_width');
      if (Math.abs(f - 1) < 1e-6) break;
      out.push({ op: 'scale', factor: f });
      g.t = { s: g.t.s * f, tx: g.t.tx * f, ty: g.t.ty * f };
      g.w = Math.max(1, Math.round(g.w * f));
      g.h = Math.max(1, Math.round(g.h * f));
      break;
    }
    case 'frame': {
      const m = op.margin ?? 24;
      out.push({ op: 'frame', margin: m, bg: op.bg || '#FFFFFF', shadow: op.shadow ?? true, radius: op.radius ?? 8 });
      g.t.tx += m;
      g.t.ty += m;
      g.w += 2 * m;
      g.h += 2 * m;
      break;
    }
    case 'box':
    case 'highlight':
    case 'redact': {
      const boxes = resolveTargets(op, g, ocr);
      if (!boxes.length && op.op !== 'redact') throw new Error(`${op.op} needs a target: rect, rect_pct, lines, text, regex or preset`);
      if (!boxes.length && op.op === 'redact' && !op.preset) throw new Error('redact needs a target: rect, text, regex or preset');
      const pad = op.padding ?? (op.op === 'box' ? 4 : 2);
      for (const b0 of boxes) {
        const b = clampBox(grow(b0, pad), g);
        if (b.w <= 0 || b.h <= 0) continue;
        if (op.op === 'box') out.push({ op: 'box', ...b, color: op.color || '#E53935', thickness: op.thickness ?? 3, radius: op.radius ?? 4 });
        else if (op.op === 'highlight') out.push({ op: 'highlight', ...b, color: op.color || '#FFEB3B', opacity: op.opacity ?? 0.35 });
        else out.push({ op: 'redact', ...b, style: op.style || 'pixelate', color: op.color || '#000000' });
      }
      if (op.label && boxes.length && op.op !== 'redact') out.push(labelOp(op.label, grow(boxes[0], pad), { ...op, label_bg: op.label_bg || op.color }, g));
      break;
    }
    case 'label': {
      if (!op.label) throw new Error('label op needs "label" (the text to draw)');
      if (op.at) {
        const p = toCur({ x: op.at.x, y: op.at.y, w: 0, h: 0 }, g);
        out.push({ op: 'label', text: String(op.label), x: Math.round(p.x), y: Math.round(p.y), anchor: 'tl', color: op.label_color || '#FFFFFF', bg: op.color || '', size: op.size || 15 });
      } else {
        const boxes = resolveTargets(op, g, ocr);
        if (!boxes.length) throw new Error('label needs "at" {x,y} or a target (text, regex, rect, lines)');
        out.push(labelOp(op.label, grow(boxes[0], 4), op, g));
      }
      break;
    }
    case 'badge': {
      const txt = String(op.label ?? op.number ?? '1');
      const d = op.size || 26;
      let cx;
      let cy;
      if (op.at) {
        const p = toCur({ x: op.at.x, y: op.at.y, w: 0, h: 0 }, g);
        cx = p.x;
        cy = p.y;
      } else {
        const boxes = resolveTargets(op, g, ocr);
        if (!boxes.length) throw new Error('badge needs "at" {x,y} or a target');
        const b = boxes[0];
        const left = (op.position || 'left') === 'left';
        cx = left ? b.x - d / 2 - 6 : b.x + b.w + d / 2 + 6;
        cy = b.y + b.h / 2;
      }
      cx = Math.max(d / 2 + 1, Math.min(g.w - d / 2 - 1, cx));
      cy = Math.max(d / 2 + 1, Math.min(g.h - d / 2 - 1, cy));
      out.push({ op: 'badge', text: txt, x: Math.round(cx), y: Math.round(cy), color: op.color || '#E53935', size: d });
      break;
    }
    case 'arrow': {
      const boxes = resolveTargets(op, g, ocr);
      if (!boxes.length) throw new Error('arrow needs a target to point at (text, regex, rect, lines)');
      const b = boxes[0];
      let from;
      if (op.from) from = toCur({ x: op.from.x, y: op.from.y, w: 0, h: 0 }, g);
      else from = { x: Math.min(g.w - 8, b.x + b.w + 90), y: Math.min(g.h - 8, b.y + b.h / 2 + 36) };
      const to = { x: from.x >= b.x + b.w ? b.x + b.w + 4 : from.x <= b.x ? b.x - 4 : b.x + b.w / 2, y: b.y + b.h / 2 };
      out.push({ op: 'arrow', x1: Math.round(from.x), y1: Math.round(from.y), x2: Math.round(to.x), y2: Math.round(to.y), color: op.color || '#E53935', thickness: op.thickness ?? 4 });
      if (op.label) out.push({ op: 'label', text: String(op.label), x: Math.round(from.x), y: Math.round(from.y), anchor: 'tl', color: '#FFFFFF', bg: op.color || '', size: op.size || 15 });
      break;
    }
    case 'prepend': {
      // internal: stack a region of another image on top (window title bar)
      out.push({ op: 'prepend', src: op.src, x: op.x, y: op.y, w: op.w, h: op.h });
      g.t.ty += op.h;
      g.h += op.h;
      g.w = Math.max(g.w, op.w);
      break;
    }
    default:
      throw new Error(`Unknown op '${op.op}'. Use crop, trim, pad, scale, frame, box, highlight, redact, label, badge, arrow.`);
  }
  return { ops: out, geo: g, flushAfter };
}

/** Apply ops to a shot and register the result as a new derived shot. */
export async function applyOps(ctx, base, ops, { label, extra = {} } = {}) {
  const { shots, worker } = ctx;
  const ocr = opsNeedOcr(ops) ? await shots.ocr(base.id) : null;
  let src = base.file;
  let geo = { w: base.width, h: base.height, t: { s: 1, tx: 0, ty: 0 }, base: { w: base.width, h: base.height } };
  let batch = [];
  const temps = [];
  const flush = async () => {
    const dst = shots.tmpFile('edit');
    temps.push(dst);
    const r = (await worker.call('edit', { src, dst, transform: geo.t, ops: batch }, { timeoutMs: 90_000 })).result;
    src = dst;
    geo = { ...geo, w: r.Width, h: r.Height, t: { s: r.S, tx: r.Tx, ty: r.Ty } };
    batch = [];
  };
  for (const op of ops) {
    const res = resolveOp(op, geo, ocr);
    batch.push(...res.ops);
    geo = res.geo;
    if (res.flushAfter) await flush();
  }
  if (batch.length || src === base.file) await flush();
  const { id, file } = shots.allocate(label || base.label);
  fs.renameSync(src, file);
  for (const t of temps) if (t !== src) fs.rmSync(t, { force: true });
  return shots.add({
    id,
    file,
    width: geo.w,
    height: geo.h,
    kind: 'edit',
    parent: base.id,
    transform: geo.t,
    label: label || base.label,
    ops: ops.map((o) => o.op),
    session: base.session,
    command: base.command,
    source: base.source,
    captureInfo: base.captureInfo,
    ...extra,
  });
}
