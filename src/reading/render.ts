/**
 * Plain-text rendering of a handbook unit.
 *
 * What a user wants at the end of the reading flow is text they can select and
 * copy, so the deliverable is the unit formatted to be read by a person rather
 * than parsed by a machine. The structured reading is still available from
 * read_ph_unit for anything that needs it.
 */

import type { PhUnitReading } from '../documents/ph-outline.js';

const RULE = '='.repeat(72);

function pageRange(from: number, to: number, printedFrom?: number, printedTo?: number): string {
  const pdf = from === to ? `p. ${from}` : `pp. ${from}-${to}`;
  if (printedFrom === undefined) return pdf;
  const printed = printedFrom === printedTo ? `p. ${printedFrom}` : `pp. ${printedFrom}-${printedTo}`;
  return `${pdf} (printed ${printed})`;
}

export function renderUnitReading(reading: PhUnitReading): string {
  return [
    RULE,
    `PARTICIPANT HANDBOOK - EXACT TEXT`,
    `${reading.subject_code ?? reading.course_id}  |  Module ${reading.unit.module_number}  |  ${reading.unit.heading}`,
    `${pageRange(
      reading.unit.pdf_page_start,
      reading.unit.pdf_page_end,
      reading.unit.printed_page_start,
      reading.unit.printed_page_end,
    )}  |  ${reading.word_count} words`,
    RULE,
    '',
    reading.text,
    '',
    RULE,
    `END OF UNIT ${reading.unit.unit_code}`,
    reading.fidelity_note,
    RULE,
  ].join('\n');
}
