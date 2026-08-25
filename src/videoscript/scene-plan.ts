/**
 * Planning the fifteen to eighteen scenes.
 *
 * Everything below the module is arithmetic, not a choice to put to the user, and
 * here the arithmetic has only one answer. Four rules are fixed -- the video runs
 * 150-180 seconds, no scene exceeds ten seconds, every scene carries 22-25 words,
 * and no sentence crosses a scene boundary -- and a scene shorter than ten seconds
 * cannot hold twenty-two words. So every scene is exactly ten seconds, and the
 * video is fifteen to eighteen of them.
 *
 * That length is what makes this a complete module introduction. Six scenes are
 * the frame (greet, say what the topic is in two, turn to the learning, draw the
 * threads together, hand over) and the nine to twelve that remain go to the units
 * -- two or three scenes each, rather than several units sharing one. A unit with
 * three scenes has its text split into three contiguous slices, so the second
 * scene continues where the first stopped instead of re-introducing the unit.
 *
 * What this planner does NOT do is decide what is taught. It hands each roadmap
 * scene the handbook text for its slice and stops there.
 */

import { getPhOutline, readPhUnit, UnitNotFoundError } from '../documents/ph-outline.js';
import type { PhUnitBlock, PhUnitReading } from '../documents/ph-outline.js';
import { TRACK_LABELS } from '../catalog/subject-catalog.js';
import type { SubjectEntry } from '../catalog/subject-catalog.js';
import {
  MAX_SCENE_COUNT,
  MAX_SENTENCES_PER_SCENE,
  MAX_TOTAL_SECONDS,
  MIN_SCENE_COUNT,
  MIN_TOTAL_SECONDS,
  SCENE_END_PAUSE,
  SCENE_SECONDS,
  SENTENCE_PAUSE,
  SPEAKING_PACE,
  VIDEO_TYPE_INFO,
  WORDS_PER_SCENE_MAX,
  WORDS_PER_SCENE_MIN,
  WORDS_PER_SCENE_TARGET,
  type PlannedScene,
  type SceneRole,
  type UnitCoverage,
  type VideoProfile,
  type VideoScriptPlan,
} from '../types/video-script.js';
import { characterLock, environmentLock } from './profile.js';
import { videoSubjectLabel, videoTypeLabel } from './catalog.js';

export class VideoScriptPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoScriptPlanError';
  }
}

/**
 * The frame around the teaching, and the room left inside it.
 *
 * Six framing scenes and nine to twelve roadmap scenes: 15 scenes is 150 seconds,
 * 18 is 180, and both ends of that are exactly the 2.5-3 minutes required. How
 * many roadmap scenes a module gets follows from how many units it has -- two
 * apiece, floored at nine so a one-unit module still fills the running time and
 * capped at twelve so an eight-unit module still fits inside three minutes.
 */
const FRAME_SCENES = 6;
const MIN_ROADMAP_SCENES = MIN_SCENE_COUNT - FRAME_SCENES;
const MAX_ROADMAP_SCENES = MAX_SCENE_COUNT - FRAME_SCENES;
const SCENES_PER_UNIT = 2;

const EXCERPT_CHARS = 320;

/**
 * How much of each slice travels with the plan.
 *
 * A roadmap scene is twenty-odd words. It does not need the whole unit; it needs
 * the part of the unit it was allocated. Slicing first and bounding second is what
 * keeps the plan small enough to arrive in one call while still giving each scene
 * material the previous scene did not already use.
 */
const SCENE_SOURCE_CHARS = 1600;

/** Characters of module text below which the roadmap scenes will struggle. */
const THIN_MODULE_CHARS = 2000;

function timecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function countWords(text: string): number {
  const matched = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu);
  return matched ? matched.length : 0;
}

// ---------------------------------------------------------------------------
// What each role has to do
// ---------------------------------------------------------------------------

/**
 * The rule every scene obeys, restated in every direction.
 *
 * It is repeated rather than stated once at the top of the plan because a writer
 * works scene by scene, and the constraint that is most often broken -- a sentence
 * left hanging for the next scene to finish -- is broken exactly at the moment the
 * writer is looking at one scene's direction and nothing else.
 */
const SELF_CONTAINED =
  ' This scene must stand on its own: every sentence starts and finishes inside it. Do not ' +
  'leave a clause, a list or a thought for the next scene to complete, and do not open by ' +
  'completing the previous one.';

