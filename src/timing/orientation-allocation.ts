/**
 * Durations for an Orientation course, which has no Timing Allocation Document.
 *
 * INVARIANT 3 says durations are read, never computed by judgement. For the
 * Entrepreneur and CDR programmes the thing read is a document. Orientation
 * issues no such document, because there is nothing per-subject to state: every
 * Orientation subject runs the same shape, and that shape is the programme's own
 * constant.
 *
 *   3 modules, 1 hour each                          -> 3 hours (180 mins)
 *   Part B  15 mins   (fixed, five 3-minute segments, as the template has it)
 *   Part C  15 mins   (fixed, seven slides, as the template has it)
 *   Part A  30 mins   (the rest of the hour)
 *
 * So this file is not a second timing authority competing with the parser; it is
 * the same authority written down in the only place it exists for this programme.
 * Every number here is a stated constant, and none of them varies by subject --
 * which is the point, and is what the storyboard's Total Duration line reports.
 *
 * What *is* per-subject is the structure the hours are spread over: which
 * handbook chapters each module covers, and which handbook units each Part A row
 * covers. Both are read from the ingested Participant Handbook, so a handbook
 * revision is picked up by re-ingesting rather than by editing code.
 */

import { getCourseConfig, getCrosswalkEntry } from '../courses/course-config.js';
import { getPhOutline, type PhModule, type PhUnit } from '../documents/ph-outline.js';
import type { SourceRef } from '../types/source.js';
import type { TimingAllocation, TimingModule, TimingSubTopic, TimingUnit } from '../types/timing.js';

/** The programme constants. Not per-subject, not derived, not adjustable. */
export const ORIENTATION_MODULE_MINUTES = 60;
export const ORIENTATION_PART_A_ROWS = 3;

export class OrientationAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrientationAllocationError';
  }
}

/**
 * Splits `count` items into at most `buckets` contiguous spans, largest first.
 *
 * The same rule that groups chapters into modules, applied one level down to group
 * a module's handbook units into its Part A rows. Returns fewer spans than
 * `buckets` only when there are fewer items than buckets, so a module with two
 * units gets two rows rather than a row with nothing in it.
 */
function spans<T>(items: readonly T[], buckets: number): T[][] {
  const n = Math.min(buckets, items.length);
  if (n === 0) return [];
  const base = Math.floor(items.length / n);
  const remainder = items.length % n;
  const out: T[][] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < remainder ? 1 : 0);
    out.push(items.slice(at, at + size));
    at += size;
  }
  return out;
}

/**
 * Divides a module's minutes across its Part A rows in whole minutes.
 *
 * Three rows into 60 minutes is exact. The rounding branch exists for a module
 * that ended up with one or two rows because its chapters carry that few units:
 * the remainder goes to the first row, so the rows still sum to the module
 * exactly rather than to a rounded approximation of it.
 */
function divide(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const out = Array.from({ length: parts }, () => base);
  out[0] = base + (total - base * parts);
  return out;
}

/** A citation to the handbook page a Part A row's first unit starts on. */
function unitRef(unit: PhUnit): SourceRef {
  return {
    document_type: 'PH',
    pdf_page: unit.pdf_page_start,
    ...(unit.printed_page_start !== undefined ? { printed_page: unit.printed_page_start } : {}),
    section: unit.heading,
    chunk_id: `ph:${unit.unit_code}`,
  };
}

/**
 * The label for a Part A row that covers several handbook units.
 *
 * A row is 10 minutes of a 30-minute Part A and covers two to seven handbook
 * units, so no single unit title describes it. The covered unit codes are named
 * as a range and their titles listed, both verbatim, so a reader can see exactly
 * which handbook material the row is accountable for. Long lists are elided
 * rather than paraphrased -- the row's teaching description is written by the
 * client into `interactive_description`, and inventing a theme name here would
 * put unsourced wording into a structural field.
 */
const LABEL_BUDGET = 120;

function rowTitle(units: readonly PhUnit[]): string {
  const titles = units.map((u) => u.title.trim()).filter(Boolean);
  let out = '';
  for (let i = 0; i < titles.length; i++) {
    const next = out ? `${out}; ${titles[i]}` : titles[i]!;
    if (next.length > LABEL_BUDGET && out) return `${out}; and ${titles.length - i} more`;
    out = next;
  }
  return out;
}

function rowCode(units: readonly PhUnit[]): string {
  const first = units[0]!.unit_code;
  const last = units[units.length - 1]!.unit_code;
  return first === last ? first : `${first}-${last}`;
}

