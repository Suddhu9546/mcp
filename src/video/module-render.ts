/**
 * Plain-text rendering of a module package.
 *
 * Two deliverables, two audiences. The video script is copied segment by segment
 * into a generator that accepts ten seconds at a time, so each segment is rendered
 * as a self-contained block a person can select and paste without editing. The deck
 * is rendered as readable text as well as being written to .pptx, because a
 * reviewer usually wants to read fourteen slides rather than open them.
 *
 * Neither carries citations. The audience of a video or a slide has no handbook in
 * front of them, and a page reference in the copy is something the user has to
 * delete before use.
 */

import type { ModulePackageState } from '../types/module-content.js';
import type { PptxDeckInput } from '../pptx/pptx-writer.js';

const RULE = '='.repeat(72);
const THIN = '-'.repeat(72);

/**
 * Renders the film.
 *
 * The header carries the story bible, because whoever generates the clips needs the
 * protagonist, the locations and the narrator in front of them the whole time --
 * each generation is blind to the others, and a script that states its constants
 * once at the top is what keeps eighteen clips looking like one film.
 *
 * Each segment then repeats the continuity fields rather than referring back, since
 * a segment is copied on its own into the generator and anything left implicit is
 * simply absent from that call.
 */
export function renderModuleVideoScript(state: ModulePackageState): string {
  const plan = state.plan;
  const story = state.story;
  const lines: string[] = [
    RULE,
    `${state.title.toUpperCase()} - VIDEO SCRIPT`,
    RULE,
    `Runtime : 3:00  |  ${plan.video.segment_count} segments of ${plan.video.segment_seconds} seconds`,
    `Structure: ${plan.video.parts
      .map((p) => `Part ${p.part} ${p.name} (${p.seconds}s, segments ${p.segments[0]}-${p.segments[p.segments.length - 1]})`)
      .join('  |  ')}`,
    'Usage   : each segment below is one generation. Copy a segment, generate it, move to the next.',
  ];

  if (story) {
    lines.push(
      RULE,
      'THE FILM',
      THIN,
      `Logline     : ${story.logline}`,
      `Protagonist : ${story.protagonist.name}, ${story.protagonist.gender}, ${story.protagonist.age_range} - ${story.protagonist.role}`,
      `              ${story.protagonist.appearance}`,
      `              Wearing: ${story.protagonist.clothing}${story.protagonist.footwear ? `; ${story.protagonist.footwear}` : ''}`,
      `              ${story.protagonist.personality}`,
      `Locations   : ${story.locations.map((l) => l.name).join(' | ')}`,
      `Look        : ${story.visual_style.palette}; ${story.visual_style.lighting}; ` +
        `${story.visual_style.time_of_day}, ${story.visual_style.weather}`,
      `Camera      : ${story.visual_style.camera_language}`,
      `Voice-over  : ${story.narrator.accent}, ${story.narrator.gender}, ${story.narrator.age_range}; ` +
        `${story.narrator.tone}; ${story.narrator.pace}. THE SAME NARRATOR THROUGHOUT.`,
      `Subtitles   : progressive word-by-word typewriter reveal, synced to the voice-over.`,
      `Opens on    : ${story.opening_image}`,
      `Closes on   : ${story.closing_callback}`,
    );
  }

  lines.push(RULE, '');

  for (const planned of plan.video.segments) {
    const segment = state.segments.find((s) => s.segment_number === planned.segment_number);
    lines.push(
      `SEGMENT ${String(planned.segment_number).padStart(2, '0')} / ${plan.video.segment_count}   ` +
        `${planned.start_timecode} - ${planned.end_timecode}   (${planned.seconds} seconds)`,
      `PART ${planned.part} - ${planned.part_name}   |   BEAT: ${planned.story.beat}` +
        (planned.part === 2 ? `   |   UNIT ${planned.allocation.unit_code}` : ''),
      THIN,
    );

    if (!segment) {
      lines.push(`[NOT WRITTEN -- about ${planned.target_words} words of narration needed]`, '');
      continue;
    }

    lines.push(`STORY PURPOSE    : ${segment.story_purpose}`);
    lines.push(`CONTINUES FROM   : ${segment.continues_from}`);
    lines.push(`NARRATION (VO)   : ${segment.narration}`);
    if (story) {
      lines.push(
        `VOICE            : ${story.narrator.accent}, ${story.narrator.gender}, ${story.narrator.tone}`,
      );
    }
    lines.push(`SUBTITLE         : typewriter reveal, word by word, synced to the line above`);
    lines.push(`SCENE            : ${segment.scene_description}`);
    lines.push(`VISUAL DIRECTION : ${segment.visual_direction}`);
    lines.push(`CHARACTER        : ${segment.character_continuity}`);
    lines.push(`LOCATION         : ${segment.location_continuity}`);
    lines.push(`OBJECT           : ${segment.object_continuity}`);
    if (segment.on_screen_text && segment.on_screen_text.trim().length > 0) {
      lines.push(`ON-SCREEN TEXT   : ${segment.on_screen_text}`);
    }
    lines.push(`ENDS WITH        : ${segment.ends_with}`);
    if (segment.next_segment_starts_with) {
      lines.push(`NEXT STARTS WITH : ${segment.next_segment_starts_with}`);
    }
    if (segment.transition && segment.transition.trim().length > 0) {
      lines.push(`TRANSITION       : ${segment.transition}`);
    }
    if (segment.visual_mode === 'supporting_graphic') {
      lines.push('NOTE             : supporting graphic, not live action');
    }
    lines.push('');
  }

  lines.push(RULE, `END OF VIDEO SCRIPT  |  ${plan.video.segment_count} segments  |  3:00`, RULE);
  return lines.join('\n');
}

