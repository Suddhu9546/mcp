/**
 * PDF text extraction with page fidelity.
 *
 * Page numbers are load-bearing: every citation in a generated storyboard points
 * at a page, and a reviewer has to be able to open the PDF and find the claim.
 * So extraction preserves the PDF page index for every character, and detects the
 * page number printed on the page where one exists.
 */

import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface ExtractedPage {
  /** 1-based index within the PDF file. */
  pdf_page: number;
  /** Page number printed on the page, when one could be detected. */
  printed_page?: number;
  text: string;
}

export interface ExtractedDocument {
  file: string;
  page_count: number;
  pages: ExtractedPage[];
}

/**
 * Reassembles a page's text items into lines using their y-coordinates.
 *
 * pdfjs emits text items in content-stream order with no line structure. Naive
 * concatenation runs headings into body text and destroys the table-ish layout of
 * the timing document, so items are bucketed by baseline and sorted by x.
 */
function itemsToText(items: readonly TextItemLike[]): string {
  const lines = new Map<number, TextItemLike[]>();
  for (const item of items) {
    if (!item.str) continue;
    // transform is [a, b, c, d, e, f]; f is the y translation (the baseline).
    const y = Math.round((item.transform?.[5] ?? 0) * 2) / 2;
    const bucket = lines.get(y);
    if (bucket) bucket.push(item);
    else lines.set(y, [item]);
  }

  return [...lines.entries()]
    // PDF y-coordinates increase upward, so descending y is top-to-bottom.
    .sort((a, b) => b[0] - a[0])
    .map(([, bucket]) =>
      bucket
        .sort((a, b) => (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0))
        .map((i) => i.str)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join('\n');
}

interface TextItemLike {
  str: string;
  transform?: number[];
}

/**
 * Detects the page number printed on the page.
 *
 * SCGJ documents place it as a short standalone numeric line in the top or
 * bottom margin. Only the first and last few lines are considered, so a number
 * appearing in body text is not mistaken for a folio.
 */
function detectPrintedPage(text: string): number | undefined {
  const lines = text.split('\n');
  const candidates = [...lines.slice(0, 3), ...lines.slice(-3)];
  for (const line of candidates) {
    const m = /^(\d{1,4})$/.exec(line.trim());
    if (m?.[1]) {
      const n = Number(m[1]);
      if (n > 0 && n < 5000) return n;
    }
  }
  return undefined;
}

export async function extractPdf(file: string): Promise<ExtractedDocument> {
  const data = new Uint8Array(await readFile(file));
  const doc = await getDocument({
    data,
    // Node has no canvas/DOM; these keep pdfjs from reaching for browser APIs.
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;

  const pages: ExtractedPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        const text = itemsToText(content.items as TextItemLike[]);
        const printed = detectPrintedPage(text);
        pages.push({
          pdf_page: i,
          ...(printed !== undefined ? { printed_page: printed } : {}),
          text,
        });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }

  return { file, page_count: doc.numPages, pages };
}

/**
 * Concatenates pages into one string while retaining a character-offset to
 * page-number index.
 *
 * The timing document's module headings straddle page breaks -- "Module 6: ...
 * (6.0" ends page 4 and "Hours)" begins page 5 -- so the parser has to see one
 * continuous string. This keeps the page lookup available for citations.
 */
export interface OffsetMappedText {
  text: string;
  /** Ascending by `start`. */
  spans: { start: number; end: number; pdf_page: number; printed_page?: number }[];
}

export function joinPages(pages: readonly ExtractedPage[], separator = '\n'): OffsetMappedText {
  let text = '';
  const spans: OffsetMappedText['spans'] = [];
  for (const page of pages) {
    const start = text.length;
    text += page.text + separator;
    spans.push({
      start,
      end: text.length,
      pdf_page: page.pdf_page,
      ...(page.printed_page !== undefined ? { printed_page: page.printed_page } : {}),
    });
  }
  return { text, spans };
}

/** Resolves a character offset in `joinPages` output back to its source page. */
export function pageAtOffset(
  mapped: OffsetMappedText,
  offset: number,
): { pdf_page: number; printed_page?: number } {
  // Binary search; documents can run to hundreds of pages and this is called per
  // match during parsing and chunking.
  let lo = 0;
  let hi = mapped.spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = mapped.spans[mid]!;
    if (offset < span.start) hi = mid - 1;
    else if (offset >= span.end) lo = mid + 1;
    else return { pdf_page: span.pdf_page, ...(span.printed_page !== undefined ? { printed_page: span.printed_page } : {}) };
  }
  const last = mapped.spans[mapped.spans.length - 1];
  if (!last) throw new Error('joinPages produced no spans; the document is empty.');
  return { pdf_page: last.pdf_page, ...(last.printed_page !== undefined ? { printed_page: last.printed_page } : {}) };
}
