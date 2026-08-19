/**
 * Parser for the Timing Allocation Document.
 *
 * INVARIANT 3: this file is the only place durations enter the system. It reads
 * them; it never computes, rounds, distributes or infers them. If a duration
 * cannot be read from the document, the parser reports the gap and refuses --
 * that failure is the correct outcome, not a reason to fall back on judgement.
 *
 * Structure of "Bio-fuels- Duration Breakdown.pdf":
 *
 *   Bio-Fuels
 *   Qualification Pack: SGJ/Q4102 | NSQF Level: 4 | Total Duration: 30 Hours (1,800 Mins)
 *   Module 1: Entrepreneurship and Basics of Biomass Energy (3.0 Hours)
 *   UNIT 1.1 Fundamentals of Biofuels & Biomass Energy (0.75 Hours / 45 Mins)
 *     1.1.1 Biofuels definition, role in sustainable energy & 1st to 4th generation fuels
 *     1.1.2 Types of biofuels: Solid (firewood, pellets), Liquid (ethanol, biodiesel), ...
 *
 * Headings straddle page breaks, so parsing runs over the page-joined text with
 * an offset-to-page index rather than page by page.
 */

import type { SourceRef } from '../types/source.js';
import type {
  TimingAllocation,
  TimingModule,
  TimingSubTopic,
  TimingUnit,
} from '../types/timing.js';
import { extractPdf, joinPages, pageAtOffset, type OffsetMappedText } from '../documents/pdf-extractor.js';

export class TimingParseError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'TimingParseError';
  }
}

/**
 * Collapses the erratic whitespace that PDF extraction leaves behind (the
 * Biofuels timing document renders every space as two) without changing any
 * character offsets, so the page index stays valid.
 */
function normalizeInPlace(text: string): string {
  return text.replace(/[ \t ]+/g, ' ').replace(/\r/g, ' ');
}

/**
 * Whitespace normalisation that preserves length, so `pageAtOffset` lookups
 * against the original offsets remain correct after normalising.
 */
function normalizePreservingOffsets(text: string): string {
  // Newlines become spaces so that a heading split across lines matches as one
  // run. Length is unchanged because it is a 1:1 character substitution.
  return text.replace(/[\r\n \t]/g, ' ');
}

const HEADER_RE =
  /Qualification\s+Pack\s*:\s*(\S+)\s*\|\s*NSQF\s+Level\s*:\s*(\S+?)\s*\|\s*Total\s+Duration\s*:\s*([\d.,]+)\s*Hours?\s*\(\s*([\d.,]+)\s*Mins?\s*\)/i;

/**
 * Module headings.
 *
 * The title itself may contain parenthesised groups -- "Manufacturing of Biomass
 * Pellets (Elective 1)", "HSE (Health, Safety & Environment)" -- so the title is
 * matched lazily and the duration is whichever trailing "(<n> Hours)" group comes
 * first. The lookaheads stop a module whose duration is missing from swallowing
 * the following module or unit headings, which would otherwise silently attach
 * another module's units to this one.
 */
const MODULE_RE =
  /Module\s+(\d+)\s*:\s*((?:(?!Module\s+\d+\s*:)(?!UNIT\s+\d+\.)[\s\S]){1,200}?)\s*\(\s*(\d+(?:\.\d+)?)\s*Hours?\s*\)/gi;

const UNIT_RE =
  /UNIT\s+(\d+\.\d+)\s+(.+?)\s*\(\s*(\d+(?:\.\d+)?)\s*Hours?\s*\/\s*(\d+)\s*Mins?\s*\)/gi;

const SUBTOPIC_RE = /(\d+\.\d+\.\d+)\s+(.+?)(?=\s+\d+\.\d+\.\d+\s|$)/g;

const ELECTIVE_RE = /\(\s*Elective\s+(\d+)\s*\)/i;

function toNumber(raw: string): number {
  const n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new TimingParseError(`Could not read a number from "${raw}".`);
  return n;
}

function makeRef(mapped: OffsetMappedText, offset: number, section: string, chunkId: string): SourceRef {
  const page = pageAtOffset(mapped, offset);
  return {
    document_type: 'TIMING',
    pdf_page: page.pdf_page,
    ...(page.printed_page !== undefined ? { printed_page: page.printed_page } : {}),
    section,
    chunk_id: chunkId,
  };
}

/** Splits the trailing sub-topic run off a unit title match. */
function splitUnitTitleAndSubTopics(rest: string): { subTopics: TimingSubTopic[] } {
  const subTopics: TimingSubTopic[] = [];
  SUBTOPIC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SUBTOPIC_RE.exec(rest)) !== null) {
    const code = m[1];
    const title = m[2]?.trim();
    if (code && title) subTopics.push({ code, title: title.replace(/\s+/g, ' ') });
  }
  return { subTopics };
}

