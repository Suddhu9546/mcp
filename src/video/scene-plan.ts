/**
 * Deterministic scene planning.
 *
 * A requested duration is a hard constraint that a model cannot satisfy by
 * judgement -- "about two minutes" reliably comes out at three. So the arithmetic
 * is done here instead: the duration is divided into scenes, each scene is given a
 * word budget at a stated speaking rate, and the handbook text is divided among the
 * scenes in document order. What the client receives is a set of slots with their
 * sizes and their source material already attached; all it has to do is write.
 *
 * Nothing in this file selects, ranks or rewrites handbook content. The allocation
 * is by position and length only, so the transcript follows the unit's own order
 * and no part of the unit is silently dropped.
 */

import type { PhUnitReading } from '../documents/ph-outline.js';
import type { PlannedScene, ScenePlan, SceneRole } from '../types/video.js';

/**
 * Narration pace. 140 words per minute is a normal instructional-video read --
 * fast enough not to drag, slow enough for a second-language audience. Exposed as
 * an argument because a client may know its narrator reads faster.
 */
export const DEFAULT_WORDS_PER_MINUTE = 140;

/** Below this a "scene" is too short to say anything; above it, attention drifts. */
const TARGET_SECONDS_PER_SCENE = 30;
const MIN_SCENES = 3;
const MAX_SCENES = 12;

/** Word budgets are a target, not a gate; scenes are checked against this band. */
const WORD_TOLERANCE = 0.2;

export function timecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class ScenePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenePlanError';
  }
}

/**
 * Splits the total duration into scene lengths.
 *
 * The opening and closing scenes are capped rather than proportional: a hook that
 * grows with the video's length stops being a hook. Everything left over is split
 * evenly among the body scenes, with the remainder handed to the earliest ones so
 * the seconds always add up to exactly what was asked for.
 */
function allocateSeconds(totalSeconds: number, sceneCount: number): number[] {
  const bodyCount = sceneCount - 2;

  const hook = Math.max(8, Math.min(20, Math.round(totalSeconds * 0.12)));
  const recap = Math.max(8, Math.min(25, Math.round(totalSeconds * 0.13)));

  // A very short video cannot afford full-size bookends; shrink them rather than
  // dropping the body, which is where the handbook content lives.
  let bookends = hook + recap;
  let hookSeconds = hook;
  let recapSeconds = recap;
  const minBody = bodyCount * 6;
  if (bookends + minBody > totalSeconds) {
    const available = Math.max(2, totalSeconds - minBody);
    hookSeconds = Math.max(1, Math.round((available * hook) / bookends));
    recapSeconds = Math.max(1, available - hookSeconds);
    bookends = hookSeconds + recapSeconds;
  }

  const bodyTotal = totalSeconds - bookends;
  const base = Math.floor(bodyTotal / bodyCount);
  const remainder = bodyTotal - base * bodyCount;

  const body = Array.from({ length: bodyCount }, (_, i) => base + (i < remainder ? 1 : 0));
  return [hookSeconds, ...body, recapSeconds];
}

/**
 * Divides the unit's text blocks among the body scenes.
 *
 * Blocks are contiguous and in document order, so each scene covers a continuous
 * stretch of the handbook and the scenes together cover all of it. Allocation is by
 * cumulative character count, which keeps a scene's word budget roughly
 * proportional to the amount of source it has to convey. When there are fewer
 * blocks than body scenes the later scenes share the last block rather than being
 * left with nothing to cite.
 */
function allocateBlocks(reading: PhUnitReading, bodyCount: number): number[][] {
  const blocks = reading.blocks;
  if (blocks.length === 0) return Array.from({ length: bodyCount }, () => []);

  const total = blocks.reduce((a, b) => a + b.char_count, 0);
  const groups: number[][] = Array.from({ length: bodyCount }, () => []);

  let cumulative = 0;
  for (const [index, block] of blocks.entries()) {
    // Midpoint placement, so a block that straddles a boundary lands in the scene
    // that holds most of it rather than always in the earlier one.
    const midpoint = cumulative + block.char_count / 2;
    const slot = total === 0 ? 0 : Math.floor((midpoint / total) * bodyCount);
    groups[Math.min(slot, bodyCount - 1)]!.push(index);
    cumulative += block.char_count;
  }

  // Any scene left empty by rounding borrows its neighbour's last block, so every
  // scene has something to cite. Citations may overlap; coverage may not have gaps.
  for (let i = 0; i < groups.length; i++) {
    if (groups[i]!.length > 0) continue;
    const donor = i > 0 ? groups[i - 1]! : groups.find((g) => g.length > 0);
    if (donor && donor.length > 0) groups[i]!.push(donor[donor.length - 1]!);
  }
  return groups;
}

const PURPOSE: Record<SceneRole, string> = {
  hook: 'Open the video: name the unit, say why it matters to the learner, and set up what follows. Ground the claim in the unit\'s opening text -- do not invent a statistic or a story.',
  body: 'Teach the handbook text allocated to this scene, in the handbook\'s own order. Presentation, examples and phrasing may be shaped for video; the facts may not go beyond this text.',
  recap: 'Close the video: restate the key points already covered and give the learner a concrete next action. Introduce no new fact here.',
};

export interface BuildScenePlanOptions {
  reading: PhUnitReading;
  /** Requested video length. */
  seconds: number;
  wordsPerMinute?: number;
  /** Overrides the derived scene count. */
  sceneCount?: number;
}

