import { AlignmentType, Document, HeadingLevel, ImageRun, Packer, Paragraph, ShadingType, TextRun } from 'docx';
import { captionText } from './common.js';

function codeParagraph(lines) {
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' },
    spacing: { before: 60, after: 120 },
    children: lines.map((line, i) => new TextRun({ text: line, font: 'Consolas', size: 18, break: i > 0 ? 1 : 0 })),
  });
}

/** Build a new .docx (title, sections, images with numbered captions). */
export async function buildDocx(entries, opts) {
  const children = [];
  if (opts.title) {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun(opts.title)] }));
  }
  const meta = [opts.subtitle, opts.author, opts.date].filter(Boolean).join(' · ');
  if (meta) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: meta, italics: true, color: '555555' })] }));
  }
  let section = null;
  entries.forEach((e, i) => {
    if (e.section && e.section !== section) {
      section = e.section;
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(section)] }));
    }
    if (e.description) children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun(e.description)] }));
    if (opts.includeCommands && e.command) children.push(codeParagraph([e.command]));
    const scale = Math.min(1, opts.maxWidth / e.size.width);
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        keepNext: true,
        spacing: { before: 120 },
        children: [
          new ImageRun({
            type: 'png',
            data: e.data,
            transformation: { width: Math.round(e.size.width * scale), height: Math.round(e.size.height * scale) },
            altText: { name: e.id, title: e.caption || e.id, description: e.caption || e.id },
          }),
        ],
      }),
    );
    const cap = captionText(opts.captionPrefix, opts.startNumber + i, e.caption);
    const [head, ...rest] = cap.split(': ');
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [
          new TextRun({ text: rest.length ? `${head}: ` : head, bold: true, italics: true, size: 20 }),
          ...(rest.length ? [new TextRun({ text: rest.join(': '), italics: true, size: 20 })] : []),
        ],
      }),
    );
    if (opts.includeOutput && e.output?.length) children.push(codeParagraph(e.output.slice(0, 80)));
  });
  const doc = new Document({
    creator: 'AutoShot',
    title: opts.title || 'Report',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}
