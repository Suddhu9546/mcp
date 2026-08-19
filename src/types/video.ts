/**
 * Video transcript types.
 *
 * The same division of responsibility as the storyboard applies: this server plans
 * the shape of the transcript and supplies the handbook text it must be built from,
 * the client writes the words. Consequently a scene has two halves -- the planned
 * half (timing, word budget, which handbook text it covers) which is computed here
 * and is read-only, and the authored half (title, visual, narration) which only the
 * client can fill.
 */

import type { SourceRef } from './source.js';

export type SceneRole = 'hook' | 'body' | 'recap';

export interface PlannedScene {
  scene_number: number;
  scene_id: string;
  role: SceneRole;
  /** What this scene has to accomplish, in one sentence. */
  purpose: string;
  start_seconds: number;
  end_seconds: number;
  seconds: number;
  start_timecode: string;
  end_timecode: string;
  /** Words that fit this scene's seconds at the plan's speaking rate. */
  target_words: number;
  min_words: number;
  max_words: number;
  /** Chunks this scene must be built from and must cite. */
  source_chunk_ids: string[];
  source_pages: number[];
  /** The exact Participant Handbook text allocated to this scene. */
  source_text: string;
}

export interface ScenePlanSource {
  document_type: 'PH';
  pdf_page_start: number;
  pdf_page_end: number;
  printed_page_start?: number;
  printed_page_end?: number;
  word_count: number;
  char_count: number;
  chunk_ids: string[];
}

export interface ScenePlan {
  course_id: string;
  subject_id?: string;
  subject_code?: string;
  unit_code: string;
  unit_title: string;
  unit_heading: string;
  module_number: number;
  requested_seconds: number;
  requested_duration: string;
  words_per_minute: number;
  total_target_words: number;
  scene_count: number;
  source: ScenePlanSource;
  scenes: PlannedScene[];
  /** Advisory when the unit's length and the requested duration are mismatched. */
  coverage_note?: string;
}

export interface TranscriptScene {
  scene_number: number;
  scene_id: string;
  role: SceneRole;
  /** Short scene title, e.g. "Why feedstock choice decides your margin". */
  title: string;
  /** Camera, animation and on-screen action direction. */
  visual: string;
  /** Text or graphics burned onto the screen. Optional. */
  on_screen_text?: string;
  /** The spoken words. This is the educational content and must be cited. */
  narration: string;
  /** Derived from narration on write; never supplied by the client. */
  word_count: number;
  sources: SourceRef[];
}

export interface VideoTranscriptState {
  transcript_id: string;
  version: number;
  course_id: string;
  subject_id?: string;
  subject_code?: string;
  unit_code: string;
  unit_title: string;
  module_number: number;
  /** Video title. Defaults to the unit title until the client sets one. */
  title: string;
  requested_seconds: number;
  words_per_minute: number;
  plan: ScenePlan;
  scenes: TranscriptScene[];
  created_at: string;
  updated_at: string;
}