function buildUnits(
  moduleNumber: number,
  phUnits: readonly PhUnit[],
  moduleMinutes: number,
): TimingUnit[] {
  const groups = spans(phUnits, ORIENTATION_PART_A_ROWS);
  const minutes = divide(moduleMinutes, groups.length);

  return groups.map((group, i) => {
    // The unit code is the storyboard's own -- 1.1, 1.2, 1.3 -- because Part A
    // rows are numbered per storyboard module and a clubbed module's handbook
    // codes do not run consecutively. The handbook codes the row covers are
    // carried as its sub-topics, so nothing about the mapping is lost.
    const code = `${moduleNumber}.${i + 1}`;
    const subTopics: TimingSubTopic[] = group.map((u) => ({
      code: u.unit_code,
      title: u.title,
    }));
    return {
      code,
      title: rowTitle(group),
      minutes: minutes[i]!,
      stated_hours: minutes[i]! / 60,
      raw_duration: `${minutes[i]} mins (Orientation programme constant)`,
      sub_topics: subTopics,
      source: unitRef(group[0]!),
    };
  });
}

/**
 * Builds the fixed allocation for one Orientation course from its handbook.
 *
 * Requires the handbook to have been ingested: the module and unit structure is
 * read from the chunk index, not declared in code. Throws rather than falling back
 * on the chapter titles alone, because a Part A row that named no handbook units
 * would be a row nobody could check.
 */
export function buildOrientationAllocation(courseId: string): TimingAllocation {
  const course = getCourseConfig(courseId);
  if (course.track !== 'orientation') {
    throw new OrientationAllocationError(
      `Course "${courseId}" is on the ${course.track} track. Only Orientation courses take their ` +
        'durations from the programme constant; the others have a Timing Allocation Document.',
    );
  }

  const outline = getPhOutline(courseId);
  if (outline.modules.length === 0) {
    throw new OrientationAllocationError(
      `The Participant Handbook for "${courseId}" has not been indexed, so its chapters and units ` +
        'are unknown. Run ingest_course_documents for this course first.',
    );
  }

  const byChapter = new Map<number, PhModule>(outline.modules.map((m) => [m.module_number, m]));

  const modules: TimingModule[] = course.crosswalk.map((entry) => {
    const chapters = entry.source_chapters ?? [entry.source_chapter];
    const phUnits = chapters.flatMap((c) => byChapter.get(c)?.units ?? []);
    if (phUnits.length === 0) {
      throw new OrientationAllocationError(
        `Module ${entry.timing_module} of "${courseId}" covers handbook chapter(s) ` +
          `${chapters.join(', ')}, but the index holds no units for them. Re-ingest the handbook ` +
          'and check this course\'s chapter_titles against its contents page.',
      );
    }

    const first = byChapter.get(chapters[0]!);
    return {
      number: entry.timing_module,
      title: entry.timing_title,
      minutes: ORIENTATION_MODULE_MINUTES,
      stated_hours: ORIENTATION_MODULE_MINUTES / 60,
      raw_duration: `${ORIENTATION_MODULE_MINUTES} mins (Orientation programme constant)`,
      units: buildUnits(entry.timing_module, phUnits, ORIENTATION_MODULE_MINUTES),
      source: first?.units[0] ? unitRef(first.units[0]) : {
        document_type: 'PH',
        pdf_page: 1,
        section: entry.timing_title,
        chunk_id: `ph:chapter:${chapters[0]}`,
      },
    };
  });

  const totalMinutes = modules.reduce((a, m) => a + m.minutes, 0);

  return {
    course_id: courseId,
    qp_code: course.qp_code,
    nsqf_level: course.nsqf_level,
    stated_total_minutes: totalMinutes,
    stated_total_hours: totalMinutes / 60,
    modules,
    // Filled in by the validator, exactly as for a parsed document, so the same
    // arithmetic check runs over this allocation as over a real one.
    arithmetic: {
      course_total_ok: true,
      all_modules_ok: true,
      computed_total_minutes: totalMinutes,
      discrepancies: [],
    },
  };
}

/** True when this course's durations come from the programme rather than a document. */
export function usesProgrammeTiming(courseId: string): boolean {
  return getCourseConfig(courseId).track === 'orientation';
}

/** Re-exported so callers need not reach into course-config for the crosswalk. */
export function orientationChaptersFor(courseId: string, moduleNumber: number): number[] {
  const entry = getCrosswalkEntry(courseId, moduleNumber);
  return entry.source_chapters ?? [entry.source_chapter];
}
