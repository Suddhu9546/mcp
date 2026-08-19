/**
 * Video transcript validation -- mechanical, like the storyboard's.
 *
 * Three questions can be answered without a model, so those are the three asked:
 *
 *   Structure   is there exactly one scene per planned scene, in order, with
 *               narration in it?
 *   Duration    does the script's word count read back in about the time the user
 *               asked for, at the plan's stated speaking rate?
 *   Grounding   does every scene cite chunks that resolve, that come from the
 *               Participant Handbook, and that belong to *this unit* -- and does
 *               its wording measurably overlap them?
 *
 * Whether the narration is a fair rendering of the source is a reasoning question
 * and stays with the client. Findings are reported and never repaired here.
 */

import type { Finding } from '../storyboard/validator.js';
import { groundingOverlap } from '../storyboard/validator.js';
import { getChunk } from '../documents/retriever.js';
import type { VideoTranscriptState } from '../types/video.js';
import { timecode } from './scene-plan.js';
import { config } from '../util/config.js';

export interface VideoValidationReport {
  transcript_id: string;
  course_id: string;
  unit_code: string;
  version: number;
  passed: boolean;
  duration: {
    requested_seconds: number;
    requested_timecode: string;
    estimated_seconds: number;
    estimated_timecode: string;
    variance_pct: number;
    words: number;
    target_words: number;
    words_per_minute: number;
  };
  summary: { errors: number; warnings: number; infos: number };
  findings: Finding[];
}

/** Counts words the way a narrator would read them. */
export function countWords(text: string): number {
  const matched = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu);
  return matched ? matched.length : 0;
}

/** How far off the requested duration is acceptable before it is worth reporting. */
const DURATION_TOLERANCE_PCT = 10;

/**
 * References to the source that must not appear in the script itself.
 *
 * The citations belong in the stored state, where validation and audit use them.
 * They do not belong in what the narrator says or in what is burned onto the
 * screen: "Watch: NREL Energy Basics -- Biomass (QR in handbook, p.11)" is an
 * instruction to a reader of the handbook, not a line of a video, and a user
 * copying the script has to strip it out by hand. Caught mechanically because the
 * patterns are unambiguous and a reminder in the prompt is not enforcement.
 */
const SOURCE_REFERENCE_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /\b(participant\s+handbook|facilitator\s+guide|faculty\s+guide|qualification\s+pack)\b/i, what: 'a source document by name' },
  { pattern: /\b(handbook|workbook)\b/i, what: 'the handbook' },
  { pattern: /\bpp?\.\s?\d+/i, what: 'a page number' },
  { pattern: /\bpages?\s+\d+/i, what: 'a page number' },
  { pattern: /\b(figure|fig\.|table|annexure)\s*\d+/i, what: 'a figure or table number' },
  { pattern: /\bQR\b/, what: 'a QR code reference' },
  { pattern: /\b(SGJ|DGT)\/[NQ]?\w*\d+/i, what: 'a qualification code' },
  { pattern: /\b(unit|module|chapter)\s+\d+(\.\d+)?\b/i, what: 'a unit, module or chapter number' },
];

export function findSourceReference(text: string): { what: string; match: string } | undefined {
  for (const { pattern, what } of SOURCE_REFERENCE_PATTERNS) {
    const found = pattern.exec(text);
    if (found) return { what, match: found[0] };
  }
  return undefined;
}

