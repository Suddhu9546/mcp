/**
 * Module content package types.
 *
 * A package is the full 12 minutes of learning content for one Participant
 * Handbook module: a 3-minute video delivered as eighteen 10-second segments, and a
 * 9-minute deck of fourteen slides. The two halves are planned together because
 * they share one constraint -- between them they must cover every unit in the
 * module -- and planning them separately is how a unit ends up in neither.
 *
 * As everywhere else in this server, the planned half (counts, timings, word
 * budgets, which unit each item covers) is computed deterministically and is
 * read-only; the authored half (narration, visual direction, slide copy) can only
 * come from the client.
 */

import type { SourceRef } from './source.js';

/** The video generator accepts ten seconds at a time, so the script is built that way. */
export const SEGMENT_SECONDS = 10;
export const VIDEO_SEGMENT_COUNT = 18;
export const VIDEO_SECONDS = SEGMENT_SECONDS * VIDEO_SEGMENT_COUNT;

/**
 * The film is three parts, not one flat run of eighteen shots.
 *
 * A minute of module orientation, ninety seconds teaching the units, thirty
 * seconds of conclusion. The split matters because the first minute has a different
 * job from the rest: it tells the learner what the whole module is about and what
 * they will be able to do, which is exactly what gets lost when a script starts
 * teaching unit 1 in the first ten seconds.
 */
export const PART_1_SEGMENTS = 6;
export const PART_2_SEGMENTS = 9;
export const PART_3_SEGMENTS = 3;
export type VideoPart = 1 | 2 | 3;

export const VIDEO_PART_SPEC: Record<VideoPart, { name: string; seconds: number; segments: number; purpose: string }> = {
  1: {
    name: 'Module introduction',
    seconds: PART_1_SEGMENTS * SEGMENT_SECONDS,
    segments: PART_1_SEGMENTS,
    purpose:
      'Orient the learner to the whole module: what it covers, why it matters, and what they ' +
      'will be able to do by the end. This is orientation, not unit teaching.',
  },
  2: {
    name: 'Unit-by-unit teaching',
    seconds: PART_2_SEGMENTS * SEGMENT_SECONDS,
    segments: PART_2_SEGMENTS,
    purpose:
      'Teach every unit of the module in the order the handbook has them. No unit may be ' +
      'skipped, however ' +
      'many there are.',
  },
  3: {
    name: 'Module conclusion',
    seconds: PART_3_SEGMENTS * SEGMENT_SECONDS,
    segments: PART_3_SEGMENTS,
    purpose:
      'Consolidate the module: the main thing learned, how the units connect, and the practical ' +
      'takeaway. No new information.',
  },
};

/** Nine minutes of deck, and no slide may hold more than half a minute of talking. */
export const SLIDE_DECK_SECONDS = 540;
export const MAX_SLIDE_SECONDS = 30;
export const MIN_SLIDE_COUNT = Math.ceil(SLIDE_DECK_SECONDS / MAX_SLIDE_SECONDS);
export const MAX_SLIDE_COUNT = 30;

export type SegmentRole = 'open' | 'body' | 'close';
export type SlideRole = 'title' | 'body' | 'summary';

/** The three acts plus the payoff, mapped onto the eighteen segments. */
export type StoryAct = 'discovery' | 'exploration' | 'action' | 'payoff';

/**
 * A segment's place in the film.
 *
 * The video is one 3-minute story cut into eighteen shots, not eighteen prompts, so
 * each segment is assigned its beat before anything is written. Optimising segments
 * independently is what produces eighteen unrelated clips.
 */
export interface StoryBeat {
  act: StoryAct;
  /** Short name of the beat, e.g. "raise the stakes". */
  beat: string;
  /** What this segment must do for the story. */
  story_function: string;
  /** Where the viewer should be emotionally by the end of it. */
  emotional_tone: string;
}

