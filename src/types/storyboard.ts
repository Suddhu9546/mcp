/**
 * Storyboard State -- the logical source of truth (PRINCIPLE 4).
 *
 * Every field below was derived by inspecting the real template
 * (templates/storyboard-template-v1.docx), not assumed. The template is a
 * fully-populated Solar PV storyboard whose repeating per-module structure is:
 *
 *   Heading1  Module N: <title>
 *   P         Total Duration: <n> Hours
 *   P         <description>
 *   Heading2  Part A: eLMS with Online Faculty Instruction (<n> hours)
 *   Table     4 cols: Topic / Unit | Time | Interactive Learning Descriptions |
 *                     Correlation (PC/Units from QP, PH, FG)
 *   Heading2  LMS Technical Mapping for Module N
 *   Table     5 cols: Unit | Activity Type | Recommended Standard |
 *                     Key Tracking Data & Verbs | Completion Criteria
 *   Heading2  Part B: Video Production Script (15 minutes)
 *   Table     3 cols: Time | Visual / On-Screen Text (GFX) | Audio (Dialogue & SFX)
 *   Heading2  Part C: Online Instructor-Led Interactive Session (15 minutes)
 *   P...      Slide N: <title> / Visual Cues: ... / Instructor Script: ...
 *
 * The DOCX is a rendering of this state, never the other way round.
 */

import type { AllocatedDuration, TimingStrategy } from './timing.js';
import type { InsufficientSource, SourceRef } from './source.js';

/** Anything that may be absent because the sources could not support it. */
export type Sourced<T> = T | InsufficientSource;

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

/** A row of the "Official SCGJ Metadata" table (2 cols: field | specification). */
export interface MetadataRow {
  field: string;
  specification: string;
  sources: SourceRef[];
}

/**
 * A bullet under "Instructional Design and Behavioral Analytics Tracking
 * Guidelines". The template groups these under two Heading2 sections.
 */
export interface GuidelineBullet {
  bullet_id: string;
  /** e.g. "xAPI Event Stream Configuration" or "SCORM State Variable Persistence". */
  group: string;
  text: string;
  sources: SourceRef[];
}

export interface FrontMatter {
  /** Cover title, e.g. "Bio-Energy Micro Entrepreneur". */
  title: string;
  /** Cover subtitle, e.g. "Complete Curriculum Storyboard and Assessment Blueprint". */
  subtitle: string;
  /** Cover strap line carrying NSQF level and QP code. */
  strapline: string;
  /** Body heading, e.g. "Bio-Energy Micro Entrepreneur: Storyboard & Curriculum Blueprint". */
  blueprint_heading: string;
  metadata: MetadataRow[];
  guideline_groups: string[];
  guidelines: GuidelineBullet[];
}

// ---------------------------------------------------------------------------
// Part A -- eLMS with Online Faculty Instruction
// ---------------------------------------------------------------------------

export interface PartARow {
  row_id: string;
  /** Unit code from the timing document, e.g. "1.1". */
  unit_code: string;
  /** Rendered first cell, e.g. "Unit 1.1: Fundamentals of Biofuels & Biomass Energy". */
  unit_label: string;
  unit_title: string;
  duration: AllocatedDuration;
  /**
   * The named interactive activity and its description. In the reference these
   * always read "<Activity Name>: <what the learner does>".
   */
  activity_name: string;
  interactive_description: string;
  /** "Correlation (PC/Units from QP, PH, FG)" cell, e.g. "SGJ/N4102 / PC1, PC3". */
  correlation: string;
  /** NOS code the unit assesses against, parsed out of `correlation`. */
  nos_code: string;
  performance_criteria: string[];
  sources: SourceRef[];
}

export interface PartA {
  /** Header hours as rendered, governed by the artifact's TimingStrategy. */
  header_hours: number;
  header_label: string;
  rows: PartARow[];
}

// ---------------------------------------------------------------------------
// LMS Technical Mapping
// ---------------------------------------------------------------------------

export type TrackingStandard = 'xAPI' | 'SCORM 2004' | 'SCORM 1.2';

export interface LmsMappingRow {
  row_id: string;
  /** Unit or unit range this row covers, e.g. "1.1-1.2". */
  unit_range: string;
  /** Must match a PartARow.activity_name in the same module. */
  activity_type: string;
  recommended_standard: TrackingStandard;
  /** "Key Tracking Data & Verbs" cell. */
  tracking: string;
  completion_criteria: string;
  sources: SourceRef[];
}

export interface LmsMapping {
  rows: LmsMappingRow[];
}

// ---------------------------------------------------------------------------
// Part B -- Video Production Script
// ---------------------------------------------------------------------------

/**
 * A 3-minute segment. The reference always uses exactly five segments spanning
 * 0:00-15:00, so the row count is a template constant, not a generated value.
 */
export interface PartBRow {
  row_id: string;
  /** e.g. "0:00-3:00". */
  time_range: string;
  start_seconds: number;
  end_seconds: number;
  /** "Visual:" portion of the second cell. */
  visual: string;
  /** "GFX:" portion of the second cell. Absent in some reference rows. */
  gfx?: string;
  /** Third cell: speaker-attributed dialogue, e.g. 'Host (On-Camera): "..."'. */
  audio: string;
  sources: SourceRef[];
}

export interface PartB {
  duration_minutes: number;
  rows: PartBRow[];
}

