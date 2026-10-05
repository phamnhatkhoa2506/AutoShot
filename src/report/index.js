import fs from 'node:fs';
import path from 'node:path';
import { buildDocx } from './docx.js';
import { insertIntoDocx } from './docx-insert.js';
import { captionText, loadEntries } from './common.js';

function htmlEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildMarkdown(entries, opts, outPath) {
  const dir = path.dirname(outPath);
  const out = [];
  if (opts.title) out.push(`# ${opts.title}`, '');
  const meta = [opts.subtitle, opts.author, opts.date].filter(Boolean).join(' · ');
  if (meta) out.push(`_${meta}_`, '');
  let section = null;
  entries.forEach((e, i) => {
    if (e.section && e.section !== section) {
      section = e.section;
      out.push(`## ${section}`, '');
    }
    if (e.description) out.push(e.description, '');
    if (opts.includeCommands && e.command) out.push('```', e.command, '```', '');
    const rel = path.relative(dir, e.abs).replace(/\\/g, '/');
    const cap = captionText(opts.captionPrefix, opts.startNumber + i, e.caption);
    out.push(`![${e.caption || e.id}](${encodeURI(rel)})`, '', `*${cap}*`, '');
    if (opts.includeOutput && e.output?.length) out.push('```text', ...e.output.slice(0, 80), '```', '');
  });
  return out.join('\n');
}

function buildHtml(entries, opts, outPath) {
  const dir = path.dirname(outPath);
  const parts = [];
  let section = null;
  entries.forEach((e, i) => {
    if (e.section && e.section !== section) {
      section = e.section;
      parts.push(`<h2>${htmlEscape(section)}</h2>`);
    }
    if (e.description) parts.push(`<p>${htmlEscape(e.description)}</p>`);
    if (opts.includeCommands && e.command) parts.push(`<pre class="cmd">${htmlEscape(e.command)}</pre>`);
    const src = opts.embedImages ? `data:image/png;base64,${e.data.toString('base64')}` : encodeURI(path.relative(dir, e.abs).replace(/\\/g, '/'));
    const cap = captionText(opts.captionPrefix, opts.startNumber + i, e.caption);
    parts.push(
      `<figure><img src="${src}" alt="${htmlEscape(e.caption || e.id)}" width="${e.size.width}" height="${e.size.height}"><figcaption>${htmlEscape(cap)}</figcaption></figure>`,
    );
    if (opts.includeOutput && e.output?.length) parts.push(`<pre class="out">${htmlEscape(e.output.slice(0, 80).join('\n'))}</pre>`);
  });
  const meta = [opts.subtitle, opts.author, opts.date].filter(Boolean).join(' · ');
  return `<!doctype html>
<html lang="${htmlEscape(opts.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(opts.title || 'Report')}</title>
<style>
  :root { color-scheme: light; }
  body { font: 15px/1.6 "Segoe UI", system-ui, sans-serif; color: #1f2328; background: #fff; max-width: 980px; margin: 32px auto; padding: 0 16px; }
  h1 { text-align: center; margin-bottom: 4px; }
  .meta { text-align: center; color: #57606a; font-style: italic; margin-bottom: 28px; }
  h2 { border-bottom: 1px solid #d0d7de; padding-bottom: 4px; margin-top: 36px; }
  figure { margin: 18px 0 26px; text-align: center; }
  figure img { max-width: 100%; height: auto; border: 1px solid #d0d7de; border-radius: 6px; box-shadow: 0 2px 10px rgba(0,0,0,.08); }
  figcaption { font-style: italic; color: #57606a; margin-top: 8px; font-size: 14px; }
  pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px 12px; overflow-x: auto; font: 13px/1.45 Consolas, "Cascadia Mono", monospace; }
  @media print { figure { break-inside: avoid; } body { margin: 0 auto; } }
</style>
</head>
<body>
${opts.title ? `<h1>${htmlEscape(opts.title)}</h1>` : ''}
${meta ? `<div class="meta">${htmlEscape(meta)}</div>` : ''}
${parts.join('\n')}
</body>
</html>
`;
}

const EXT = { docx: '.docx', markdown: '.md', html: '.html' };

/** Build a report from the evidence manifest. Returns { path, count, format, inserted? }. */
export async function buildReport(ctx, params) {
  const format = params.template ? 'docx' : params.format || 'docx';
  if (!EXT[format]) throw new Error(`Unknown format '${format}'. Use docx, markdown or html.`);
  const entries = loadEntries(ctx.evidence, params.evidence);
  if (!entries.length) throw new Error('No evidence saved yet. Use save_evidence (or evidence={...} on run_command/capture) first.');
  let out = params.output ? path.resolve(params.output) : path.join(ctx.cfg.outputDir, `report${EXT[format]}`);
  if (!path.extname(out)) out += EXT[format];
  if (params.template && path.resolve(params.template) === out && !params.overwrite_template) {
    throw new Error('output would overwrite the template; choose another output path or pass overwrite_template=true');
  }
  const opts = {
    title: params.title,
    subtitle: params.subtitle,
    author: params.author,
    date: params.date,
    lang: params.lang,
    captionPrefix: params.caption_prefix ?? 'Figure',
    startNumber: params.start_number ?? 1,
    includeCommands: params.include_commands ?? false,
    includeOutput: params.include_output ?? false,
    maxWidth: params.image_max_width ?? 600,
    embedImages: params.embed_images ?? true,
    placements: params.placements,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let inserted;
  if (params.template) {
    const tpl = path.resolve(params.template);
    if (!fs.existsSync(tpl)) throw new Error(`Template not found: ${tpl}`);
    const r = await insertIntoDocx(tpl, entries, opts);
    fs.writeFileSync(out, r.buffer);
    inserted = r.inserted;
  } else if (format === 'docx') {
    fs.writeFileSync(out, await buildDocx(entries, opts));
  } else if (format === 'markdown') {
    fs.writeFileSync(out, buildMarkdown(entries, opts, out), 'utf8');
  } else {
    fs.writeFileSync(out, buildHtml(entries, opts, out), 'utf8');
  }
  return { path: out, count: entries.length, format, inserted };
}
