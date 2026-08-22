/**
 * Deterministic planning of a module's 12-minute content package.
 *
 * Three constraints have to hold simultaneously, and none of them survives being
 * left to judgement:
 *
 *   - the video is exactly eighteen 10-second segments, because the generator
 *     accepts ten seconds at a time and a segment that overruns cannot be produced;
 *   - the deck is exactly fourteen slides carrying nine minutes between them;
 *   - together they cover every unit of the module, none skipped, none doubled up
 *     by accident.
 *
 * So the arithmetic is done here. Each segment and slide is handed the unit it
 * covers, the portion of that unit's text it is responsible for, and the number of
 * words that fits its seconds. The client writes the words; it does not decide what
 * gets covered or how long anything runs.
 *
 * Allocation is proportional to how much text each unit holds, with a floor of one
 * item per unit -- a short unit still gets a segment and a slide, because "cover all
 * units" is the requirement, not "cover the long ones".
 */

import type { PhModuleReading, PhUnitReading } from '../documents/ph-outline.js';
import { getModuleLearningOutcomes } from '../documents/learning-outcomes.js';
import {
  MAX_SLIDE_COUNT,
  MAX_SLIDE_SECONDS,
  MIN_SLIDE_COUNT,
  PART_1_SEGMENTS,
  PART_2_SEGMENTS,
  SEGMENT_SECONDS,
  SLIDE_DECK_SECONDS,
  VIDEO_PART_SPEC,
  VIDEO_SECONDS,
  VIDEO_SEGMENT_COUNT,
  type ModulePlan,
  type ModuleUnitSummary,
  type PlannedSegment,
  type ModuleContentMap,
  type PlannedSlide,
  type StoryBeat,
  type UnitAllocation,
  type VideoPart,
} from '../types/module-content.js';
import { DEFAULT_WORDS_PER_MINUTE, timecode } from './scene-plan.js';
import { conclusionBeat, orientationBeat, unitBeat } from './story-beats.js';

/** Ten seconds of speech is short; the band has to be tight or the segment overruns. */
const SEGMENT_WORD_TOLERANCE = 0.25;
const NOTES_WORD_TOLERANCE = 0.2;
const EXCERPT_CHARS = 400;

export class ModulePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModulePlanError';
  }
}

/**
 * Splits `total` items across weighted buckets, giving every bucket at least `min`.
 *
 * Largest-remainder, so the parts always sum to exactly `total` -- important here,
 * since eighteen segments must be eighteen segments however the weights fall.
 */
function allocate(weights: readonly number[], total: number, min = 1): number[] {
  const count = weights.length;
  if (count === 0) return [];
  if (total < count * min) {
    throw new ModulePlanError(
      `Cannot give each of ${count} units at least ${min} of ${total} items.`,
    );
  }

  const sum = weights.reduce((a, w) => a + w, 0);
  const remaining = total - count * min;
  const exact = weights.map((w) => (sum === 0 ? remaining / count : (w / sum) * remaining));
  const floors = exact.map(Math.floor);
  let left = remaining - floors.reduce((a, f) => a + f, 0);

  // Hand the leftovers to the largest fractional parts, so the biggest units get
  // the extra coverage rather than whichever happened to be first.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const extra = new Array<number>(count).fill(0);
  for (const { index } of order) {
    if (left <= 0) break;
    extra[index] = 1;
    left -= 1;
  }

  return floors.map((f, i) => min + f + extra[i]!);
}

/** Divides one unit's blocks into `parts` contiguous groups by character count. */
function splitUnit(unit: PhUnitReading, parts: number): { text: string; chunkIds: string[]; pages: number[] }[] {
  const groups: { text: string[]; chunkIds: string[]; pages: number[] }[] = Array.from(
    { length: parts },
    () => ({ text: [], chunkIds: [], pages: [] }),
  );
  const total = unit.blocks.reduce((a, b) => a + b.char_count, 0);

  let cumulative = 0;
  for (const block of unit.blocks) {
    const midpoint = cumulative + block.char_count / 2;
    const slot = total === 0 ? 0 : Math.floor((midpoint / total) * parts);
    const group = groups[Math.min(slot, parts - 1)]!;
    group.text.push(block.text);
    group.chunkIds.push(block.chunk_id);
    group.pages.push(block.pdf_page);
    cumulative += block.char_count;
  }

  // Rounding can leave a group empty; it borrows from its neighbour rather than
  // being left with nothing to write from.
  for (let i = 0; i < groups.length; i++) {
    if (groups[i]!.text.length > 0) continue;
    const donor = groups[i - 1] ?? groups.find((g) => g.text.length > 0);
    if (donor && donor.text.length > 0) {
      groups[i]!.text.push(donor.text[donor.text.length - 1]!);
      groups[i]!.chunkIds.push(donor.chunkIds[donor.chunkIds.length - 1]!);
      groups[i]!.pages.push(donor.pages[donor.pages.length - 1]!);
    }
  }

  return groups.map((g) => ({
    text: g.text.join('\n'),
    chunkIds: [...new Set(g.chunkIds)],
    pages: [...new Set(g.pages)],
  }));
}