export function parseTimingText(courseId: string, mapped: OffsetMappedText): TimingAllocation {
  const text = normalizePreservingOffsets(mapped.text);

  const header = HEADER_RE.exec(text);
  if (!header) {
    throw new TimingParseError(
      'The Timing Allocation Document has no parseable header line. Expected ' +
        '"Qualification Pack: <code> | NSQF Level: <n> | Total Duration: <n> Hours (<n> Mins)". ' +
        'Refusing to generate rather than assume a course duration.',
    );
  }
  const [, qpCode = '', nsqfLevel = '', statedHoursRaw = '', statedMinsRaw = ''] = header;

  // Locate every module heading first, so each module's body is the span between
  // its own heading and the next one.
  const moduleHeads: { number: number; title: string; hours: number; raw: string; index: number; bodyStart: number }[] = [];
  MODULE_RE.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = MODULE_RE.exec(text)) !== null) {
    const [raw, numRaw, titleRaw, hoursRaw] = mm;
    if (!numRaw || !titleRaw || !hoursRaw) continue;
    moduleHeads.push({
      number: toNumber(numRaw),
      title: normalizeInPlace(titleRaw).trim(),
      hours: toNumber(hoursRaw),
      raw: normalizeInPlace(raw).trim(),
      index: mm.index,
      bodyStart: mm.index + raw.length,
    });
  }

  if (moduleHeads.length === 0) {
    throw new TimingParseError(
      'No module headings found in the Timing Allocation Document. Expected ' +
        '"Module <n>: <title> (<n> Hours)".',
    );
  }

  const modules: TimingModule[] = moduleHeads.map((head, i) => {
    const bodyEnd = moduleHeads[i + 1]?.index ?? text.length;
    const body = text.slice(head.bodyStart, bodyEnd);

    const electiveMatch = ELECTIVE_RE.exec(head.title);
    const elective = electiveMatch?.[1] ? toNumber(electiveMatch[1]) : undefined;
    const cleanTitle = head.title.replace(ELECTIVE_RE, '').replace(/\s+/g, ' ').trim();

    // Find the unit headings within this module's span.
    const unitHeads: { code: string; title: string; hours: number; mins: number; raw: string; offset: number; bodyStart: number }[] = [];
    UNIT_RE.lastIndex = 0;
    let um: RegExpExecArray | null;
    while ((um = UNIT_RE.exec(body)) !== null) {
      const [raw, code, titleRaw, hoursRaw, minsRaw] = um;
      if (!code || !titleRaw || !hoursRaw || !minsRaw) continue;
      unitHeads.push({
        code,
        title: normalizeInPlace(titleRaw).trim(),
        hours: toNumber(hoursRaw),
        mins: toNumber(minsRaw),
        raw: normalizeInPlace(raw).trim(),
        offset: head.bodyStart + um.index,
        bodyStart: head.bodyStart + um.index + raw.length,
      });
    }

    const units: TimingUnit[] = unitHeads.map((u, ui) => {
      const unitBodyEnd = unitHeads[ui + 1]?.offset ?? bodyEnd;
      const unitBody = normalizeInPlace(text.slice(u.bodyStart, unitBodyEnd));
      const { subTopics } = splitUnitTitleAndSubTopics(unitBody);
      return {
        code: u.code,
        title: u.title,
        minutes: u.mins,
        stated_hours: u.hours,
        raw_duration: `${u.hours} Hours / ${u.mins} Mins`,
        sub_topics: subTopics,
        source: makeRef(mapped, u.offset, `Module ${head.number} / UNIT ${u.code}`, `timing:${courseId}:unit:${u.code}`),
      };
    });

    if (units.length === 0) {
      throw new TimingParseError(
        `Module ${head.number} ("${cleanTitle}") has no parseable units in the Timing ` +
          'Allocation Document. Expected "UNIT <n>.<n> <title> (<n> Hours / <n> Mins)". ' +
          'Refusing to distribute the module duration by judgement.',
      );
    }

    return {
      number: head.number,
      title: cleanTitle,
      minutes: Math.round(head.hours * 60),
      stated_hours: head.hours,
      raw_duration: `${head.hours} Hours`,
      ...(elective !== undefined ? { elective } : {}),
      units,
      source: makeRef(mapped, head.index, `Module ${head.number}`, `timing:${courseId}:module:${head.number}`),
    };
  });

  const allocation: TimingAllocation = {
    course_id: courseId,
    qp_code: qpCode,
    nsqf_level: nsqfLevel,
    stated_total_minutes: toNumber(statedMinsRaw),
    stated_total_hours: toNumber(statedHoursRaw),
    modules,
    // Filled in by the validator; parsing does not judge its own output.
    arithmetic: {
      course_total_ok: false,
      all_modules_ok: false,
      computed_total_minutes: 0,
      discrepancies: [],
    },
  };

  return allocation;
}

export async function parseTimingDocument(courseId: string, file: string): Promise<TimingAllocation> {
  const extracted = await extractPdf(file);
  const mapped = joinPages(extracted.pages);
  return parseTimingText(courseId, mapped);
}
