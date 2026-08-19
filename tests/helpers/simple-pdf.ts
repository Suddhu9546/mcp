/**
 * A minimal PDF writer, for test fixtures.
 *
 * The CDR flow cannot be tested end to end without reference documents, and the
 * real ones are not supplied yet. Rather than leave the flow unproven until they
 * arrive, tests generate stand-in PDFs with this: real PDFs, extractable by the
 * same pdfjs path production uses, carrying text a retrieval query can actually
 * match. What they do not carry is real curriculum content, which is fine --
 * these tests are about routing, scoping and completion, not about wording.
 *
 * Uncompressed, Helvetica, no external dependency. The output is deliberately
 * plain: anything cleverer would be testing the fixture rather than the server.
 */

import { writeFileSync } from 'node:fs';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 54;
const SIZE = 11;
const LEADING = SIZE * 1.4;

/** Latin-1 with PDF string escaping. Fixture text stays inside that range. */
function escapeText(text: string): string {
  return text
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Greedy wrap at a fixed character count; exact metrics do not matter here. */
function wrap(line: string, columns = 88): string[] {
  if (line.length <= columns) return [line];
  const words = line.split(' ');
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= columns || !current) current = candidate;
    else {
      out.push(current);
      current = word;
    }
  }
  out.push(current);
  return out;
}

/**
 * Writes `lines` as a PDF at `file`, paginating as needed.
 *
 * A blank string emits a blank line, so a caller can shape headings and
 * paragraphs the chunker will see as separate blocks.
 */
export function writeSimplePdf(file: string, lines: readonly string[]): void {
  const wrapped = lines.flatMap((l) => (l === '' ? [''] : wrap(l)));
  const perPage = Math.floor((PAGE_H - MARGIN * 2) / LEADING);
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += perPage) pages.push(wrapped.slice(i, i + perPage));
  if (pages.length === 0) pages.push(['']);

  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageNumbers: number[] = [];
  // Reserved so each Page can name its parent before the Pages object exists.
  const pagesObjNumber = objects.length + pages.length * 2 + 1;

  for (const page of pages) {
    const stream =
      'BT\n' +
      page
        .map((text, i) => {
          const y = PAGE_H - MARGIN - (i + 1) * LEADING;
          return text === ''
            ? ''
            : `/F1 ${SIZE} Tf 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${escapeText(text)}) Tj`;
        })
        .filter(Boolean)
        .join('\n') +
      '\nET';
    const contents = add(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
    pageNumbers.push(
      add(
        `<< /Type /Page /Parent ${pagesObjNumber} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents} 0 R >>`,
      ),
    );
  }

  const pagesObj = add(
    `<< /Type /Pages /Count ${pageNumbers.length} /Kids [${pageNumbers
      .map((n) => `${n} 0 R`)
      .join(' ')}] >>`,
  );
  if (pagesObj !== pagesObjNumber) throw new Error('Pages object number drifted from its reservation.');
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  writeFileSync(file, Buffer.from(pdf, 'latin1'));
}