function countWords(text: string): number {
  const matched = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu);
  return matched ? matched.length : 0;
}

/** One unit-portion assignment, shared by segments and slides. */
interface Assignment extends UnitAllocation {
  full_text: string;
}

/**
 * Assigns `count` items across the module's units, in handbook order.
 *
 * Returns one assignment per item, so item i knows its unit, its portion of that
 * unit, and the text it must be written from.
 */
function assign(units: readonly PhUnitReading[], count: number): Assignment[] {
  const perUnit = allocate(units.map((u) => u.char_count), count);
  const assignments: Assignment[] = [];

  units.forEach((unit, unitIndex) => {
    const parts = perUnit[unitIndex]!;
    const groups = splitUnit(unit, parts);
    groups.forEach((group, partIndex) => {
      assignments.push({
        unit_code: unit.unit.unit_code,
        unit_title: unit.unit.title,
        portion: `${partIndex + 1} of ${parts}`,
        source_chunk_ids: group.chunkIds,
        source_pages: group.pages,
        source_excerpt:
          group.text.length > EXCERPT_CHARS ? `${group.text.slice(0, EXCERPT_CHARS)}...` : group.text,
        source_word_count: countWords(group.text),
        full_text: group.text,
      });
    });
  });

  return assignments;
}

/**
 * The per-segment brief.
 *
 * The story beat says what the segment must do for the film; the allocation says
 * which handbook material it must do it with. Both are stated on every segment
 * because a writer given only the material writes a lecture, and a writer given
 * only the beat writes fiction.
 */
function segmentPurpose(beat: StoryBeat, part: VideoPart, outcomes: readonly string[]): string {
  const material =
    part === 2
      ? ' Carry the handbook material allocated below: the beat decides how it is dramatised, the ' +
        'material decides what is true.'
      : ' Draw on the module as a whole; introduce no fact its units do not support.';
  const stated =
    outcomes.length > 0
      ? ` The handbook states these outcomes for this segment to carry: ${outcomes
          .map((o) => `"${o}"`)
          .join('; ')}.`
      : '';
  return `Part ${part} (${VIDEO_PART_SPEC[part].name}) - ${beat.beat}. ${beat.story_function}${material}${stated}`;
}

/**
 * Groups the module's units across the nine teaching segments.
 *
 * Two directions to handle, and the requirement is the same in both: no unit is
 * skipped. With nine or fewer units each unit gets at least one segment and the
 * longer ones get more. With more than nine, units are grouped so a segment teaches
 * two or three related units together -- compressed, but present, which is what
 * "never skip a unit merely because time is limited" means in practice.
 */
interface TeachingSlot {
  units: PhUnitReading[];
  positionInUnit: number;
  segmentsForUnit: number;
  portionIndex: number;
  portionCount: number;
}