const ROLE_DIRECTION: Record<Exclude<SceneRole, 'roadmap'>, string> = {
  opening:
    'Open with a natural spoken "Namastey", then name the module and say in one further ' +
    'sentence what it is about. The presenter is speaking within the first second -- no silent ' +
    'establishing beat. The module title appears on screen as it is spoken. Teach nothing yet.',
  topic_introduction:
    'Say what this topic is and why it matters to someone doing this work. Concrete and ' +
    'practical -- what it changes for them -- not a claim about the industry. Do not begin ' +
    'teaching the first unit here.',
  learning_transition:
    'Turn from what the topic is to what the learner will be able to do. One bridge: this scene ' +
    'changes direction rather than adding information.',
  consolidation:
    'Draw the learning areas together: how they connect and why they are taught in this order. ' +
    'No new fact -- everything here has already been named.',
  closing:
    'Hand over to the detailed module content, in the sense of "let us now go through this step ' +
    'by step". No new fact, no summary of everything, and not "thank you for watching".',
};

/**
 * The direction for one roadmap scene.
 *
 * A unit gets two or three consecutive scenes, so the direction has to say which
 * of them this is. Without that, the second scene of a unit re-introduces it and
 * twenty-five words are spent saying the name again.
 */
function roadmapDirection(unit: UnitCoverage, indexInUnit: number, ofUnit: number): string {
  const first = indexInUnit === 0;
  const last = indexInUnit === ofUnit - 1;

  if (ofUnit === 1) {
    return (
      `Introduce the learning area "${unit.unit_title}": name it, say what it covers, and give ` +
      'one concrete thing from it that makes it real -- a factor, a step, a piece of equipment, ' +
      'a figure the handbook states.' +
      SELF_CONTAINED
    );
  }
  if (first) {
    return (
      `Open the learning area "${unit.unit_title}". Name it and say what it covers, and land one ` +
      'concrete thing from the text allocated here -- an opening that only announces the area ' +
      `wastes one of the ${ofUnit} scenes it has.` +
      SELF_CONTAINED
    );
  }
  if (last) {
    return (
      `Close the learning area "${unit.unit_title}" on what the learner should take from it, ` +
      'built from the text allocated here. Do not repeat the area\'s name -- it was named ' +
      'already; continue from where the previous scene stopped.' +
      SELF_CONTAINED
    );
  }
  return (
    `Continue the learning area "${unit.unit_title}" with the text allocated here -- the next ` +
    'thing a learner needs to know about it. Do not re-introduce the area; carry on from the ' +
    'previous scene.' +
    SELF_CONTAINED
  );
}

const ROLE_PURPOSE: Record<SceneRole, string> = {
  opening: 'Greet the learner and name the module',
  topic_introduction: 'Establish what the topic is and why it matters',
  learning_transition: 'Turn towards what the learner will be able to do',
  roadmap: 'Introduce part of a key learning area of the module',
  consolidation: 'Show how the learning areas fit together',
  closing: 'Hand over to the detailed module content',
};

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Divides `total` scenes among the units, every unit getting at least one.
 *
 * Largest remainder, so the parts sum to exactly the total however the weights
 * fall -- with nine scenes to place across four units, "roughly proportional"
 * would quietly produce eight or ten.
 */
