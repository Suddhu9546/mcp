/**
 * Builds a Timing Allocation Document PDF from an extracted topic structure.
 *
 * The output is written in the exact shape src/timing/timing-parser.ts reads,
 * which is the shape of the Biofuels document:
 *
 *   <Course name>
 *   Qualification Pack: <qp> | NSQF Level: <n> | Total Duration: <n> Hours (<n> Mins)
 *   Module 1: <title> (3.0 Hours)
 *   UNIT 1.1 <title> (0.75 Hours / 45 Mins)
 *   1.1.1 <subtopic>
 *
 * INVARIANT 3 says the parser may never compute a duration. It does not: the
 * minutes are decided here, written into the document, and read back from it.
 * This script is the author of the document, not part of the reading path.
 *
 * Units are renumbered sequentially within their module. The source handbook's
 * own numbering is inconsistent -- Module 5's units are printed 5.1, 4.2, 5.3,
 * 5.4, 5.2 -- and a timing document that reproduced that could not be parsed, so
 * position is authoritative here while every title stays exactly as printed.
 *
 *   node scripts/timing/build-timing-pdf.mjs <structure.json> <out.pdf>
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: build-timing-pdf.mjs <structure.json> <out.pdf>');
  process.exit(1);
}

const BLOCK_MINS = 15;

// Course constants live in the structure file so one script builds every course.
// Solar Photovoltaic Entrepreneur was the first and its file predates the fields,
// so its values stay here as the defaults and its document regenerates unchanged.
const DEFAULTS = {
  course_name: 'Solar Photovoltaic Entrepreneur',
  qp_code: 'SGJ/Q0901',
  nsqf_level: '4',
  module_hours: 3.0,
};

const structure = JSON.parse(readFileSync(input, 'utf8'));
const { modules } = structure;

const COURSE_NAME = structure.course_name ?? DEFAULTS.course_name;
const QP_CODE = structure.qp_code ?? DEFAULTS.qp_code;
const NSQF_LEVEL = structure.nsqf_level ?? DEFAULTS.nsqf_level;

/**
 * A module's duration. Courses whose modules are not all the same length state
 * each one's hours in the structure file; where none is stated the course-wide
 * default applies. Nothing here derives a duration from the content -- an
 * unstated module falls back to a stated constant, never to a computed guess.
 */
function moduleHours(m) {
  return m.hours ?? structure.module_hours ?? DEFAULTS.module_hours;
}

// ---------------------------------------------------------------------------
// Duration allocation
// ---------------------------------------------------------------------------

/**
 * Splits a module's 180 minutes across its units.
 *
 * Weighted by how many subtopics each unit carries, because that is the only
 * measure of relative size the source document states -- a unit with eleven
 * subtopics is doing more teaching than one with a single narrative heading.
 * Allocation is in 15-minute blocks with a one-block floor, and the largest
 * remainders take the leftover blocks, so the units always sum to exactly the
 * module's duration rather than to a rounded approximation of it.
 *
 * The weight is the subtopic count plus a constant. Some units are written as one
 * continuous narrative and are printed with a single unnumbered heading -- Unit
 * 6.2, Unit 9.2 -- so a raw count reads them as an eighth of the teaching in their
 * module when they are nearer half of it. The constant stops the count being
 * mistaken for a measure of length while leaving the ordering it does convey.
 */
const WEIGHT_FLOOR = 2;

function allocate(units, moduleMinutes) {
  const totalBlocks = moduleMinutes / BLOCK_MINS;
  if (units.length > totalBlocks) {
    throw new Error(`Module has ${units.length} units but only ${totalBlocks} blocks to give them.`);
  }
  const weights = units.map((u) => u.sub_topics.length + WEIGHT_FLOOR);
  const weightSum = weights.reduce((a, b) => a + b, 0);

  const spare = totalBlocks - units.length;
  const exact = weights.map((w) => (w / weightSum) * spare);
  const blocks = exact.map((e) => Math.floor(e));
  let left = spare - blocks.reduce((a, b) => a + b, 0);

  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) blocks[order[k % order.length].i] += 1;

  return blocks.map((b) => (b + 1) * BLOCK_MINS);
}

function hoursLabel(mins) {
  const hours = mins / 60;
  const text = hours.toFixed(2);
  const unit = hours === 1 ? 'Hour' : 'Hours';
  return `${text} ${unit} / ${mins} Mins`;
}

// ---------------------------------------------------------------------------
// Document body
// ---------------------------------------------------------------------------

const totalMinutes = modules.reduce((a, m) => a + moduleHours(m) * 60, 0);
const lines = [
  { text: COURSE_NAME, bold: true, size: 16, gap: 6 },
  {
    text:
      `Qualification Pack: ${QP_CODE} | NSQF Level: ${NSQF_LEVEL} | ` +
      `Total Duration: ${totalMinutes / 60} Hours (${totalMinutes.toLocaleString('en-US')} Mins)`,
    size: 9,
    gap: 10,
  },
];

const summary = [];

