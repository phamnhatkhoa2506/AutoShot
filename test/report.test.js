import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { EvidenceManifest } from '../src/evidence.js';
import { buildReport } from '../src/report/index.js';

function png(width, height, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoshot-test-'));
  const cfg = { outputDir: dir, evidenceDir: path.join(dir, 'evidence'), manifestPath: path.join(dir, 'evidence.json') };
  const manifest = new EvidenceManifest(cfg);
  const shots = [
    ['s1', 800, 200, [30, 30, 30], 'Địa chỉ IP của máy chủ', 'Câu 1', 'ip a'],
    ['s2', 1200, 300, [0, 80, 160], 'Dịch vụ SSH đang chạy', 'Câu 2', 'systemctl status ssh'],
  ].map(([id, w, h, c, caption, section, command]) => {
    const file = path.join(dir, `${id}.png`);
    fs.writeFileSync(file, png(w, h, c));
    return manifest.add({ id, file, width: w, height: h, label: id }, { caption, section, command, output: ['line 1', 'line 2'] });
  });
  return { dir, cfg, ctx: { cfg, evidence: manifest }, shots };
}

test('evidence manifest add / update / reorder / remove', () => {
  const { ctx, dir } = setup();
  const ev = ctx.evidence;
  assert.deepEqual(ev.list().map((i) => i.id), ['e1', 'e2']);
  assert.ok(fs.existsSync(path.join(dir, 'evidence', '01-dia-chi-ip-cua-may-chu.png')));
  ev.update('e2', { caption: 'SSH active' });
  assert.equal(ev.get('e2').caption, 'SSH active');
  ev.reorder(['e2']);
  assert.deepEqual(ev.list().map((i) => i.id), ['e2', 'e1']);
  ev.remove('e1');
  assert.deepEqual(ev.list().map((i) => i.id), ['e2']);
  const reloaded = new EvidenceManifest(ctx.cfg);
  assert.deepEqual(reloaded.list().map((i) => i.id), ['e2']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('new docx report contains images and numbered captions', async () => {
  const { ctx, dir } = setup();
  const r = await buildReport(ctx, { format: 'docx', title: 'Báo cáo thực hành', caption_prefix: 'Hình', include_commands: true });
  const zip = await JSZip.loadAsync(fs.readFileSync(r.path));
  const xml = await zip.file('word/document.xml').async('string');
  assert.equal(Object.keys(zip.files).filter((f) => f.startsWith('word/media/') && f.endsWith('.png')).length, 2);
  assert.match(xml, /Hình 1: /);
  assert.match(xml, /Hình 2: /);
  assert.match(xml, /systemctl status ssh/);
  // 1200px image is scaled down to the 600px default max width: 600 * 9525 EMU
  assert.match(xml, /cx="5715000"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('insert into an existing docx at anchors and placeholders', async () => {
  const { ctx, dir } = setup();
  const tpl = path.join(dir, 'lab.docx');
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun('Bài thực hành Linux')] }),
          new Paragraph({ children: [new TextRun('Câu 1: '), new TextRun({ text: 'Xem địa chỉ IP', bold: true })] }),
          new Paragraph({ children: [new TextRun('Trả lời:')] }),
          new Paragraph({ children: [new TextRun('Câu 2: Kiểm tra dịch vụ SSH')] }),
          new Paragraph({ children: [new TextRun('{{e2}}')] }),
          new Paragraph({ children: [new TextRun('Hết')] }),
        ],
      },
    ],
  });
  fs.writeFileSync(tpl, await Packer.toBuffer(doc));
  const out = path.join(dir, 'lab-filled.docx');
  const r = await buildReport(ctx, { template: tpl, output: out, caption_prefix: 'Hình', placements: [{ anchor: 'Câu 1: Xem địa chỉ IP', evidence: ['e1'] }] });
  assert.deepEqual(r.inserted.sort(), ['e1', 'e2']);
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const xml = await zip.file('word/document.xml').async('string');
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  const types = await zip.file('[Content_Types].xml').async('string');
  assert.ok(!xml.includes('{{e2}}'), 'placeholder paragraph replaced');
  assert.match(rels, /rIdAutoShot1/);
  assert.match(types, /Extension="png"/);
  const iAnchor = xml.indexOf('Xem địa chỉ IP');
  const iPic1 = xml.indexOf('<w:drawing>');
  const iAnswer = xml.indexOf('Trả lời:');
  assert.ok(iAnchor < iPic1 && iPic1 < iAnswer, 'image inserted right after the anchor paragraph');
  assert.ok(xml.indexOf('Hình 2:') > xml.indexOf('Kiểm tra dịch vụ SSH'));
  assert.ok(fs.existsSync(tpl) && fs.statSync(tpl).size < fs.statSync(out).size, 'template untouched, output bigger');
  await assert.rejects(buildReport(ctx, { template: tpl, output: tpl }), /overwrite the template/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('markdown and html reports', async () => {
  const { ctx, dir } = setup();
  const md = await buildReport(ctx, { format: 'markdown', title: 'Lab', include_output: true });
  const text = fs.readFileSync(md.path, 'utf8');
  assert.match(text, /^# Lab/m);
  assert.match(text, /## Câu 1/);
  assert.match(text, /!\[Địa chỉ IP của máy chủ\]\(evidence\/01-dia-chi-ip-cua-may-chu\.png\)/);
  assert.match(text, /\*Figure 2: Dịch vụ SSH đang chạy\*/);
  const html = await buildReport(ctx, { format: 'html', title: 'Lab' });
  const h = fs.readFileSync(html.path, 'utf8');
  assert.match(h, /data:image\/png;base64,/);
  assert.match(h, /<figcaption>Figure 1: Địa chỉ IP của máy chủ<\/figcaption>/);
  fs.rmSync(dir, { recursive: true, force: true });
});