export interface StoryProtagonist {
  name: string;
  gender: string;
  age_range: string;
  role: string;
  /** Face, build, hair -- restated to the generator in every segment. */
  appearance: string;
  clothing: string;
  footwear?: string;
  personality: string;
}

export interface StoryLocation {
  name: string;
  description: string;
}

export interface StoryVisualStyle {
  palette: string;
  lighting: string;
  time_of_day: string;
  weather: string;
  season?: string;
  camera_language: string;
}

export interface StoryNarrator {
  /** Fixed for the whole film; "Indian English" unless the client is told otherwise. */
  accent: string;
  gender: string;
  age_range: string;
  tone: string;
  pace: string;
}

/**
 * The film's constants, authored once and held to for all eighteen segments.
 *
 * Each 10-second clip is generated separately and the generator remembers nothing
 * between calls, so continuity has to be carried in writing: the same protagonist,
 * the same few locations, the same light, the same narrator. This is where those
 * facts live, and validation checks each segment against them.
 */
export interface StoryBible {
  /** The whole film in one sentence. */
  logline: string;
  protagonist: StoryProtagonist;
  /** A small set of connected places. Wandering between many locations breaks the film. */
  locations: StoryLocation[];
  visual_style: StoryVisualStyle;
  narrator: StoryNarrator;
  /** The image the film opens on. */
  opening_image: string;
  /** How the final segment pays that opening back. */
  closing_callback: string;
  acts: { discovery: string; exploration: string; action: string; payoff: string };
}

export interface UnitAllocation {
  unit_code: string;
  unit_title: string;
  /** Which part of that unit this item covers, e.g. "2 of 4". */
  portion: string;
  source_chunk_ids: string[];
  source_pages: number[];
  /** Opening of the allocated source, for orientation. Full text via get_module_source. */
  source_excerpt: string;
  source_word_count: number;
}

export interface PlannedSegment {
  segment_number: number;
  segment_id: string;
  role: SegmentRole;
  /** Which of the film's three parts this segment belongs to. */
  part: VideoPart;
  part_name: string;
  /** The story beat this segment carries. Fixed by the plan, not chosen per segment. */
  story: StoryBeat;
  /** True on the first segment of a unit: the narration must name that unit. */
  introduces_unit: boolean;
  /** The learning outcomes this segment carries, for Part 1 and Part 3. */
  learning_outcomes: string[];
  purpose: string;
  start_seconds: number;
  end_seconds: number;
  seconds: number;
  start_timecode: string;
  end_timecode: string;
  target_words: number;
  min_words: number;
  max_words: number;
  allocation: UnitAllocation;
}

/** The kinds of diagram a handbook concept actually calls for. */
export type SlideVisualType =
  | 'process'
  | 'lifecycle'
  | 'comparison'
  | 'components'
  | 'workflow'
  | 'relationship'
  | 'cause_effect'
  | 'measurement'
  | 'scene'
  | 'none';

/**
 * The brief for a slide's right-hand visual.
 *
 * A slide whose right side is decoration teaches nothing with half its area, so the
 * visual is specified as a teaching object: a type, what it shows, and the labels it
 * carries. Labelled diagram types are drawn natively into the .pptx; the rest are
 * rendered as a brief for a designer or an image generator.
 */
export interface SlideVisual {
  type: SlideVisualType;
  /** What the visual shows and what it teaches. */
  description: string;
  /** Steps, components or sides, in order. Drawn as the diagram. */
  labels: string[];
  /** Kept out of an AI-generated image, when one is produced. */
  avoid?: string;
}

export interface PlannedSlide {
  slide_number: number;
  slide_id: string;
  role: SlideRole;
  /** True on the first slide of a unit: the slide introduces it by name. */
  introduces_unit: boolean;
  learning_outcomes: string[];
  purpose: string;
  seconds: number;
  /** Speaker-notes budget: what the presenter says while this slide is up. */
  target_notes_words: number;
  min_notes_words: number;
  max_notes_words: number;
  min_bullets: number;
  max_bullets: number;
  allocation: UnitAllocation;
}