export function renderModuleDeck(state: ModulePackageState): string {
  const plan = state.plan;
  const lines: string[] = [
    RULE,
    `${state.title.toUpperCase()} - SLIDE DECK`,
    RULE,
    `Runtime : 9:00  |  ${plan.slides.slide_count} slides, at most ` +
      `${plan.slides.max_slide_seconds}s each`,
    RULE,
    '',
  ];

  for (const planned of plan.slides.slides) {
    const slide = state.slides.find((s) => s.slide_number === planned.slide_number);
    lines.push(
      `SLIDE ${String(planned.slide_number).padStart(2, '0')} / ${plan.slides.slide_count}   (${planned.seconds}s)`,
      THIN,
    );

    if (!slide) {
      lines.push(`[NOT WRITTEN -- about ${planned.target_notes_words} words of speaker notes needed]`, '');
      continue;
    }

    const planned2 = plan.slides.slides.find((p) => p.slide_number === slide.slide_number);
    if (planned2?.introduces_unit) lines.push(`UNIT  : ${planned2.allocation.unit_title}`);
    lines.push(`TITLE : ${slide.title}`);
    for (const bullet of slide.bullets) lines.push(`  - ${bullet}`);
    if (slide.key_takeaway && slide.key_takeaway.trim().length > 0) {
      lines.push(`TAKEAWAY: ${slide.key_takeaway}`);
    }
    if (slide.visual) {
      lines.push(`VISUAL: [${slide.visual.type}] ${slide.visual.description}`);
      if (slide.visual.labels.length > 0) {
        lines.push(`        ${slide.visual.labels.join('  ->  ')}`);
      }
    }
    lines.push('SPEAKER NOTES:');
    for (const paragraph of slide.speaker_notes.split('\n')) lines.push(`  ${paragraph}`);
    lines.push('');
  }

  lines.push(RULE, `END OF DECK  |  ${plan.slides.slide_count} slides  |  9:00`, RULE);
  return lines.join('\n');
}

/** Maps the stored deck onto the shape the PPTX writer takes. */
export function toPptxDeck(state: ModulePackageState): PptxDeckInput {
  return {
    title: state.title,
    slides: state.plan.slides.slides.map((planned) => {
      const slide = state.slides.find((s) => s.slide_number === planned.slide_number);
      return {
        title: slide?.title ?? `[Slide ${planned.slide_number} not written]`,
        bullets: slide?.bullets ?? [],
        ...(slide?.speaker_notes ? { notes: slide.speaker_notes } : {}),
        ...(slide?.key_takeaway ? { takeaway: slide.key_takeaway } : {}),
        // The unit label sits above the title, so a reader always knows which unit
        // of the module they are in.
        ...(planned.introduces_unit && planned.role === 'body'
          ? { eyebrow: `Unit ${planned.allocation.unit_code} - ${planned.allocation.unit_title}` }
          : {}),
        ...(slide?.visual ? { visual: slide.visual } : {}),
      };
    }),
  };
}
