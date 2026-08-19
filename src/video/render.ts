/**
 * Plain-text rendering.
 *
 * The video flows deliberately produce no file. What a user wants at the end of
 * this flow is a script they can select, copy and paste into a teleprompter, an
 * editing timeline or a message -- so the deliverable is text in the tool result,
 * formatted to be read by a person rather than parsed by a machine. The structured
 * state is still available from get_video_transcript for anything that needs it.
 */

import type { PhUnitReading } from '../documents/ph-outline.js';
import type { VideoTranscriptState } from '../types/video.js';
import { timecode } from './scene-plan.js';
import { countWords } from './validator.js';

const RULE = '='.repeat(72);
const THIN = '-'.repeat(72);

function pageRange(from: number, to: number, printedFrom?: number, printedTo?: number): string {
  const pdf = from === to ? `p. ${from}` : `pp. ${from}-${to}`;
  if (printedFrom === undefined) return pdf;
  const printed = printedFrom === printedTo ? `p. ${printedFrom}` : `pp. ${printedFrom}-${printedTo}`;
  return `${pdf} (printed ${printed})`;
}

export type ScriptFormat = 'script' | 'production';

/**
 * Renders the finished script.
 *
 * Two formats, because two different people read this. The default, "script", is
 * what a user copies into a teleprompter or hands to an editor: title, timings,
 * visuals, narration, and nothing else. It carries no page numbers, no citations
 * and no word-count annotations, because none of that is part of a video script --
 * a reader who sees "Participant Handbook p. 229" under a scene has to delete it
 * before the script is usable.
 *
 * "production" adds the sourcing and the budget figures back, for a reviewer
 * checking where a claim came from. The citations are always kept in the stored
 * state either way, so nothing is lost by leaving them out of the copy.
 *
 * Timecodes come from the plan rather than from the narration, so the script a user
 * copies carries the timings the video was budgeted to.
 */
export function renderVideoScript(state: VideoTranscriptState, format: ScriptFormat = 'script'): string {
  const plan = state.plan;
  const production = format === 'production';
  const words = state.scenes.reduce((a, s) => a + countWords(s.narration), 0);
  const estimated = Math.round((words / plan.words_per_minute) * 60);

  const lines: string[] = [RULE, state.title.toUpperCase(), RULE];
  lines.push(
    `Runtime  : ${timecode(plan.requested_seconds)}  (${state.scenes.length} scenes)`,
  );
  if (production) {
    lines.push(
      `Unit     : Module ${state.module_number} - Unit ${state.unit_code} - ${state.unit_title}`,
      `Source   : Participant Handbook, ${pageRange(
        plan.source.pdf_page_start,
        plan.source.pdf_page_end,
        plan.source.printed_page_start,
        plan.source.printed_page_end,
      )}`,
      `Read time: ~${timecode(estimated)} (${words} words @ ${plan.words_per_minute} wpm)`,
    );
  }
  lines.push(RULE, '');

  for (const planned of plan.scenes) {
    const scene = state.scenes.find((s) => s.scene_number === planned.scene_number);
    lines.push(
      `SCENE ${planned.scene_number}  |  ${planned.start_timecode} - ${planned.end_timecode}  (${planned.seconds}s)`,
      THIN,
    );

    if (!scene) {
      lines.push(`[NOT WRITTEN -- ${planned.target_words} words needed for this slot]`, '');
      continue;
    }

    lines.push(`TITLE     : ${scene.title}`);
    lines.push(`VISUAL    : ${scene.visual}`);
    if (scene.on_screen_text && scene.on_screen_text.trim().length > 0) {
      lines.push(`ON-SCREEN : ${scene.on_screen_text}`);
    }
    lines.push('NARRATION :');
    for (const paragraph of scene.narration.split('\n')) {
      lines.push(`  ${paragraph}`);
    }

    if (production) {
      const pages = [...new Set(scene.sources.map((s) => s.printed_page ?? s.pdf_page))].sort(
        (a, b) => a - b,
      );
      if (pages.length > 0) {
        lines.push(
          `[source: Participant Handbook ${pages.length === 1 ? 'p.' : 'pp.'} ${pages.join(', ')}]`,
        );
      }
      lines.push(`[${countWords(scene.narration)} words, budget ${planned.min_words}-${planned.max_words}]`);
    }
    lines.push('');
  }

  lines.push(RULE, `END  |  ${timecode(plan.requested_seconds)}`, RULE);
  return lines.join('\n');
}

/**
 * Renders an exact reading of a handbook unit.
 *
 * The header is kept deliberately minimal and clearly separated from the text by a
 * rule, because the one thing this output must not do is blur the line between what
 * the handbook says and what this server added around it.
 */
export function renderUnitReading(reading: PhUnitReading): string {
  return [
    RULE,
    `PARTICIPANT HANDBOOK - EXACT TEXT`,
    `${reading.subject_code ?? reading.course_id}  |  Module ${reading.unit.module_number}  |  ${reading.unit.heading}`,
    `${pageRange(
      reading.unit.pdf_page_start,
      reading.unit.pdf_page_end,
      reading.unit.printed_page_start,
      reading.unit.printed_page_end,
    )}  |  ${reading.word_count} words`,
    RULE,
    '',
    reading.text,
    '',
    RULE,
    `END OF UNIT ${reading.unit.unit_code}`,
    reading.fidelity_note,
    RULE,
  ].join('\n');
}