export interface ModuleUnitSummary {
  unit_code: string;
  unit_title: string;
  word_count: number;
  chunk_ids: string[];
  pdf_page_start: number;
  pdf_page_end: number;
  video_segments: number[];
  slides: number[];
}

export interface ModuleContentMap {
  module_outcomes: string[];
  units: {
    unit_code: string;
    unit_title: string;
    outcomes: string[];
    word_count: number;
    video_segments: number[];
    slides: number[];
  }[];
  note?: string;
}

export interface ModulePlan {
  course_id: string;
  subject_id?: string;
  subject_code?: string;
  module_number: number;
  module_title: string;
  words_per_minute: number;
  video: {
    total_seconds: number;
    segment_count: number;
    segment_seconds: number;
    parts: { part: VideoPart; name: string; seconds: number; segments: number[]; purpose: string }[];
    segments: PlannedSegment[];
  };
  slides: {
    total_seconds: number;
    slide_count: number;
    max_slide_seconds: number;
    slides: PlannedSlide[];
  };
  /** What the handbook says this module is for, and how it is divided up. */
  content_map: ModuleContentMap;
  units: ModuleUnitSummary[];
  /** Advisory when the module's length and the fixed 12 minutes sit badly together. */
  coverage_note?: string;
}

export interface VideoSegmentContent {
  segment_number: number;
  segment_id: string;
  role: SegmentRole;
  /** What this segment does for the story, in the writer's own words. */
  story_purpose: string;
  /**
   * The visual, action or state inherited from the previous segment's final moment.
   * This is the field that makes eighteen separate generations read as one film.
   */
  continues_from: string;
  /** What the voice-over says. Must read naturally in ten seconds. */
  narration: string;
  /** What is happening on screen in this segment. */
  scene_description: string;
  /** Camera, movement, framing, light, animation. */
  visual_direction: string;
  /** The protagonist restated for the generator: appearance, clothing, body language. */
  character_continuity: string;
  /** Which location this is, and its state, restated for the generator. */
  location_continuity: string;
  /** The object carried in from the last segment and out into the next. */
  object_continuity: string;
  /** Text burned onto the screen. Optional and short. */
  on_screen_text?: string;
  /** The exact visual or action the segment ends on. */
  ends_with: string;
  /** What the next segment must open on. Omitted on the final segment. */
  next_segment_starts_with?: string;
  /** How the hand-over is motivated from inside the scene. Omitted on the final segment. */
  transition?: string;
  /**
   * Whether this segment is real-world footage or a supporting graphic. The film is
   * predominantly real: graphics are capped so it does not become a slideshow.
   */
  visual_mode: 'real_world' | 'supporting_graphic';
  word_count: number;
  sources: SourceRef[];
}

export interface SlideContent {
  slide_number: number;
  slide_id: string;
  role: SlideRole;
  title: string;
  /** Short lines shown on the slide. Not sentences of narration. */
  bullets: string[];
  /** What the presenter says while this slide is up: the 40 seconds of content. */
  speaker_notes: string;
  /** The right-hand teaching visual. Required on body slides. */
  visual?: SlideVisual;
  /** One line the learner should leave the slide with. Optional. */
  key_takeaway?: string;
  notes_word_count: number;
  sources: SourceRef[];
}

export interface ModulePackageState {
  package_id: string;
  version: number;
  course_id: string;
  subject_id?: string;
  subject_code?: string;
  module_number: number;
  module_title: string;
  /** Deck and video title. Defaults to the module title. */
  title: string;
  words_per_minute: number;
  plan: ModulePlan;
  /** The film's constants. Written before the segments; validation checks against it. */
  story?: StoryBible;
  segments: VideoSegmentContent[];
  slides: SlideContent[];
  created_at: string;
  updated_at: string;
}