for (const m of modules) {
  const moduleMinutes = moduleHours(m) * 60;
  const minutes = allocate(m.units, moduleMinutes);
  lines.push({
    text: `Module ${m.module_number}: ${m.title} (${moduleHours(m).toFixed(1)} Hours)`,
    bold: true,
    size: 12,
    gap: 4,
    keepWith: 2,
  });

  m.units.forEach((u, i) => {
    const code = `${m.module_number}.${i + 1}`;
    lines.push({
      text: `UNIT ${code} ${u.title} (${hoursLabel(minutes[i])})`,
      bold: true,
      size: 10,
      gap: 2,
      indent: 0,
      keepWith: 1,
    });
    u.sub_topics.forEach((s, k) => {
      lines.push({ text: `${code}.${k + 1} ${s.title}`, size: 9.5, indent: 14, gap: 1 });
    });
    lines.push({ text: '', size: 4, gap: 0 });
    summary.push({ module: m.module_number, code, minutes: minutes[i], subs: u.sub_topics.length, title: u.title });
  });

  lines.push({ text: '', size: 6, gap: 0 });
}

// ---------------------------------------------------------------------------
// PDF writing
// ---------------------------------------------------------------------------

const PAGE_W = 595.28; // A4 points
const PAGE_H = 841.89;
const MARGIN_X = 54;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 52;

// Helvetica advance widths (1000 units/em) for the ASCII range, so lines wrap at
// their true rendered width rather than at a character count.
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

function widthOf(text, size, bold) {
  const table = bold ? W_BOLD : W_REG;
  let total = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    total += c >= 32 && c <= 126 ? table[c - 32] : 556;
  }
  return (total / 1000) * size;
}

/** Greedy wrap at the printable width, so no line runs into the margin. */
function wrap(text, size, bold, maxWidth) {
  if (!text) return [''];
  const words = text.split(' ');
  const out = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (widthOf(candidate, size, bold) <= maxWidth || !line) line = candidate;
    else {
      out.push(line);
      line = word;
    }
  }
  out.push(line);
  return out;
}

/** Latin-1 with PDF string escaping; the source has no characters beyond it. */
function pdfString(text) {
  return text
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

// Lay the wrapped lines out into pages.
const pages = [];
let current = [];
let y = PAGE_H - MARGIN_TOP;

for (let i = 0; i < lines.length; i++) {
  const item = lines[i];
  const font = item.bold ? 'F2' : 'F1';
  const indent = item.indent ?? 0;
  const size = item.size ?? 10;
  const pieces = wrap(item.text, size, !!item.bold, PAGE_W - MARGIN_X * 2 - indent);
  const leading = size * 1.28;
  const blockHeight = pieces.length * leading + (item.gap ?? 0);

  // A heading that would be stranded at the foot of a page moves with the lines
  // it introduces, so a module or unit never appears without its first content.
  let needed = blockHeight;
  for (let k = 1; k <= (item.keepWith ?? 0) && i + k < lines.length; k++) {
    const nxt = lines[i + k];
    needed += (nxt.size ?? 10) * 1.28 + (nxt.gap ?? 0);
  }

  if (y - needed < MARGIN_BOTTOM && current.length > 0) {
    pages.push(current);
    current = [];
    y = PAGE_H - MARGIN_TOP;
  }

  for (const piece of pieces) {
    if (y - leading < MARGIN_BOTTOM && current.length > 0) {
      pages.push(current);
      current = [];
      y = PAGE_H - MARGIN_TOP;
    }
    y -= leading;
    if (piece) current.push({ x: MARGIN_X + indent, y, size, font, text: piece });
  }
  y -= item.gap ?? 0;
}
if (current.length) pages.push(current);

// Assemble the file. Objects are written in order and their byte offsets
// recorded for the xref table.
const objects = [];
const add = (body) => {
  objects.push(body);
  return objects.length; // 1-based object number
};

const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

const pageObjectNumbers = [];
const pagesObjNumber = objects.length + pages.length * 2 + 1;

for (const page of pages) {
  const stream =
    'BT\n' +
    page
      .map(
        (t) =>
          `/${t.font} ${t.size.toFixed(2)} Tf 1 0 0 1 ${t.x.toFixed(2)} ${t.y.toFixed(2)} Tm ` +
          `(${pdfString(t.text)}) Tj`,
      )
      .join('\n') +
    '\nET';
  const contents = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  pageObjectNumbers.push(
    add(
      `<< /Type /Page /Parent ${pagesObjNumber} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
        `/Contents ${contents} 0 R >>`,
    ),
  );
}

const pagesObj = add(
  `<< /Type /Pages /Count ${pageObjectNumbers.length} /Kids [${pageObjectNumbers
    .map((n) => `${n} 0 R`)
    .join(' ')}] >>`,
);
if (pagesObj !== pagesObjNumber) throw new Error('Pages object number drifted from the reservation.');
const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

let pdf = '%PDF-1.4\n';
const offsets = [0];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefStart = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

writeFileSync(output, Buffer.from(pdf, 'latin1'));

// ---------------------------------------------------------------------------

console.error(`${pages.length} pages -> ${output}\n`);
let grand = 0;
for (const m of modules) {
  const rows = summary.filter((s) => s.module === m.module_number);
  const total = rows.reduce((a, r) => a + r.minutes, 0);
  const expected = moduleHours(m) * 60;
  grand += total;
  console.error(
    `Module ${m.module_number}: ${total} min ${total === expected ? 'OK ' : 'BAD'}  ${m.title}`,
  );
  for (const r of rows) {
    console.error(`    UNIT ${r.code.padEnd(5)} ${String(r.minutes).padStart(3)} min  ${String(r.subs).padStart(2)} sub  ${r.title.slice(0, 62)}`);
  }
}
console.error(`\nCourse total: ${grand} min (${grand / 60} hours)`);
