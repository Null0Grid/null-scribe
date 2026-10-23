'use strict';

/**
 * Word (.docx) and LibreOffice (.odt) downloads of a session: title, details, the summary with real
 * headings, bullets and ☐ action items, then the transcript as a Time / Speaker / Text table.
 * Both are built in-process (docx library and a hand-written OpenDocument zip); nothing leaves the device.
 */

const JSZip = require('jszip');
const { formatTimestamp } = require('./chunk');
const { roleOf } = require('./speaker-names');

const COLORS = { text: '121624', muted: '5A6178', accent: '007F99', pink: 'C4126A', line: 'D5DAE6', head: 'F3F5F7' };
const FOOTER = 'Transcribed and summarized on-device with Null Scribe.';

/* ---------------- shared: summary Markdown → blocks ---------------- */

/** Inline Markdown → runs: [{ text, bold, italic, code, ts }]. Timestamps like [01:02] become ts runs. */
function parseInline(s) {
  const runs = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[(\d{1,2}:\d{2}(?::\d{2})?)\]|(^|[^*])\*([^*\s][^*]*)\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index;
    if (m[5] !== undefined) {
      // italic: keep the character before the opening *
      const before = s.slice(last, start) + m[4];
      if (before) runs.push({ text: before });
      runs.push({ text: m[5], italic: true });
    } else {
      if (start > last) runs.push({ text: s.slice(last, start) });
      if (m[1] !== undefined) runs.push({ text: m[1], bold: true });
      else if (m[2] !== undefined) runs.push({ text: m[2], code: true });
      else if (m[3] !== undefined) runs.push({ text: m[3], ts: true });
    }
    last = re.lastIndex;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs.filter((r) => r.text);
}

/** Summary Markdown → [{ type: 'heading'|'bullet'|'task'|'number'|'para', level?, done?, runs }] */
function parseSummary(md) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'para', runs: parseInline(para.join(' ')) });
    para = [];
  };
  for (const raw of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) flush();
    else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ type: 'heading', level: m[1].length, runs: parseInline(m[2]) });
    } else if ((m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ type: 'task', done: m[1].toLowerCase() === 'x', runs: parseInline(m[2]) });
    } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ type: 'bullet', runs: parseInline(m[1]) });
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flush();
      blocks.push({ type: 'number', runs: parseInline(m[1]) });
    } else para.push(line.trim());
  }
  flush();
  return blocks;
}

function metaLines(meta) {
  return [
    new Date(meta.createdAt).toLocaleString(),
    meta.durationMs ? `Duration ${formatTimestamp(meta.durationMs)}` : null,
    meta.source || null,
  ].filter(Boolean);
}

/** Characters XML 1.0 can't hold (control characters) would make Word/LibreOffice reject the file. */
const xmlSafe = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');

/* ---------------- Word (.docx) ---------------- */

