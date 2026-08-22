/**
 * Plain-text rendering.
 *
 * The video flows deliberately produce no file. What a user wants at the end of
 * this flow is a script they can select, copy and paste into a teleprompter, an
 * editing timeline or a message -- so the deliverable is text in the tool result,
 * formatted to be read by a person rather than parsed by a machine. The structured
 * state is still available from get_video_transcript for anything that needs it.
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