// ---------------------------------------------------------------------------
// Part C -- Online Instructor-Led Interactive Session
// ---------------------------------------------------------------------------

/** The reference uses exactly 7 slides per module, rendered as paragraphs. */
export interface Slide {
  slide_id: string;
  number: number;
  /** e.g. "Interactive Poll - \"Choosing the Module Technology\" (3 Minutes)". */
  title: string;
  visual_cues: string;
  instructor_script: string;
  sources: SourceRef[];
}

export interface PartC {
  duration_minutes: number;
  /** e.g. "Slide Deck & Presenter Script: Module 1 Live Session". */
  deck_title: string;
  subtitle: string;
  slides: Slide[];
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export interface StoryboardModule {
  module_id: string;
  /** Module number as used by the Timing Allocation Document. */
  number: number;
  title: string;
  /** Authoritative module duration, from the timing document. */
  duration: AllocatedDuration;
  /** Rendered as "Total Duration: 3 Hours". */
  duration_label: string;
  description: Sourced<string>;
  /**
   * Citations supporting `description`. Held on the module rather than inline
   * because `description` is a bare string in the template's structure.
   */
  description_sources: SourceRef[];
  /**
   * Chapter number this module maps to in the Participant Handbook and Faculty
   * Guide. These disagree with the timing document's numbering: timing M5
   * (Pellets) is PH/FG chapter 7, M6 (Biogas) is chapter 8, M7 (HSE) is
   * chapter 5. Retrieval must scope on this, not on `number`.
   */
  source_chapter: number;
  nos_code: string;
  elective?: number;
  part_a: Sourced<PartA>;
  lms_mapping: Sourced<LmsMapping>;
  part_b: Sourced<PartB>;
  part_c: Sourced<PartC>;
}

// ---------------------------------------------------------------------------
// Assessment blueprint
// ---------------------------------------------------------------------------

export interface WeightageRow {
  nos_code: string;
  nos_title: string;
  theory_marks: number;
  practical_marks: number;
  project_marks: number;
  viva_marks: number;
  total_marks: number;
  weightage: number;
  /** True for the "Total" summary row. */
  is_total?: boolean;
  sources: SourceRef[];
}

export type QuestionOption = 'a' | 'b' | 'c' | 'd';

/**
 * A question-bank entry.
 *
 * Per the approved policy (matching the Solar reference's own disclosure), the
 * stem, the correct answer and the explanation must each be supported by an
 * approved source. The three incorrect options are authored, because a source
 * document contains no answer key -- they must be plausible but must not assert
 * any fact absent from the sources.
 */
export interface Question {
  question_id: string;
  /** 1-based position in the bank. */
  number: number;
  /** Module number this question is filed under (timing-document numbering). */
  module_number: number;
  stem: string;
  options: Record<QuestionOption, string>;
  correct_option: QuestionOption;
  explanation: string;
  /** Supports stem, correct option and explanation. Never the distractors. */
  sources: SourceRef[];
  /** Always true under the current policy. Recorded so the audit can prove it. */
  distractors_authored: boolean;
  /** Set when the question is reproduced verbatim from a source exercise. */
  verbatim_from_source?: SourceRef;
}

export interface AssessmentBlueprint {
  strategy_points: GuidelineBullet[];
  minimum_aggregate_pass_pct: number;
  weightage_compulsory: WeightageRow[];
  weightage_electives: Record<string, WeightageRow[]>;
  remarks: string;
  /** Reproduced verbatim into the DOCX, as the Solar reference does. */
  disclosure_note: string;
  questions: Question[];
}

// ---------------------------------------------------------------------------
// Artifact-level state
// ---------------------------------------------------------------------------

export interface StoryboardState {
  /** e.g. "SB-2026-00001". */
  artifact_id: string;
  course_id: string;
  version: number;
  template_version: string;
  timing_strategy: TimingStrategy;
  front_matter: FrontMatter;
  modules: StoryboardModule[];
  assessment: Sourced<AssessmentBlueprint>;
}

// ---------------------------------------------------------------------------
// Addressing, for the patch engine
// ---------------------------------------------------------------------------

/**
 * A stable address for any editable leaf in the state. The patch engine resolves
 * these; nothing else may reach into the state by index.
 *
 * Examples:
 *   { kind: 'part_a_cell', module: 1, row_id: 'm01-a-1.1', field: 'interactive_description' }
 *   { kind: 'slide', module: 3, slide_id: 'm03-c-s4', field: 'instructor_script' }
 *   { kind: 'question', question_id: 'q-017', field: 'explanation' }
 */
export type StoryboardTarget =
  | { kind: 'module_description'; module: number }
  | { kind: 'part_a_cell'; module: number; row_id: string; field: keyof PartARow }
  | { kind: 'lms_cell'; module: number; row_id: string; field: keyof LmsMappingRow }
  | { kind: 'part_b_cell'; module: number; row_id: string; field: keyof PartBRow }
  | { kind: 'slide'; module: number; slide_id: string; field: keyof Slide }
  | { kind: 'question'; question_id: string; field: keyof Question }
  | { kind: 'metadata_row'; field_name: string }
  | { kind: 'module'; module: number };

export type EditOperation =
  | 'update_field'
  | 'update_fields'
  | 'rewrite_scene'
  | 'add_scene'
  | 'delete_scene'
  | 'regenerate_field'
  | 'simplify'
  | 'correct_from_source'
  | 'modify_timing'
  | 'rollback';