function allocate(weights: readonly number[], total: number): number[] {
  const count = weights.length;
  if (count === 0) return [];
  if (total < count) {
    // More units than scenes. Every unit still gets one, which lengthens the
    // video past its cap -- refused here rather than silently truncating the
    // module, since a module introduction that drops units is not one.
    throw new VideoScriptPlanError(
      `This module has ${count} units and only ${total} scenes are available for them. A ` +
        `${MIN_TOTAL_SECONDS}-${MAX_TOTAL_SECONDS} second video cannot introduce them all.`,
    );
  }

  const sum = weights.reduce((a, w) => a + w, 0);
  const remaining = total - count;
  const exact = weights.map((w) => (sum === 0 ? remaining / count : (w / sum) * remaining));
  const floors = exact.map(Math.floor);
  let left = remaining - floors.reduce((a, f) => a + f, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const extra = new Array<number>(count).fill(0);
  for (const { index } of order) {
    if (left <= 0) break;
    extra[index] = 1;
    left -= 1;
  }

  return floors.map((f, i) => 1 + f + extra[i]!);
}

interface Slice {
  text: string;
  chunkIds: string[];
  pages: number[];
  words: number;
}

/**
 * Cuts one unit into `parts` contiguous slices.
 *
 * By its own blocks rather than by character offset, so a slice always begins at a
 * paragraph boundary and never mid-sentence -- which matters here more than
 * usual, because a scene whose source starts mid-clause is a scene whose narration
 * starts mid-clause.
 */
function sliceUnit(unit: PhUnitReading, parts: number): Slice[] {
  const groups: PhUnitBlock[][] = Array.from({ length: parts }, () => []);
  const total = unit.blocks.reduce((a, b) => a + b.char_count, 0);

  let cumulative = 0;
  for (const block of unit.blocks) {
    const midpoint = cumulative + block.char_count / 2;
    const slot = total === 0 ? 0 : Math.floor((midpoint / total) * parts);
    groups[Math.min(slot, parts - 1)]!.push(block);
    cumulative += block.char_count;
  }

  // Rounding can leave a slice empty. It borrows the nearest block from a
  // neighbour that has more than one, rather than leaving a scene with nothing
  // to write from.
  for (let i = 0; i < groups.length; i++) {
    if (groups[i]!.length > 0) continue;
    const donor = groups.findIndex((g) => g.length > 1);
    if (donor === -1) {
      groups[i] = unit.blocks.slice(0, 1);
      continue;
    }
    const taken = donor < i ? groups[donor]!.pop()! : groups[donor]!.shift()!;
    groups[i]!.push(taken);
  }

  return groups.map((blocks) => {
    const text = blocks.map((b) => b.text).join('\n');
    return {
      text: bounded(text, SCENE_SOURCE_CHARS),
      chunkIds: [...new Set(blocks.map((b) => b.chunk_id))],
      pages: [...new Set(blocks.map((b) => b.pdf_page))].sort((a, b) => a - b),
      words: countWords(text),
    };
  });
}

function toCoverage(unit: PhUnitReading, slice: Slice, index: number, of: number): UnitCoverage {
  return {
    unit_code: unit.unit.unit_code,
    unit_title: unit.unit.title,
    portion: `${index + 1} of ${of}`,
    chunk_ids: slice.chunkIds,
    pdf_pages: slice.pages,
    source_excerpt:
      slice.text.length > EXCERPT_CHARS
        ? `${slice.text.slice(0, EXCERPT_CHARS).trimEnd()}...`
        : slice.text,
    source_word_count: slice.words,
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface BuildPlanOptions {
  subject: SubjectEntry;
  moduleNumber: number;
  profile: VideoProfile;
}

/**
 * Builds the plan for one module.
 *
 * Reads the module out of the handbook through the same path as an exact reading,
 * so the words a scene is written from and the words a reviewer can ask to see are
 * the same words. Then lays out the scenes and hands each roadmap scene its slice.
 */
export function buildVideoScriptPlan(options: BuildPlanOptions): VideoScriptPlan {
  const { subject, moduleNumber, profile } = options;
  const outline = getPhOutline(subject.course_id);
  const module = outline.modules.find((m) => m.module_number === moduleNumber);

  if (!module) {
    throw new UnitNotFoundError(
      `The ${subject.code} Participant Handbook has no module ${moduleNumber}. It has modules ` +
        `${outline.modules.map((m) => m.module_number).join(', ')}.`,
      [],
    );
  }
  if (!module.has_units) {
    throw new VideoScriptPlanError(
      `Module ${moduleNumber} (${module.title}) has no units in the handbook, so there is no ` +
        `content to build a video from. ${module.note ?? ''}`.trim(),
    );
  }

  const units = module.units.map((u) => readPhUnit(subject.course_id, u.unit_code));
  const moduleChars = units.reduce((a, u) => a + u.char_count, 0);

  // Two scenes per unit, held inside the nine-to-twelve the running time allows.
  const roadmapScenes = Math.min(
    MAX_ROADMAP_SCENES,
    Math.max(MIN_ROADMAP_SCENES, units.length * SCENES_PER_UNIT),
  );
  const perUnit = allocate(
    units.map((u) => u.char_count),
    roadmapScenes,
  );

  // One entry per roadmap scene, in handbook order: which unit, which slice of it.
  const roadmap: UnitCoverage[] = [];
  const roadmapSource: string[] = [];
  const roadmapPosition: { indexInUnit: number; ofUnit: number }[] = [];
  units.forEach((unit, u) => {
    const parts = perUnit[u]!;
    const slices = sliceUnit(unit, parts);
    slices.forEach((slice, i) => {
      roadmap.push(toCoverage(unit, slice, i, parts));
      roadmapSource.push(`[${unit.unit.unit_code} ${unit.unit.title} - part ${i + 1} of ${parts}]\n${slice.text}`);
      roadmapPosition.push({ indexInUnit: i, ofUnit: parts });
    });
  });

  const order: SceneRole[] = [
    'opening',
    'topic_introduction',
    'topic_introduction',
    'learning_transition',
    ...Array.from({ length: roadmapScenes }, () => 'roadmap' as const),
    'consolidation',
    'closing',
  ];

  const overview = moduleOpening(units);
  const scenes: PlannedScene[] = [];
  let cursor = 0;
  let roadmapIndex = 0;

  for (const [i, role] of order.entries()) {
    const isRoadmap = role === 'roadmap';
    const coverage = isRoadmap ? roadmap[roadmapIndex]! : undefined;
    const position = isRoadmap ? roadmapPosition[roadmapIndex]! : undefined;

    scenes.push({
      scene_number: i + 1,
      scene_id: `S${String(i + 1).padStart(2, '0')}`,
      role,
      educational_purpose: ROLE_PURPOSE[role],
      role_direction:
        coverage && position
          ? roadmapDirection(coverage, position.indexInUnit, position.ofUnit)
          : ROLE_DIRECTION[role as Exclude<SceneRole, 'roadmap'>] + SELF_CONTAINED,
      seconds: SCENE_SECONDS,
      start_seconds: cursor,
      end_seconds: cursor + SCENE_SECONDS,
      start_timecode: timecode(cursor),
      end_timecode: timecode(cursor + SCENE_SECONDS),
      target_words: WORDS_PER_SCENE_TARGET,
      min_words: WORDS_PER_SCENE_MIN,
      max_words: WORDS_PER_SCENE_MAX,
      units: coverage ? [coverage] : [],
      // The framing scenes speak about the module as a whole, so they are given
      // its opening text rather than nothing: "what this is and why it matters"
      // still has to be grounded in the handbook.
      source_text: isRoadmap ? roadmapSource[roadmapIndex]! : overview,
      citable_chunk_ids: coverage ? coverage.chunk_ids : units[0]?.chunk_ids ?? [],
    });

    if (isRoadmap) roadmapIndex += 1;
    cursor += SCENE_SECONDS;
  }

  const totalSeconds = cursor;
  if (
    scenes.length < MIN_SCENE_COUNT ||
    scenes.length > MAX_SCENE_COUNT ||
    totalSeconds < MIN_TOTAL_SECONDS ||
    totalSeconds > MAX_TOTAL_SECONDS
  ) {
    // Unreachable with the constants above; asserted so a future edit to the
    // frame or the caps cannot quietly produce a video outside the brief.
    throw new VideoScriptPlanError(
      `The scene table produced ${scenes.length} scenes of ${totalSeconds}s, outside the required ` +
        `${MIN_SCENE_COUNT}-${MAX_SCENE_COUNT} scenes and ${MIN_TOTAL_SECONDS}-${MAX_TOTAL_SECONDS}s.`,
    );
  }

  const moduleUnits = units.map((u) => ({
    unit_code: u.unit.unit_code,
    unit_title: u.unit.title,
    scenes: scenes
      .filter((s) => s.units.some((c) => c.unit_code === u.unit.unit_code))
      .map((s) => s.scene_number),
  }));

  return {
    course_id: subject.course_id,
    subject_id: subject.subject_id,
    subject_label: videoSubjectLabel(subject.subject_id, subject.name),
    track: subject.track,
    track_label: TRACK_LABELS[subject.track],
    module_number: module.module_number,
    module_title: module.title,
    video_type: VIDEO_TYPE_INFO,
    video_type_label: videoTypeLabel(VIDEO_TYPE_INFO),
    scene_count: scenes.length,
    scene_seconds: SCENE_SECONDS,
    total_seconds: totalSeconds,
    total_target_words: scenes.reduce((a, s) => a + s.target_words, 0),
    words_per_scene: {
      target: WORDS_PER_SCENE_TARGET,
      min: WORDS_PER_SCENE_MIN,
      max: WORDS_PER_SCENE_MAX,
    },
    speaking_pace: SPEAKING_PACE,
    breathing: {
      between_sentences: SENTENCE_PAUSE,
      end_of_scene: SCENE_END_PAUSE,
      max_sentences: MAX_SENTENCES_PER_SCENE,
    },
    profile,
    character: characterLock(profile),
    environment: environmentLock(profile.environment),
    module_units: moduleUnits,
    scenes,
    ...(moduleChars < THIN_MODULE_CHARS
      ? {
          coverage_note:
            `This module holds only ${moduleChars} characters of handbook text across ` +
            `${units.length} unit${units.length === 1 ? '' : 's'}, spread over ${roadmapScenes} ` +
            'teaching scenes. There may not be enough material for every scene to say something ' +
            'new; write what the handbook supports and no more, and repeat nothing.',
        }
      : {}),
  };
}

/**
 * The module's opening text, for the scenes that speak about it as a whole.
 *
 * The first unit's beginning is where a handbook says what the chapter is about,
 * so it is what grounds "what this topic is and why it matters".
 */
function moduleOpening(units: PhUnitReading[]): string {
  const first = units[0];
  if (!first) return '';
  return bounded(first.text, 2400);
}

/** Cuts at a sentence end where one is near, so the text does not stop mid-clause. */
function bounded(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
  const cut = stop > limit * 0.6 ? stop + 1 : limit;
  return `${text.slice(0, cut).trimEnd()}\n[...unit continues; read_ph_unit returns all of it]`;
}