function teachingSlots(units: readonly PhUnitReading[], slots: number): TeachingSlot[] {
  if (units.length <= slots) {
    const perUnit = allocate(units.map((u) => u.char_count), slots);
    const out: TeachingSlot[] = [];
    units.forEach((unit, unitIndex) => {
      const count = perUnit[unitIndex]!;
      for (let i = 0; i < count; i++) {
        out.push({
          units: [unit],
          positionInUnit: i,
          segmentsForUnit: count,
          portionIndex: i,
          portionCount: count,
        });
      }
    });
    return out;
  }

  // More units than segments: contiguous groups, so a segment teaches several
  // related units together rather than any unit being dropped.
  const groups: PhUnitReading[][] = Array.from({ length: slots }, () => []);
  const total = units.reduce((a, u) => a + u.char_count, 0);
  let cumulative = 0;
  for (const unit of units) {
    const midpoint = cumulative + unit.char_count / 2;
    const slot = total === 0 ? 0 : Math.floor((midpoint / total) * slots);
    groups[Math.min(slot, slots - 1)]!.push(unit);
    cumulative += unit.char_count;
  }
  for (let i = 0; i < groups.length; i++) {
    if (groups[i]!.length > 0) continue;
    const donor = groups.find((g) => g.length > 1);
    if (donor) groups[i]!.push(donor.pop()!);
  }
  return groups.map((group) => ({
    units: group,
    positionInUnit: 0,
    segmentsForUnit: 1,
    portionIndex: 0,
    portionCount: 1,
  }));
}


export interface BuildModulePlanOptions {
  reading: PhModuleReading;
  wordsPerMinute?: number;
}

