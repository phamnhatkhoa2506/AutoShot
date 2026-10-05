import fs from 'node:fs';
import path from 'node:path';
import { slug } from './text.js';

// Ordered list of screenshots the agent chose as proof, with captions. Stored as
// <outputDir>/evidence.json; image copies live in <outputDir>/evidence/.
export class EvidenceManifest {
  constructor(cfg) {
    this.cfg = cfg;
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(fs.readFileSync(this.cfg.manifestPath, 'utf8'));
    } catch {
      this.data = { version: 1, seq: 0, items: [] };
    }
    this.data.items ||= [];
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.cfg.manifestPath), { recursive: true });
    fs.writeFileSync(this.cfg.manifestPath, JSON.stringify(this.data, null, 2));
  }

  list() {
    return this.load().items;
  }

  get(id) {
    const key = String(id ?? '').trim();
    const item = this.list().find((i) => i.id === key || i.id === `e${key}`);
    if (!item) throw new Error(`Unknown evidence '${id}'. Existing: ${this.list().map((i) => i.id).join(', ') || 'none'}.`);
    return item;
  }

  absPath(item) {
    return path.isAbsolute(item.file) ? item.file : path.join(this.cfg.outputDir, item.file);
  }

  add(shot, { caption, section, name, description, command, output, replace } = {}) {
    const data = this.load();
    fs.mkdirSync(this.cfg.evidenceDir, { recursive: true });
    if (replace) {
      const old = this.get(replace);
      fs.copyFileSync(shot.file, this.absPath(old));
      Object.assign(old, {
        shot: shot.id,
        width: shot.width,
        height: shot.height,
        caption: caption ?? old.caption,
        section: section ?? old.section,
        description: description ?? old.description,
        command: command ?? old.command,
        output: output ?? old.output,
        updatedAt: new Date().toISOString(),
      });
      this.save();
      return old;
    }
    const n = ++data.seq;
    const fileName = `${String(n).padStart(2, '0')}-${slug(name || caption || shot.label || shot.id)}.png`;
    const rel = path.join('evidence', fileName);
    fs.copyFileSync(shot.file, path.join(this.cfg.outputDir, rel));
    const item = {
      id: `e${n}`,
      shot: shot.id,
      file: rel.replace(/\\/g, '/'),
      width: shot.width,
      height: shot.height,
      caption: caption || '',
      section: section || null,
      description: description || null,
      command: command ?? shot.command ?? null,
      output: output || null,
      createdAt: new Date().toISOString(),
    };
    data.items.push(item);
    this.save();
    return item;
  }

  update(id, patch) {
    const item = this.get(id);
    for (const k of ['caption', 'section', 'description', 'command']) if (patch[k] !== undefined) item[k] = patch[k];
    item.updatedAt = new Date().toISOString();
    this.save();
    return item;
  }

  remove(id) {
    const data = this.load();
    const item = this.get(id);
    data.items = data.items.filter((i) => i !== item);
    fs.rmSync(this.absPath(item), { force: true });
    this.save();
    return item;
  }

  reorder(ids) {
    const data = this.load();
    const picked = ids.map((id) => this.get(id));
    const rest = data.items.filter((i) => !picked.includes(i));
    data.items = [...picked, ...rest];
    this.save();
    return data.items;
  }

  clear() {
    const data = this.load();
    for (const item of data.items) fs.rmSync(this.absPath(item), { force: true });
    data.items = [];
    data.seq = 0;
    this.save();
  }
}

export function describeEvidence(item) {
  const sec = item.section ? ` [${item.section}]` : '';
  return `${item.id}${sec} ${item.caption || '(no caption)'} · ${item.width}×${item.height}px · ${item.file}${item.command ? ` · cmd: ${item.command}` : ''}`;
}
