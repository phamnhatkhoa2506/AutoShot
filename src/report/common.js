import fs from 'node:fs';

export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function xmlUnescape(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Evidence items (manifest order, or the order of `ids`) with their PNG bytes loaded. */
export function loadEntries(manifest, ids) {
  const items = ids?.length ? ids.map((id) => manifest.get(id)) : manifest.list();
  return items.map((item) => {
    const abs = manifest.absPath(item);
    if (!fs.existsSync(abs)) throw new Error(`Evidence ${item.id} image is missing: ${abs}`);
    const data = fs.readFileSync(abs);
    return { ...item, abs, data, size: pngSize(data) };
  });
}

export function captionText(prefix, n, caption) {
  const p = (prefix ?? 'Figure').trim();
  const head = p ? `${p} ${n}` : '';
  if (!caption) return head;
  return head ? `${head}: ${caption}` : caption;
}