async function buildDocx({ meta, summary, segments, letter = true }) {
  const d = require('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, Footer, AlignmentType, ShadingType, LevelFormat, PageNumber } = d;

  const run = (r, extra = {}) =>
    new TextRun({
      text: xmlSafe(r.text),
      bold: r.bold || undefined,
      italics: r.italic || undefined,
      font: r.code || r.ts ? 'Consolas' : undefined,
      size: r.ts ? 18 : undefined,
      color: r.ts ? COLORS.accent : undefined,
      ...extra,
    });

  const body = [];
  body.push(new Paragraph({ children: [new TextRun({ text: 'NULL//SCRIBE', font: 'Consolas', size: 16, bold: true, color: COLORS.accent })] }));
  body.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: xmlSafe(meta.title) })] }));
  body.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: xmlSafe(metaLines(meta).join('  ·  ')), color: COLORS.muted, size: 20 })] }));

  body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Summary')] }));
  const blocks = parseSummary(summary || 'No summary.');
  for (const b of blocks) {
    const runs = b.runs.map((r) => run(r));
    if (b.type === 'heading') body.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs }));
    else if (b.type === 'bullet') body.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: runs }));
    else if (b.type === 'number') body.push(new Paragraph({ numbering: { reference: 'numbers', level: 0 }, children: runs }));
    else if (b.type === 'task')
      body.push(
        new Paragraph({
          indent: { left: 360, hanging: 360 },
          spacing: { after: 60 },
          children: [new TextRun({ text: b.done ? '☑\t' : '☐\t', color: b.done ? '128A4A' : COLORS.muted }), ...b.runs.map((r) => run(r, b.done ? { strike: true, color: COLORS.muted } : {}))],
        })
      );
    else body.push(new Paragraph({ children: runs }));
  }

  body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: false, spacing: { before: 360 }, children: [new TextRun('Transcript')] }));
  if (!segments?.length) body.push(new Paragraph({ children: [new TextRun({ text: 'No transcript.', color: COLORS.muted })] }));
  else {
    const contentWidth = (letter ? 12240 : 11906) - 2 * 1134; // page width minus 2 cm margins, in twips
    const widths = [1000, 1700, contentWidth - 2700];
    const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const borders = { top: none, left: none, right: none, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E6E9F0' } };
    const cell = (children, i, shade) =>
      new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        borders,
        margins: { top: 40, bottom: 40, left: 60, right: 60 },
        shading: shade ? { type: ShadingType.CLEAR, color: 'auto', fill: COLORS.head } : undefined,
        children: [new Paragraph({ children })],
      });
    const head = new TableRow({
      tableHeader: true,
      children: ['Time', 'Speaker', 'What was said'].map((t, i) => cell([new TextRun({ text: t, bold: true, size: 18, color: COLORS.muted })], i, true)),
    });
    const rows = segments.map(
      (s) =>
        new TableRow({
          cantSplit: true,
          children: [
            cell([new TextRun({ text: formatTimestamp(s.start), font: 'Consolas', size: 18, color: COLORS.muted })], 0),
            cell(s.speaker ? [new TextRun({ text: xmlSafe(s.speaker), bold: true, size: 18, color: roleOf(s) === 'you' ? COLORS.accent : COLORS.pink })] : [], 1),
            cell([new TextRun({ text: xmlSafe(s.text) })], 2),
          ],
        })
    );
    body.push(new Table({ width: { size: contentWidth, type: WidthType.DXA }, columnWidths: widths, rows: [head, ...rows] }));
  }

  const doc = new Document({
    creator: 'Null Scribe',
    title: xmlSafe(meta.title),
    description: 'Conversation summary and transcript from Null Scribe',
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22, color: COLORS.text } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { size: 44, bold: true, color: COLORS.text }, paragraph: { spacing: { after: 60 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true, color: COLORS.accent }, paragraph: { spacing: { before: 280, after: 120 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, color: COLORS.text }, paragraph: { spacing: { before: 200, after: 80 } } },
      ],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 260 } } } }] },
        { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 260 } } } }] },
      ],
    },
    sections: [
      {
        properties: { page: { size: letter ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${FOOTER}  ·  `, size: 16, color: COLORS.muted }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: COLORS.muted })] })],
          }),
        },
        children: body,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/* ---------------- LibreOffice (.odt, OpenDocument Text) ---------------- */

const esc = (s) => xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
].join(' ');

function odtSpans(runs, { done = false } = {}) {
  return runs
    .map((r) => {
      const style = r.ts ? 'T_ts' : r.code ? 'T_code' : r.bold ? 'T_b' : r.italic ? 'T_i' : done ? 'T_done' : null;
      const text = esc(r.text).replace(/\t/g, '<text:tab/>');
      return style ? `<text:span text:style-name="${style}">${text}</text:span>` : text;
    })
    .join('');
}

function odtContent({ meta, summary, segments }) {
  const out = [];
  out.push(`<text:p text:style-name="P_brand">NULL//SCRIBE</text:p>`);
  out.push(`<text:p text:style-name="Title">${esc(meta.title)}</text:p>`);
  out.push(`<text:p text:style-name="P_meta">${esc(metaLines(meta).join('  ·  '))}</text:p>`);
  out.push(`<text:h text:style-name="Heading_20_1" text:outline-level="1">Summary</text:h>`);

  let list = null; // 'bullet' | 'number'
  const closeList = () => {
    if (list) out.push('</text:list>');
    list = null;
  };
  for (const b of parseSummary(summary || 'No summary.')) {
    if (b.type === 'bullet' || b.type === 'number') {
      if (list !== b.type) {
        closeList();
        out.push(`<text:list text:style-name="${b.type === 'bullet' ? 'L_bullet' : 'L_number'}">`);
        list = b.type;
      }
      out.push(`<text:list-item><text:p text:style-name="P_list">${odtSpans(b.runs)}</text:p></text:list-item>`);
      continue;
    }
    closeList();
    if (b.type === 'heading') out.push(`<text:h text:style-name="Heading_20_2" text:outline-level="2">${odtSpans(b.runs)}</text:h>`);
    else if (b.type === 'task') out.push(`<text:p text:style-name="P_task"><text:span text:style-name="${b.done ? 'T_boxdone' : 'T_box'}">${b.done ? '☑' : '☐'}</text:span><text:tab/>${odtSpans(b.runs, { done: b.done })}</text:p>`);
    else out.push(`<text:p text:style-name="Text_20_body">${odtSpans(b.runs)}</text:p>`);
  }
  closeList();

  out.push(`<text:h text:style-name="Heading_20_1" text:outline-level="1">Transcript</text:h>`);
  if (!segments?.length) out.push(`<text:p text:style-name="P_meta">No transcript.</text:p>`);
  else {
    const cell = (style, p) => `<table:table-cell table:style-name="${style}" office:value-type="string">${p}</table:table-cell>`;
    out.push('<table:table table:name="Transcript" table:style-name="Tbl">');
    out.push('<table:table-column table:style-name="Tbl.A"/><table:table-column table:style-name="Tbl.B"/><table:table-column table:style-name="Tbl.C"/>');
    out.push(
      '<table:table-header-rows><table:table-row>' +
        ['Time', 'Speaker', 'What was said'].map((t) => cell('Tbl.H', `<text:p text:style-name="P_th">${t}</text:p>`)).join('') +
        '</table:table-row></table:table-header-rows>'
    );
    for (const s of segments) {
      const spk = s.speaker ? `<text:span text:style-name="${roleOf(s) === 'you' ? 'T_you' : 'T_app'}">${esc(s.speaker)}</text:span>` : '';
      out.push(
        '<table:table-row>' +
          cell('Tbl.D', `<text:p text:style-name="P_time">${formatTimestamp(s.start)}</text:p>`) +
          cell('Tbl.D', `<text:p text:style-name="P_cell">${spk}</text:p>`) +
          cell('Tbl.D', `<text:p text:style-name="P_cell">${esc(s.text)}</text:p>`) +
          '</table:table-row>'
      );
    }
    out.push('</table:table>');
  }

  const c = (hex) => `#${hex.toLowerCase()}`;
  const auto = `
  <office:automatic-styles>
    <style:style style:name="P_brand" style:family="paragraph"><style:text-properties style:font-name="Mono" fo:font-size="8pt" fo:font-weight="bold" fo:color="${c(COLORS.accent)}"/></style:style>
    <style:style style:name="P_meta" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-bottom="0.4cm"/><style:text-properties fo:font-size="10pt" fo:color="${c(COLORS.muted)}"/></style:style>
    <style:style style:name="P_list" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-bottom="0.08cm"/></style:style>
    <style:style style:name="P_task" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="0.635cm" fo:text-indent="-0.635cm" fo:margin-bottom="0.1cm"><style:tab-stops><style:tab-stop style:position="0cm"/></style:tab-stops></style:paragraph-properties></style:style>
    <style:style style:name="P_th" style:family="paragraph"><style:text-properties fo:font-size="9pt" fo:font-weight="bold" fo:color="${c(COLORS.muted)}"/></style:style>
    <style:style style:name="P_time" style:family="paragraph"><style:text-properties style:font-name="Mono" fo:font-size="9pt" fo:color="${c(COLORS.muted)}"/></style:style>
    <style:style style:name="P_cell" style:family="paragraph"><style:text-properties fo:font-size="10.5pt"/></style:style>
    <style:style style:name="T_b" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="T_i" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
    <style:style style:name="T_code" style:family="text"><style:text-properties style:font-name="Mono"/></style:style>
    <style:style style:name="T_ts" style:family="text"><style:text-properties style:font-name="Mono" fo:font-size="9pt" fo:color="${c(COLORS.accent)}"/></style:style>
    <style:style style:name="T_you" style:family="text"><style:text-properties fo:font-weight="bold" fo:font-size="9pt" fo:color="${c(COLORS.accent)}"/></style:style>
    <style:style style:name="T_app" style:family="text"><style:text-properties fo:font-weight="bold" fo:font-size="9pt" fo:color="${c(COLORS.pink)}"/></style:style>
    <style:style style:name="T_box" style:family="text"><style:text-properties fo:color="${c(COLORS.muted)}"/></style:style>
    <style:style style:name="T_boxdone" style:family="text"><style:text-properties fo:color="#128a4a"/></style:style>
    <style:style style:name="T_done" style:family="text"><style:text-properties fo:color="${c(COLORS.muted)}" style:text-line-through-style="solid"/></style:style>
    <style:style style:name="Tbl" style:family="table"><style:table-properties style:width="17cm" table:align="margins"/></style:style>
    <style:style style:name="Tbl.A" style:family="table-column"><style:table-column-properties style:column-width="1.8cm"/></style:style>
    <style:style style:name="Tbl.B" style:family="table-column"><style:table-column-properties style:column-width="3cm"/></style:style>
    <style:style style:name="Tbl.C" style:family="table-column"><style:table-column-properties style:column-width="12.2cm"/></style:style>
    <style:style style:name="Tbl.H" style:family="table-cell"><style:table-cell-properties fo:background-color="${c(COLORS.head)}" fo:padding="0.08cm" fo:border="none" fo:border-bottom="0.5pt solid ${c(COLORS.line)}"/></style:style>
    <style:style style:name="Tbl.D" style:family="table-cell"><style:table-cell-properties fo:padding="0.08cm" fo:border="none" fo:border-bottom="0.5pt solid #e6e9f0"/></style:style>
    <text:list-style style:name="L_bullet"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.635cm" fo:text-indent="-0.4cm" fo:margin-left="0.635cm"/></style:list-level-properties></text:list-level-style-bullet></text:list-style>
    <text:list-style style:name="L_number"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"><style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="0.635cm" fo:text-indent="-0.5cm" fo:margin-left="0.635cm"/></style:list-level-properties></text:list-level-style-number></text:list-style>
  </office:automatic-styles>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS} office:version="1.3">
  <office:font-face-decls>
    <style:font-face style:name="Sans" svg:font-family="Carlito, Calibri, 'Liberation Sans', Arial" style:font-family-generic="swiss"/>
    <style:font-face style:name="Mono" svg:font-family="'Liberation Mono', Consolas, monospace" style:font-family-generic="modern" style:font-pitch="fixed"/>
  </office:font-face-decls>${auto}
  <office:body><office:text>
${out.join('\n')}
  </office:text></office:body>
</office:document-content>`;
}

function odtStyles({ letter }) {
  const [w, h] = letter ? ['21.59cm', '27.94cm'] : ['21.0cm', '29.7cm'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS} office:version="1.3">
  <office:font-face-decls>
    <style:font-face style:name="Sans" svg:font-family="Carlito, Calibri, 'Liberation Sans', Arial" style:font-family-generic="swiss"/>
    <style:font-face style:name="Mono" svg:font-family="'Liberation Mono', Consolas, monospace" style:font-family-generic="modern" style:font-pitch="fixed"/>
  </office:font-face-decls>
  <office:styles>
    <style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.15cm"/><style:text-properties style:font-name="Sans" fo:font-size="11pt" fo:color="#${COLORS.text.toLowerCase()}" fo:language="en"/></style:default-style>
    <style:style style:name="Standard" style:family="paragraph" style:class="text"/>
    <style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard" style:class="text"><style:paragraph-properties fo:margin-bottom="0.2cm"/></style:style>
    <style:style style:name="Title" style:family="paragraph" style:parent-style-name="Standard" style:class="chapter"><style:paragraph-properties fo:margin-bottom="0.1cm"/><style:text-properties fo:font-size="22pt" fo:font-weight="bold"/></style:style>
    <style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Text_20_body" style:class="text"><style:paragraph-properties fo:keep-with-next="always"/></style:style>
    <style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Heading" style:default-outline-level="1" style:class="text"><style:paragraph-properties fo:margin-top="0.5cm" fo:margin-bottom="0.2cm"/><style:text-properties fo:font-size="14pt" fo:font-weight="bold" fo:color="#${COLORS.accent.toLowerCase()}"/></style:style>
    <style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Heading" style:default-outline-level="2" style:class="text"><style:paragraph-properties fo:margin-top="0.35cm" fo:margin-bottom="0.12cm"/><style:text-properties fo:font-size="12pt" fo:font-weight="bold"/></style:style>
    <style:style style:name="Footer" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="8pt" fo:color="#${COLORS.muted.toLowerCase()}"/></style:style>
  </office:styles>
  <office:automatic-styles>
    <style:page-layout style:name="PL"><style:page-layout-properties fo:page-width="${w}" fo:page-height="${h}" style:print-orientation="portrait" fo:margin-top="2cm" fo:margin-bottom="1.5cm" fo:margin-left="2cm" fo:margin-right="2cm"/><style:footer-style><style:header-footer-properties fo:min-height="0.6cm" fo:margin-top="0.3cm"/></style:footer-style></style:page-layout>
  </office:automatic-styles>
  <office:master-styles>
    <style:master-page style:name="Standard" style:page-layout-name="PL"><style:footer><text:p text:style-name="Footer">${esc(FOOTER)}  ·  <text:page-number text:select-page="current"/></text:p></style:footer></style:master-page>
  </office:master-styles>
</office:document-styles>`;
}

async function buildOdt({ meta, summary, segments, letter = true }) {
  const zip = new JSZip();
  // OpenDocument: "mimetype" must be the first entry and stored uncompressed.
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file('content.xml', odtContent({ meta, summary, segments }));
  zip.file('styles.xml', odtStyles({ letter }));
  zip.file(
    'meta.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${NS} office:version="1.3"><office:meta><meta:generator>Null Scribe</meta:generator><dc:title>${esc(meta.title)}</dc:title><dc:description>Conversation summary and transcript from Null Scribe</dc:description><meta:creation-date>${esc(new Date(meta.createdAt).toISOString().replace(/\.\d+Z$/, ''))}</meta:creation-date></office:meta></office:document-meta>`
  );
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
  <manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/vnd.oasis.opendocument.text' });
}

module.exports = { buildDocx, buildOdt, parseSummary, parseInline };
