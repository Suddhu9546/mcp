/**
 * Planning the six or seven scenes.
 *
 * Everything below the module is arithmetic, not a choice to put to the user: how
 * many scenes there are, how long each runs, how many words fit it, and which of
 * the module's units it introduces. Doing it here is what makes the structure hold
 * -- a writer asked to produce "about ninety seconds" reliably writes three
 * minutes, and a writer asked to "cover the module" reliably covers the first half
 * of it.
 *
 * The structure is fixed because the job is fixed. An info video opens, says what
 * the topic is and why it matters, turns to what will be learned, walks the key
 * areas, and hands over. Only the roadmap section varies, and it varies with how
 * many units the module has: two roadmap scenes for a small module, three for a
 * larger one, which is what puts the total between sixty and ninety seconds
 * without anyone choosing a duration.
 *
 * What this planner does NOT do is decide what is taught. It hands each roadmap
 * scene the handbook text for the units it covers and stops there.
 */

import { getPhOutline, readPhUnit, UnitNotFoundError } from '../documents/ph-outline.js';
import type { PhUnitReading } from '../documents/ph-outline.js';
import { TRACK_LABELS } from '../catalog/subject-catalog.js';
import type { SubjectEntry } from '../catalog/subject-catalog.js';
import {
  MAX_SCENE_COUNT,
  MAX_TOTAL_SECONDS,
  MIN_SCENE_COUNT,
  MIN_TOTAL_SECONDS,
  SPEAKING_PACE,
  VIDEO_TYPE_INFO,
  WORDS_PER_SECOND_MAX,
  WORDS_PER_SECOND_MIN,
  WORDS_PER_SECOND_TARGET,
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
 * The seconds each role runs.
 *
 * The framing scenes are short because they carry one idea each; the topic
 * introduction and the roadmap scenes are longer because they carry the teaching.
 * Six scenes come to 62 seconds and seven to 74, both inside 60-90 with room for
 * the generator's lead-in.
 */
const ROLE_SECONDS: Record<SceneRole, number> = {
  opening: 8,
  topic_introduction: 12,
  learning_transition: 8,
  roadmap: 12,
  closing: 10,
};

const MIN_ROADMAP_SCENES = 2;
const MAX_ROADMAP_SCENES = 3;
const EXCERPT_CHARS = 320;

/**
 * How much of each allocated unit travels with the plan.
 *
 * The whole module would make the plan enormous and slow, and a roadmap scene does
 * not need the whole module: it needs to know what the unit is about and one
 * concrete thing from it, which a handbook states in its opening paragraphs. So
 * each unit contributes its opening, bounded, and the plan says so. A writer who
 * wants the rest can call read_ph_unit -- but the point of the bound is that a
 * ninety-second introduction should not need it.
 */
const SCENE_SOURCE_CHARS_PER_UNIT = 1800;

/** Characters of module text a roadmap scene can reasonably be written from. */
const THIN_MODULE_CHARS = 1200;

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
 * The direction for a role, written once.
 *
 * These are instructions to the writer, not narration. They say what the scene
 * must achieve and what it must not become, which is where an info video usually
 * goes wrong: scene 2 starts teaching the first unit, or the closing scene turns
 * into "thank you for watching".
 */
const ROLE_DIRECTION: Record<Exclude<SceneRole, 'roadmap'>, string> = {
  opening:
    'Open with a natural spoken "Namastey" and introduce the module by name. The presenter is ' +
    'speaking within the first second -- no silent establishing beat. The module title appears ' +
    'on screen as it is spoken. Teach nothing yet.',
  topic_introduction:
    'Say what this topic is and why it matters to someone doing this work. Concrete and ' +
    'practical, not a claim about the industry. Do not begin teaching the first unit here.',
  learning_transition:
    'Turn from what the topic is to what the learner will get from it. One short bridge -- this ' +
    'scene exists to change direction, not to add information.',
  closing:
    'Hand over to the detailed module content in one line, e.g. the sense of "let us go through ' +
    'this step by step". No new fact, no summary of everything, and not "thank you for watching".',
};

function roadmapDirection(units: UnitCoverage[], position: number, total: number): string {
  const names = units.map((u) => `"${u.unit_title}"`).join(' and ');
  const scope =
    units.length === 1
      ? `Introduce the learning area ${names}.`
      : `Introduce the learning areas ${names} as one connected area.`;
  return (
    `${scope} Name what it covers and give the learner one concrete thing that makes it real -- ` +
    'a factor, a step, a piece of equipment, a number the handbook states. This is the roadmap, ' +
    `not the lesson: do not attempt to teach the whole area in ${ROLE_SECONDS.roadmap} seconds. ` +
    (position === total - 1
      ? 'This is the last roadmap scene, so it should feel like the map is complete.'
      : 'Leave the learner ready for the next area.')
  );
}

const ROLE_PURPOSE: Record<SceneRole, string> = {
  opening: 'Greet the learner and name the module',
  topic_introduction: 'Establish what the topic is and why it matters',
  learning_transition: 'Turn towards what the learner will learn',
  roadmap: 'Introduce a key learning area of the module',
  closing: 'Hand over to the detailed module content',
};

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Splits the module's units across the roadmap scenes.
 *
 * Contiguous and in handbook order, so a scene never covers unit 1 and unit 4
 * while skipping the two between. Weighted by length with a floor of one unit per
 * scene, because a roadmap scene with nothing allocated has nothing to introduce.
 */
function allocateUnits(units: PhUnitReading[], scenes: number): PhUnitReading[][] {
  if (scenes >= units.length) {
    // More scenes than units: each scene takes one unit, and the extra scenes
    // double up on the longest ones rather than being left empty.
    const groups: PhUnitReading[][] = units.map((u) => [u]);
    while (groups.length < scenes) {
      const longest = groups.reduce(
        (best, g, i) =>
          g.reduce((a, u) => a + u.char_count, 0) >
          groups[best]!.reduce((a, u) => a + u.char_count, 0)
            ? i
            : best,
        0,
      );
      groups.splice(longest + 1, 0, [units[Math.min(longest, units.length - 1)]!]);
    }
    return groups.slice(0, scenes);
  }

  const total = units.reduce((a, u) => a + u.char_count, 0);
  const groups: PhUnitReading[][] = Array.from({ length: scenes }, () => []);
  let cumulative = 0;
  for (const unit of units) {
    const midpoint = cumulative + unit.char_count / 2;
    const slot = total === 0 ? 0 : Math.floor((midpoint / total) * scenes);
    groups[Math.min(slot, scenes - 1)]!.push(unit);
    cumulative += unit.char_count;
  }

  // Rounding can leave a group empty. It borrows from the fullest neighbour
  // rather than being dropped, since the scene exists either way.
  for (let i = 0; i < groups.length; i++) {
    if (groups[i]!.length > 0) continue;
    const donor = groups.findIndex((g) => g.length > 1);
    if (donor === -1) break;
    const taken = donor < i ? groups[donor]!.pop()! : groups[donor]!.shift()!;
    groups[i]!.push(taken);
  }
  return groups;
}

function toCoverage(unit: PhUnitReading): UnitCoverage {
  return {
    unit_code: unit.unit.unit_code,
    unit_title: unit.unit.title,
    chunk_ids: unit.chunk_ids,
    pdf_pages: [...new Set(unit.blocks.map((b) => b.pdf_page))].sort((a, b) => a - b),
    source_excerpt:
      unit.text.length > EXCERPT_CHARS ? `${unit.text.slice(0, EXCERPT_CHARS).trimEnd()}...` : unit.text,
    source_word_count: unit.word_count,
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
 * the same words. Then lays out the scenes and hands each roadmap scene its units.
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

  // Two roadmap scenes or three, decided by how much the module holds. A module
  // with one unit has one area to introduce and gets the shorter shape.
  const roadmapScenes = Math.min(
    MAX_ROADMAP_SCENES,
    Math.max(MIN_ROADMAP_SCENES, Math.min(units.length, MAX_ROADMAP_SCENES)),
  );
  const groups = allocateUnits(units, roadmapScenes);

  const order: SceneRole[] = [
    'opening',
    'topic_introduction',
    'learning_transition',
    ...(Array.from({ length: roadmapScenes }, () => 'roadmap' as const)),
    'closing',
  ];

  const scenes: PlannedScene[] = [];
  let cursor = 0;
  let roadmapIndex = 0;

  for (const [i, role] of order.entries()) {
    const seconds = ROLE_SECONDS[role];
    const covered = role === 'roadmap' ? groups[roadmapIndex] ?? [] : [];
    const coverage = covered.map(toCoverage);

    scenes.push({
      scene_number: i + 1,
      scene_id: `S${String(i + 1).padStart(2, '0')}`,
      role,
      educational_purpose: ROLE_PURPOSE[role],
      role_direction:
        role === 'roadmap'
          ? roadmapDirection(coverage, roadmapIndex, roadmapScenes)
          : ROLE_DIRECTION[role],
      seconds,
      start_seconds: cursor,
      end_seconds: cursor + seconds,
      start_timecode: timecode(cursor),
      end_timecode: timecode(cursor + seconds),
      target_words: Math.round(seconds * WORDS_PER_SECOND_TARGET),
      min_words: Math.floor(seconds * WORDS_PER_SECOND_MIN),
      max_words: Math.ceil(seconds * WORDS_PER_SECOND_MAX),
      units: coverage,
      // The framing scenes speak about the module as a whole, so they are given
      // the module's opening text rather than nothing: "what this is and why it
      // matters" still has to be grounded in the handbook.
      source_text:
        covered.length > 0
          ? covered
              .map(
                (u) =>
                  `[${u.unit.unit_code} ${u.unit.title}]\n` +
                  bounded(u.text, SCENE_SOURCE_CHARS_PER_UNIT),
              )
              .join('\n\n')
          : moduleOpening(units),
      citable_chunk_ids:
        covered.length > 0 ? covered.flatMap((u) => u.chunk_ids) : units[0]?.chunk_ids ?? [],
    });

    if (role === 'roadmap') roadmapIndex += 1;
    cursor += seconds;
  }

  const totalSeconds = cursor;
  if (
    scenes.length < MIN_SCENE_COUNT ||
    scenes.length > MAX_SCENE_COUNT ||
    totalSeconds < MIN_TOTAL_SECONDS ||
    totalSeconds > MAX_TOTAL_SECONDS
  ) {
    // Unreachable with the constants above; asserted so a future edit to the
    // seconds table cannot quietly produce a video outside the brief.
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
    total_seconds: totalSeconds,
    total_target_words: scenes.reduce((a, s) => a + s.target_words, 0),
    words_per_second: {
      target: WORDS_PER_SECOND_TARGET,
      min: WORDS_PER_SECOND_MIN,
      max: WORDS_PER_SECOND_MAX,
    },
    speaking_pace: SPEAKING_PACE,
    profile,
    character: characterLock(profile),
    environment: environmentLock(profile.environment),
    module_units: moduleUnits,
    scenes,
    ...(moduleChars < THIN_MODULE_CHARS
      ? {
          coverage_note:
            `This module holds only ${moduleChars} characters of handbook text across ` +
            `${units.length} unit${units.length === 1 ? '' : 's'}. There may not be enough ` +
            'material for every roadmap scene to say something distinct; write what the handbook ' +
            'supports and no more.',
        }
      : {}),
  };
}

/**
 * The module's opening text, for the scenes that speak about it as a whole.
 *
 * The first unit's beginning is where a handbook says what the chapter is about,
 * so it is what grounds "what this topic is and why it matters". Bounded, because
 * the framing scenes need orientation rather than the whole module.
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