export function buildScenePlan(options: BuildScenePlanOptions): ScenePlan {
  const { reading } = options;
  const seconds = Math.round(options.seconds);
  const wpm = options.wordsPerMinute ?? DEFAULT_WORDS_PER_MINUTE;

  if (!Number.isFinite(seconds) || seconds < 30) {
    throw new ScenePlanError(
      `A video duration of ${seconds}s is too short to plan. Ask the user for at least 30 seconds.`,
    );
  }
  if (seconds > 3600) {
    throw new ScenePlanError(
      `A video duration of ${seconds}s (over an hour) is beyond this flow, which produces a ` +
        'single-unit explainer. Split the request across units.',
    );
  }
  if (!Number.isFinite(wpm) || wpm < 60 || wpm > 220) {
    throw new ScenePlanError(`words_per_minute must be between 60 and 220, got ${wpm}.`);
  }

  const sceneCount =
    options.sceneCount ??
    Math.min(MAX_SCENES, Math.max(MIN_SCENES, Math.round(seconds / TARGET_SECONDS_PER_SCENE)));
  if (sceneCount < MIN_SCENES || sceneCount > MAX_SCENES) {
    throw new ScenePlanError(`scene_count must be between ${MIN_SCENES} and ${MAX_SCENES}, got ${sceneCount}.`);
  }

  const secondsPerScene = allocateSeconds(seconds, sceneCount);
  const bodyGroups = allocateBlocks(reading, sceneCount - 2);

  const scenes: PlannedScene[] = [];
  let cursor = 0;
  for (let i = 0; i < sceneCount; i++) {
    const role: SceneRole = i === 0 ? 'hook' : i === sceneCount - 1 ? 'recap' : 'body';
    const sceneSeconds = secondsPerScene[i]!;
    const targetWords = Math.max(5, Math.round((sceneSeconds / 60) * wpm));

    // The bookends carry no allocation of their own: the hook is grounded in the
    // unit's opening and the recap in its closing, which is also what they are
    // rhetorically about.
    const blockIndexes =
      role === 'body'
        ? bodyGroups[i - 1]!
        : reading.blocks.length === 0
          ? []
          : role === 'hook'
            ? [0]
            : [reading.blocks.length - 1];
    const blocks = blockIndexes.map((index) => reading.blocks[index]!);

    scenes.push({
      scene_number: i + 1,
      scene_id: `sc-${String(i + 1).padStart(2, '0')}`,
      role,
      purpose: PURPOSE[role],
      start_seconds: cursor,
      end_seconds: cursor + sceneSeconds,
      seconds: sceneSeconds,
      start_timecode: timecode(cursor),
      end_timecode: timecode(cursor + sceneSeconds),
      target_words: targetWords,
      min_words: Math.max(3, Math.floor(targetWords * (1 - WORD_TOLERANCE))),
      max_words: Math.ceil(targetWords * (1 + WORD_TOLERANCE)),
      source_chunk_ids: blocks.map((b) => b.chunk_id),
      source_pages: [...new Set(blocks.map((b) => b.pdf_page))],
      source_text: blocks.map((b) => b.text).join('\n'),
    });
    cursor += sceneSeconds;
  }

  const totalTargetWords = Math.round((seconds / 60) * wpm);

  return {
    course_id: reading.course_id,
    ...(reading.subject_id ? { subject_id: reading.subject_id } : {}),
    ...(reading.subject_code ? { subject_code: reading.subject_code } : {}),
    unit_code: reading.unit.unit_code,
    unit_title: reading.unit.title,
    unit_heading: reading.unit.heading,
    module_number: reading.unit.module_number,
    requested_seconds: seconds,
    requested_duration: timecode(seconds),
    words_per_minute: wpm,
    total_target_words: totalTargetWords,
    scene_count: sceneCount,
    source: {
      document_type: 'PH',
      pdf_page_start: reading.unit.pdf_page_start,
      pdf_page_end: reading.unit.pdf_page_end,
      ...(reading.unit.printed_page_start !== undefined
        ? {
            printed_page_start: reading.unit.printed_page_start,
            printed_page_end: reading.unit.printed_page_end!,
          }
        : {}),
      word_count: reading.word_count,
      char_count: reading.char_count,
      chunk_ids: reading.chunk_ids,
    },
    scenes,
    ...coverageNote(reading.word_count, totalTargetWords),
  };
}

/**
 * Warns when the unit and the requested duration are badly matched.
 *
 * Both directions are failure modes worth naming before generation rather than
 * after: too little source and the script gets padded with invented material, too
 * much and the script races through the unit at a pace nobody can follow.
 */
function coverageNote(unitWords: number, targetWords: number): { coverage_note?: string } {
  if (unitWords === 0) {
    return {
      coverage_note:
        'The indexed text for this unit is empty. Re-ingest the handbook before generating.',
    };
  }
  const ratio = targetWords / unitWords;
  if (ratio > 1.5) {
    return {
      coverage_note:
        `The requested duration needs about ${targetWords} spoken words, but this unit holds ` +
        `only about ${unitWords}. Fill the extra time with pacing, on-screen illustration, ` +
        'worked examples of facts already in the unit and a fuller recap -- not with facts the ' +
        'unit does not state. Suggest a shorter video to the user if that feels forced.',
    };
  }
  if (ratio < 0.35) {
    return {
      coverage_note:
        `This unit holds about ${unitWords} words but the requested duration allows only about ` +
        `${targetWords} spoken words. Each scene must summarise its allocated text rather than ` +
        'cover all of it; tell the user which aspects were prioritised, or suggest a longer video.',
    };
  }
  return {};
}
