import fs from 'node:fs';
import JSZip from 'jszip';
import { captionText, xmlEscape, xmlUnescape } from './common.js';

// Insert evidence images into an EXISTING .docx (e.g. the lab sheet the user was given):
//   - a paragraph containing only a placeholder like {{e3}} / {{evidence:e3}} is replaced by e3
//   - placements [{ anchor: "Câu 2", evidence: ["e3","e4"], position: "after" }] insert after
//     (or before / instead of) the paragraph whose text contains the anchor
//   - with neither, everything is appended at the end of the document.

const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PARA_RE = /<w:p\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/w:p>)/g;
const FIG_TOKEN = '@@AUTOSHOT_FIG@@';
const PLACEHOLDER_RE = /\{\{\s*(?:evidence:|autoshot:)?(e\d+)\s*\}\}/gi;

function paragraphText(p) {
  return xmlUnescape([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''));
}

function norm(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function contentWidthPx(xml) {
  const sect = [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].pop()?.[0] || '';
  const w = Number(/<w:pgSz\b[^>]*w:w="(\d+)"/.exec(sect)?.[1] || 11906);
  const l = Number(/<w:pgMar\b[^>]*w:left="(\d+)"/.exec(sect)?.[1] || 1440);
  const r = Number(/<w:pgMar\b[^>]*w:right="(\d+)"/.exec(sect)?.[1] || 1440);
  return Math.max(200, Math.floor((w - l - r) / 15)); // 15 twips per px at 96 dpi
}

export async function insertIntoDocx(templatePath, entries, opts) {
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const docPath = 'word/document.xml';
  const relsPath = 'word/_rels/document.xml.rels';
  let xml = await zip.file(docPath).async('string');
  let rels = zip.file(relsPath) ? await zip.file(relsPath).async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let types = await zip.file('[Content_Types].xml').async('string');
  const styles = zip.file('word/styles.xml') ? await zip.file('word/styles.xml').async('string') : '';
  const hasCaptionStyle = /w:styleId="Caption"/.test(styles);

  // namespaces needed by inline pictures
  xml = xml.replace(/<w:document\b([^>]*)>/, (m, attrs) => {
    let a = attrs;
    if (!/xmlns:wp=/.test(a)) a += ` xmlns:wp="${NS_WP}"`;
    if (!/xmlns:r=/.test(a)) a += ` xmlns:r="${NS_R}"`;
    return `<w:document${a}>`;
  });
  if (!/Extension="png"/i.test(types)) types = types.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');

  const maxW = Math.min(opts.maxWidth || 10_000, contentWidthPx(xml));
  let docPrId = Math.max(1000, ...[...xml.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)].map((m) => Number(m[1]) + 1));
  let relN = 1;
  const usedRel = new Set([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
  const byId = new Map(entries.map((e) => [e.id, e]));
  const inserted = [];

  const blockFor = (e) => {
    let rid;
    do rid = `rIdAutoShot${relN++}`;
    while (usedRel.has(rid));
    usedRel.add(rid);
    const media = `media/autoshot_${e.id}_${Date.now().toString(36)}.png`;
    zip.file(`word/${media}`, e.data);
    rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${media}"/></Relationships>`);
    const scale = Math.min(1, maxW / e.size.width);
    const cx = Math.round(e.size.width * scale * 9525);
    const cy = Math.round(e.size.height * scale * 9525);
    const id = docPrId++;
    const alt = xmlEscape(e.caption || e.id);
    const pic =
      `<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
      `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${id}" name="AutoShot ${id}" descr="${alt}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${e.id}.png" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    // numbered in document order at the end, not in insertion order
    const cap = captionText(opts.captionPrefix, FIG_TOKEN, e.caption);
    const [head, ...rest] = cap.split(': ');
    const pPr = hasCaptionStyle ? '<w:pPr><w:pStyle w:val="Caption"/><w:jc w:val="center"/></w:pPr>' : '<w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr>';
    const run = (t, bold) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:i/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r>`;
    const caption = `<w:p>${pPr}${run(rest.length ? `${head}: ` : head, true)}${rest.length ? run(rest.join(': '), false) : ''}</w:p>`;
    let extra = '';
    if (opts.includeCommands && e.command) {
      extra = `<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlEscape(e.command)}</w:t></w:r></w:p>`;
    }
    inserted.push(e.id);
    return extra + pic + caption;
  };

  const resolve = (ids) =>
    ids.map((id) => {
      const e = byId.get(id) || byId.get(`e${String(id).replace(/^e/, '')}`);
      if (!e) throw new Error(`Evidence '${id}' is not part of this report`);
      return e;
    });

  // 1) placeholders
  xml = xml.replace(PARA_RE, (p) => {
    if (!/\{\{/.test(p) || /<w:txbxContent/.test(p)) return p;
    const text = paragraphText(p);
    const ids = [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1].toLowerCase());
    if (!ids.length) return p;
    return resolve(ids).map(blockFor).join('');
  });

  // 2) anchored placements
  for (const pl of opts.placements || []) {
    const want = norm(pl.anchor);
    const matches = [];
    for (const m of xml.matchAll(PARA_RE)) {
      if (/<w:txbxContent/.test(m[0])) continue;
      if (norm(paragraphText(m[0])).includes(want)) matches.push(m);
    }
    if (!matches.length) throw new Error(`Anchor text "${pl.anchor}" was not found in ${templatePath}`);
    const occ = pl.occurrence ?? 'first';
    const m = occ === 'last' ? matches[matches.length - 1] : typeof occ === 'number' ? matches[occ - 1] : matches[0];
    if (!m) throw new Error(`Anchor "${pl.anchor}" has only ${matches.length} occurrence(s)`);
    const block = resolve(pl.evidence).map(blockFor).join('');
    const start = m.index;
    const end = m.index + m[0].length;
    const pos = pl.position || 'after';
    if (pos === 'before') xml = xml.slice(0, start) + block + xml.slice(start);
    else if (pos === 'replace') xml = xml.slice(0, start) + block + xml.slice(end);
    else xml = xml.slice(0, end) + block + xml.slice(end);
  }

  // 3) nothing placed explicitly: append everything not yet inserted
  if (!opts.placements?.length && !inserted.length) {
    const block = entries.map(blockFor).join('');
    const bodyEnd = xml.lastIndexOf('</w:body>');
    const sectStart = xml.lastIndexOf('<w:sectPr', bodyEnd);
    const at = sectStart > xml.lastIndexOf('</w:p>', bodyEnd) ? sectStart : bodyEnd;
    xml = xml.slice(0, at) + block + xml.slice(at);
  }

  let figure = opts.startNumber || 1;
  xml = xml.replace(new RegExp(FIG_TOKEN, 'g'), () => String(figure++));
  zip.file(docPath, xml);
  zip.file(relsPath, rels);
  zip.file('[Content_Types].xml', types);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: buf, inserted };
}