export function buildModulePlan(options: BuildModulePlanOptions): ModulePlan {
  const { reading } = options;
  const wpm = options.wordsPerMinute ?? DEFAULT_WORDS_PER_MINUTE;
  if (!Number.isFinite(wpm) || wpm < 60 || wpm > 220) {
    throw new ModulePlanError(`words_per_minute must be between 60 and 220, got ${wpm}.`);
  }
  if (reading.units.length === 0) {
    throw new ModulePlanError(`Module ${reading.module_number} has no units to build content from.`);
  }

  // What the handbook itself says this module is for. Part 1 is built from these,
  // and where the module states none, its units' outcomes stand in.
  const outcomes = getModuleLearningOutcomes(
    reading.course_id,
    reading.module_number,
    reading.units.map((u) => ({ unit_code: u.unit.unit_code, unit_title: u.unit.title })),
  );
  const moduleOutcomes =
    outcomes.module_outcomes.length > 0
      ? outcomes.module_outcomes.map((o) => o.text)
      : outcomes.unit_outcomes.flatMap((u) => u.outcomes.map((o) => o.text));

  const wholeModule: Assignment = {
    unit_code: reading.units.map((u) => u.unit.unit_code).join(', '),
    unit_title: reading.module_title,
    portion: 'whole module',
    source_chunk_ids: reading.units.flatMap((u) => u.chunk_ids),
    source_pages: [...new Set(reading.units.map((u) => u.unit.pdf_page_start))],
    source_excerpt: reading.units[0]!.text.slice(0, EXCERPT_CHARS),
    source_word_count: reading.word_count,
    full_text: reading.units.map((u) => u.text).join('\n\n'),
  };

  // --- Part 2 first: the teaching section decides how the units divide up. ---
  const slots = teachingSlots(reading.units, PART_2_SEGMENTS);
  const teachingAllocations: Assignment[] = slots.map((slot) => {
    if (slot.units.length === 1) {
      const unit = slot.units[0]!;
      const group = splitUnit(unit, slot.portionCount)[slot.portionIndex]!;
      return {
        unit_code: unit.unit.unit_code,
        unit_title: unit.unit.title,
        portion: `${slot.portionIndex + 1} of ${slot.portionCount}`,
        source_chunk_ids: group.chunkIds,
        source_pages: group.pages,
        source_excerpt:
          group.text.length > EXCERPT_CHARS ? `${group.text.slice(0, EXCERPT_CHARS)}...` : group.text,
        source_word_count: countWords(group.text),
        full_text: group.text,
      };
    }
    // Several short units sharing one segment: all of them, compressed together.
    const text = slot.units
      .map((u) => `[Unit ${u.unit.unit_code} - ${u.unit.title}]\n${u.text}`)
      .join('\n\n');
    return {
      unit_code: slot.units.map((u) => u.unit.unit_code).join(', '),
      unit_title: slot.units.map((u) => u.unit.title).join(' + '),
      portion: `${slot.units.length} units together`,
      source_chunk_ids: slot.units.flatMap((u) => u.chunk_ids),
      source_pages: [...new Set(slot.units.map((u) => u.unit.pdf_page_start))],
      source_excerpt: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}...` : text,
      source_word_count: countWords(text),
      full_text: text,
    };
  });

  // Part 1's six segments carry the module's stated outcomes: segments 4 and 5 take
  // them explicitly, the rest orient.
  const outcomeSegments = [4, 5];
  const outcomeSplit = splitList(moduleOutcomes, outcomeSegments.length);

  const segmentWords = Math.round((SEGMENT_SECONDS / 60) * wpm);
  const segments: PlannedSegment[] = Array.from({ length: VIDEO_SEGMENT_COUNT }, (_, i) => {
    const number = i + 1;
    const part: VideoPart =
      number <= PART_1_SEGMENTS ? 1 : number <= PART_1_SEGMENTS + PART_2_SEGMENTS ? 2 : 3;
    const start = i * SEGMENT_SECONDS;

    let beat: StoryBeat;
    let allocation: Assignment;
    let introducesUnit = false;
    let segmentOutcomes: string[] = [];

    if (part === 1) {
      beat = orientationBeat(i);
      allocation = wholeModule;
      const outcomeIndex = outcomeSegments.indexOf(number);
      if (outcomeIndex >= 0) segmentOutcomes = outcomeSplit[outcomeIndex] ?? [];
    } else if (part === 2) {
      const slotIndex = number - PART_1_SEGMENTS - 1;
      const slot = slots[slotIndex]!;
      allocation = teachingAllocations[slotIndex]!;
      introducesUnit = slot.positionInUnit === 0;
      beat = unitBeat({
        unitTitle: allocation.unit_title,
        unitCodes: slot.units.map((u) => u.unit.unit_code),
        positionInUnit: slot.positionInUnit,
        segmentsForUnit: slot.segmentsForUnit,
      });
      segmentOutcomes = slot.units.flatMap(
        (u) =>
          outcomes.unit_outcomes
            .find((x) => x.unit_code === u.unit.unit_code)
            ?.outcomes.map((o) => o.text) ?? [],
      );
    } else {
      beat = conclusionBeat(number - PART_1_SEGMENTS - PART_2_SEGMENTS - 1);
      allocation = wholeModule;
    }

    return {
      segment_number: number,
      segment_id: `seg-${String(number).padStart(2, '0')}`,
      role: number === 1 ? 'open' : number === VIDEO_SEGMENT_COUNT ? 'close' : 'body',
      part,
      part_name: VIDEO_PART_SPEC[part].name,
      story: beat,
      introduces_unit: introducesUnit,
      learning_outcomes: segmentOutcomes,
      purpose: segmentPurpose(beat, part, segmentOutcomes),
      start_seconds: start,
      end_seconds: start + SEGMENT_SECONDS,
      seconds: SEGMENT_SECONDS,
      start_timecode: timecode(start),
      end_timecode: timecode(start + SEGMENT_SECONDS),
      target_words: segmentWords,
      min_words: Math.floor(segmentWords * (1 - SEGMENT_WORD_TOLERANCE)),
      max_words: Math.ceil(segmentWords * (1 + SEGMENT_WORD_TOLERANCE)),
      allocation: stripFullText(allocation),
    };
  });

  // --- The deck: as many slides as the module needs, none over half a minute. ---
  const slideCount = slideCountFor(reading, wpm);
  const bodySlides = slideCount - 3; // title, outcomes, takeaways
  const slideAssignments = assign(reading.units, bodySlides);
  const baseSeconds = Math.floor(SLIDE_DECK_SECONDS / slideCount);
  const remainder = SLIDE_DECK_SECONDS - baseSeconds * slideCount;

  let previousUnit = '';
  const slides: PlannedSlide[] = Array.from({ length: slideCount }, (_, i) => {
    const number = i + 1;
    const role: 'title' | 'body' | 'summary' =
      number === 1 || number === 2 ? 'title' : number === slideCount ? 'summary' : 'body';
    const allocation = role === 'body' ? slideAssignments[number - 3]! : wholeModule;
    const seconds = baseSeconds + (i < remainder ? 1 : 0);
    const notesWords = Math.round((seconds / 60) * wpm);
    const introduces = role === 'body' && allocation.unit_code !== previousUnit;
    if (role === 'body') previousUnit = allocation.unit_code;

    const slideOutcomes =
      number === 2
        ? moduleOutcomes
        : role === 'body' && introduces
          ? outcomes.unit_outcomes
              .find((u) => u.unit_code === allocation.unit_code)
              ?.outcomes.map((o) => o.text) ?? []
          : [];

    return {
      slide_number: number,
      slide_id: `sl-${String(number).padStart(2, '0')}`,
      role,
      introduces_unit: introduces,
      learning_outcomes: slideOutcomes,
      purpose: slidePurpose(role, number, introduces, allocation.unit_title),
      seconds,
      target_notes_words: notesWords,
      min_notes_words: Math.floor(notesWords * (1 - NOTES_WORD_TOLERANCE)),
      max_notes_words: Math.ceil(notesWords * (1 + NOTES_WORD_TOLERANCE)),
      min_bullets: 3,
      max_bullets: role === 'body' ? 5 : 6,
      allocation: stripFullText(allocation),
    };
  });

  const units: ModuleUnitSummary[] = reading.units.map((unit) => ({
    unit_code: unit.unit.unit_code,
    unit_title: unit.unit.title,
    word_count: unit.word_count,
    chunk_ids: unit.chunk_ids,
    pdf_page_start: unit.unit.pdf_page_start,
    pdf_page_end: unit.unit.pdf_page_end,
    video_segments: segments
      .filter((s) => s.part === 2 && s.allocation.unit_code.includes(unit.unit.unit_code))
      .map((s) => s.segment_number),
    slides: slides
      .filter((s) => s.role === 'body' && s.allocation.unit_code.includes(unit.unit.unit_code))
      .map((s) => s.slide_number),
  }));

  const contentMap: ModuleContentMap = {
    module_outcomes: moduleOutcomes,
    units: units.map((u) => ({
      unit_code: u.unit_code,
      unit_title: u.unit_title,
      outcomes:
        outcomes.unit_outcomes.find((x) => x.unit_code === u.unit_code)?.outcomes.map((o) => o.text) ??
        [],
      word_count: u.word_count,
      video_segments: u.video_segments,
      slides: u.slides,
    })),
    ...(outcomes.note ? { note: outcomes.note } : {}),
  };

  return {
    course_id: reading.course_id,
    ...(reading.subject_id ? { subject_id: reading.subject_id } : {}),
    ...(reading.subject_code ? { subject_code: reading.subject_code } : {}),
    module_number: reading.module_number,
    module_title: reading.module_title,
    words_per_minute: wpm,
    video: {
      total_seconds: VIDEO_SECONDS,
      segment_count: VIDEO_SEGMENT_COUNT,
      segment_seconds: SEGMENT_SECONDS,
      parts: ([1, 2, 3] as VideoPart[]).map((part) => ({
        part,
        name: VIDEO_PART_SPEC[part].name,
        seconds: VIDEO_PART_SPEC[part].seconds,
        segments: segments.filter((s) => s.part === part).map((s) => s.segment_number),
        purpose: VIDEO_PART_SPEC[part].purpose,
      })),
      segments,
    },
    slides: {
      total_seconds: SLIDE_DECK_SECONDS,
      slide_count: slideCount,
      max_slide_seconds: MAX_SLIDE_SECONDS,
      slides,
    },
    units,
    content_map: contentMap,
    ...coverageNote(reading),
  };
}

/** Splits a list into `parts` contiguous groups, keeping order. */
function splitList<T>(items: readonly T[], parts: number): T[][] {
  const out: T[][] = Array.from({ length: parts }, () => []);
  items.forEach((item, index) => {
    out[Math.min(Math.floor((index / Math.max(1, items.length)) * parts), parts - 1)]!.push(item);
  });
  return out;
}

/**
 * How many slides this module needs.
 *
 * Nine minutes is fixed and no slide may hold more than thirty seconds of talking,
 * which sets the floor at eighteen. Above that the count follows the module: a long
 * module gets more slides rather than denser ones, because the thing that makes a
 * deck unreadable is a slide with too much on it.
 */
function slideCountFor(reading: PhModuleReading, wpm: number): number {
  const perSlideWords = Math.round((MAX_SLIDE_SECONDS / 60) * wpm);
  const byContent = Math.ceil(reading.word_count / Math.max(1, perSlideWords * 6));
  // Never fewer than one body slide per unit, plus the three framing slides.
  const byUnits = reading.units.length + 3;
  return Math.min(MAX_SLIDE_COUNT, Math.max(MIN_SLIDE_COUNT, byContent, byUnits));
}

function slidePurpose(
  role: 'title' | 'body' | 'summary',
  number: number,
  introducesUnit: boolean,
  unitTitle: string,
): string {
  if (role === 'title' && number === 1) {
    return (
      'Open the deck: the module title and what this session is about. Frame it; do not teach yet. ' +
      'The right-hand visual sets the subject rather than decorating it.'
    );
  }
  if (role === 'title') {
    return (
      "What the learner will be able to do by the end, from the handbook's stated outcomes for " +
      'this module. Keep to what the handbook says.'
    );
  }
  if (role === 'summary') {
    return (
      'Close the deck: consolidate what was covered across every unit and give the practical next ' +
      'step. No new fact.'
    );
  }
  const opening = introducesUnit
    ? `This slide opens the unit "${unitTitle}": name it, say what it covers and why it matters, ` +
      'then teach the first idea. '
    : '';
  return (
    `${opening}One teaching purpose only -- this slide answers one question. Bullets are short cues ` +
    'on screen; the teaching lives in the speaker notes; the right-hand visual explains the idea ' +
    'rather than decorating it.'
  );
}

/** The plan is sent to the client; the full source is fetched separately by tool. */
function stripFullText(assignment: Assignment): UnitAllocation {
  const { full_text: _ignored, ...rest } = assignment;
  return rest;
}

/**
 * Rebuilds the per-item source text for a plan.
 *
 * Kept out of the plan payload because a module runs to eight or ten thousand words
 * and repeating it across thirty items would make the plan unreadable and enormous.
 * The plan says which unit and portion each item covers; this returns the text.
 */
export function moduleSourceForPlan(
  reading: PhModuleReading,
  plan: ModulePlan,
): { segments: Record<number, string>; slides: Record<number, string> } {
  // Rebuilt the same way the plan built it, so item N here is the text item N was
  // planned against rather than a fresh division that happens to look similar.
  const slots = teachingSlots(reading.units, PART_2_SEGMENTS);
  const slideAssignments = assign(reading.units, plan.slides.slide_count - 3);

  const wholeModule = reading.units
    .map((u) => `[Unit ${u.unit.unit_code} - ${u.unit.title}]\n${u.text}`)
    .join('\n\n');

  const segments: Record<number, string> = {};
  for (const segment of plan.video.segments) {
    if (segment.part !== 2) {
      segments[segment.segment_number] = wholeModule;
      continue;
    }
    const slot = slots[segment.segment_number - PART_1_SEGMENTS - 1]!;
    segments[segment.segment_number] =
      slot.units.length === 1
        ? splitUnit(slot.units[0]!, slot.portionCount)[slot.portionIndex]!.text
        : slot.units.map((u) => `[Unit ${u.unit.unit_code} - ${u.unit.title}]\n${u.text}`).join('\n\n');
  }

  const slides: Record<number, string> = {};
  for (const slide of plan.slides.slides) {
    slides[slide.slide_number] =
      slide.role === 'body' ? slideAssignments[slide.slide_number - 3]!.full_text : wholeModule;
  }
  return { segments, slides };
}

/**
 * Warns when the module and the fixed 12 minutes are badly matched.
 *
 * The package length is not negotiable, so this cannot adjust anything -- but a
 * module of twelve thousand words compressed into 12 minutes is a real editorial
 * decision, and the client should know it is making one.
 */
function coverageNote(reading: PhModuleReading): { coverage_note?: string } {
  const spokenWords = Math.round(((VIDEO_SECONDS + SLIDE_DECK_SECONDS) / 60) * DEFAULT_WORDS_PER_MINUTE);
  const ratio = spokenWords / Math.max(1, reading.word_count);
  if (ratio < 0.25) {
    return {
      coverage_note:
        `This module holds about ${reading.word_count} words across ${reading.units.length} units, ` +
        `but 12 minutes of delivery is about ${spokenWords} spoken words. Every segment and slide ` +
        'must therefore teach the essence of its allocated portion rather than all of it. Choose ' +
        'the load-bearing ideas; do not skim everything equally, and do not drop a unit.',
    };
  }
  if (ratio > 1.5) {
    return {
      coverage_note:
        `This module is short for a 12-minute package (about ${reading.word_count} words against ` +
        `roughly ${spokenWords} spoken words of delivery). Use the room for worked examples, ` +
        'demonstrations and recap of facts the units already state -- not for new material.',
    };
  }
  return {};
}