export function validateVideoTranscript(state: VideoTranscriptState): VideoValidationReport {
  const findings: Finding[] = [];
  const plan = state.plan;

  // --- Structure --------------------------------------------------------
  const byNumber = new Map(state.scenes.map((s) => [s.scene_number, s]));
  for (const planned of plan.scenes) {
    if (!byNumber.has(planned.scene_number)) {
      findings.push({
        severity: 'error',
        code: 'missing_scene',
        path: `scenes[${planned.scene_number}]`,
        message:
          `Scene ${planned.scene_number} (${planned.role}, ${planned.start_timecode}-${planned.end_timecode}) ` +
          'has not been written. Every planned scene must be present or the video will not fill its duration.',
      });
    }
  }
  for (const scene of state.scenes) {
    if (!plan.scenes.some((p) => p.scene_number === scene.scene_number)) {
      findings.push({
        severity: 'error',
        code: 'unplanned_scene',
        path: `scenes[${scene.scene_number}]`,
        message:
          `Scene ${scene.scene_number} is not in the plan, which has ${plan.scene_count} scenes. ` +
          'Extra scenes push the video past the requested duration.',
      });
    }
  }

  // --- Per scene --------------------------------------------------------
  let totalWords = 0;
  for (const planned of plan.scenes) {
    const scene = byNumber.get(planned.scene_number);
    if (!scene) continue;
    const path = `scenes[${planned.scene_number}]`;
    const words = countWords(scene.narration);
    totalWords += words;

    if (scene.narration.trim().length === 0) {
      findings.push({
        severity: 'error',
        code: 'empty_narration',
        path: `${path}.narration`,
        message: `Scene ${planned.scene_number} has no narration.`,
      });
    } else if (words < planned.min_words || words > planned.max_words) {
      findings.push({
        severity: 'warning',
        code: 'scene_word_budget',
        path: `${path}.narration`,
        message:
          `Scene ${planned.scene_number} reads as about ${Math.round((words / plan.words_per_minute) * 60)}s ` +
          `against its ${planned.seconds}s slot. Adjust the narration length to keep the scene timings honest.`,
        expected: `${planned.min_words}-${planned.max_words} words`,
        actual: `${words} words`,
      });
    }

    if (scene.visual.trim().length === 0) {
      findings.push({
        severity: 'warning',
        code: 'missing_visual',
        path: `${path}.visual`,
        message: `Scene ${planned.scene_number} has no visual direction, so the scene cannot be shot or animated.`,
      });
    }
    if (scene.title.trim().length === 0) {
      findings.push({
        severity: 'warning',
        code: 'missing_scene_title',
        path: `${path}.title`,
        message: `Scene ${planned.scene_number} has no title.`,
      });
    }

    // The script is the deliverable a user copies as-is, so anything that reads as
    // a citation is a defect in it.
    for (const field of ['title', 'visual', 'on_screen_text', 'narration'] as const) {
      const value = scene[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      const leak = findSourceReference(value);
      if (!leak) continue;
      findings.push({
        severity: 'error',
        code: 'source_reference_in_script',
        path: `${path}.${field}`,
        message:
          `Scene ${planned.scene_number}'s ${field} names ${leak.what} ("${leak.match}"). A video ` +
          'script must not refer to the handbook, page numbers, figures, unit or module numbers, ' +
          'or QR codes -- the viewer has none of those. Say the content in the video\'s own ' +
          'terms; the citation stays in the sources array, where it belongs.',
        actual: leak.match,
      });
    }

    // --- Grounding ------------------------------------------------------
    if (scene.sources.length === 0) {
      findings.push({
        severity: 'error',
        code: 'missing_citation',
        path: `${path}.sources`,
        message:
          `Scene ${planned.scene_number} cites nothing. Every scene's narration must cite the ` +
          'Participant Handbook chunks it was built from.',
      });
      continue;
    }

    const citedTexts: string[] = [];
    for (const source of scene.sources) {
      const chunk = getChunk(state.course_id, source.chunk_id);
      if (!chunk) {
        findings.push({
          severity: 'error',
          code: 'unresolvable_citation',
          path: `${path}.sources`,
          message:
            `Citation "${source.chunk_id}" does not resolve in course "${state.course_id}". ` +
            'Cite chunk_ids from this unit\'s plan or from get_ph_unit_source.',
          actual: source.chunk_id,
        });
        continue;
      }
      if (chunk.document_type !== 'PH') {
        findings.push({
          severity: 'error',
          code: 'wrong_source_document',
          path: `${path}.sources`,
          message:
            `Citation "${source.chunk_id}" is from the ${chunk.document_type}, but a video ` +
            'transcript is grounded in the Participant Handbook only.',
          expected: 'PH',
          actual: chunk.document_type,
        });
        continue;
      }
      if (chunk.unit_code !== state.unit_code) {
        findings.push({
          severity: 'error',
          code: 'citation_outside_unit',
          path: `${path}.sources`,
          message:
            `Citation "${source.chunk_id}" belongs to unit ${chunk.unit_code ?? '(none)'}, not to ` +
            `unit ${state.unit_code}. Content from another unit does not belong in this video.`,
          expected: state.unit_code,
          actual: chunk.unit_code ?? '(none)',
        });
        continue;
      }
      citedTexts.push(chunk.content);
    }

    if (citedTexts.length > 0 && scene.narration.trim().length > 0) {
      const overlap = groundingOverlap(scene.narration, citedTexts.join('\n'));
      if (overlap < config.grounding.minOverlap) {
        findings.push({
          severity: 'warning',
          code: 'low_grounding_overlap',
          path: `${path}.narration`,
          message:
            `Only ${(overlap * 100).toFixed(0)}% of scene ${planned.scene_number}'s distinctive words ` +
            'appear in the handbook text it cites. A video script is expected to reword, so this is ' +
            'a lexical signal, not a verdict -- but check the scene is not asserting anything the ' +
            'unit does not say.',
          expected: `>= ${config.grounding.minOverlap.toFixed(2)}`,
          actual: overlap.toFixed(2),
        });
      }
    }
  }

  // --- Duration ---------------------------------------------------------
  const estimatedSeconds = Math.round((totalWords / plan.words_per_minute) * 60);
  const variance =
    plan.requested_seconds === 0
      ? 0
      : ((estimatedSeconds - plan.requested_seconds) / plan.requested_seconds) * 100;

  if (state.scenes.length > 0 && Math.abs(variance) > DURATION_TOLERANCE_PCT) {
    findings.push({
      severity: 'warning',
      code: 'duration_variance',
      path: 'scenes',
      message:
        `The script reads as about ${timecode(estimatedSeconds)} at ${plan.words_per_minute} words per ` +
        `minute, against the requested ${timecode(plan.requested_seconds)} ` +
        `(${variance > 0 ? '+' : ''}${variance.toFixed(0)}%). ` +
        (variance > 0
          ? 'Cut narration from the scenes flagged above.'
          : 'Add narration to the scenes flagged above.'),
      expected: `${plan.total_target_words} words`,
      actual: `${totalWords} words`,
    });
  }

  const summary = {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length,
  };

  return {
    transcript_id: state.transcript_id,
    course_id: state.course_id,
    unit_code: state.unit_code,
    version: state.version,
    passed: summary.errors === 0,
    duration: {
      requested_seconds: plan.requested_seconds,
      requested_timecode: timecode(plan.requested_seconds),
      estimated_seconds: estimatedSeconds,
      estimated_timecode: timecode(estimatedSeconds),
      variance_pct: Number(variance.toFixed(1)),
      words: totalWords,
      target_words: plan.total_target_words,
      words_per_minute: plan.words_per_minute,
    },
    summary,
    findings,
  };
}
