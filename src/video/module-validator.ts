/**
 * Module package validation.
 *
 * The three things that make this package usable, checked mechanically:
 *
 *   Fits      eighteen segments, each of which reads in ten seconds; fourteen
 *             slides, each with about forty seconds of speaker notes. A segment
 *             that overruns cannot be generated at all, so its word band is a
 *             harder constraint than a scene's.
 *   Covers    every unit of the module appears in the video and in the deck. This
 *             is the requirement most easily lost, because nothing about a
 *             well-written script reveals that a unit was skipped.
 *   Clean     nothing in the delivered content refers to the handbook, a page, a
 *             figure, a unit number or a QR code -- the viewer has none of those.
 *
 * Whether the writing is any good is a judgement, and stays with the client.
 */

import type { Finding } from '../storyboard/validator.js';
import { groundingOverlap } from '../storyboard/validator.js';
import { getChunk } from '../documents/retriever.js';
import type { ModulePackageState } from '../types/module-content.js';
import { countWords, findSourceReference } from './validator.js';
import {
  findOutOfWorldVisual,
  linkStrength,
  sentenceCount,
  WEAK_LINK_OVERLAP,
} from './continuity.js';
import { continuityTokens } from './continuity.js';
import { config } from '../util/config.js';

/** Real-world footage must dominate; graphics are support, not the film. */
const MAX_GRAPHIC_SEGMENTS_PCT = 0.2;

/**
 * Whether a segment or slide that opens a unit actually names it.
 *
 * "Now let's move to Unit 1.2" is the failure this catches from the other side: the
 * learner must be told what the unit is *about*, in words taken from its title, not
 * merely that a boundary has been crossed. Matching on the title's distinctive words
 * rather than the literal string allows the natural phrasing a script needs.
 */
function namesUnit(text: string, unitTitle: string): boolean {
  const wanted = [...continuityTokens(unitTitle)];
  if (wanted.length === 0) return true;
  const found = continuityTokens(text);
  const hits = wanted.filter((t) => found.has(t)).length;
  return hits / wanted.length >= 0.4;
}

export interface ModuleValidationReport {
  package_id: string;
  course_id: string;
  module_number: number;
  version: number;
  passed: boolean;
  video: {
    segments_written: number;
    segments_planned: number;
    total_words: number;
    estimated_seconds: number;
    planned_seconds: number;
  };
  slides: {
    slides_written: number;
    slides_planned: number;
    notes_words: number;
    estimated_seconds: number;
    planned_seconds: number;
  };
  unit_coverage: {
    unit_code: string;
    unit_title: string;
    covered_by_segments: number[];
    covered_by_slides: number[];
    covered: boolean;
  }[];
  summary: { errors: number; warnings: number; infos: number };
  findings: Finding[];
}

/** Citations must resolve, be from the handbook, and belong to this module. */
function checkCitations(
  state: ModulePackageState,
  sources: { chunk_id: string }[],
  path: string,
  label: string,
  findings: Finding[],
): string[] {
  const unitCodes = new Set(state.plan.units.map((u) => u.unit_code));
  const texts: string[] = [];

  for (const source of sources) {
    const chunk = getChunk(state.course_id, source.chunk_id);
    if (!chunk) {
      findings.push({
        severity: 'error',
        code: 'unresolvable_citation',
        path,
        message: `${label} cites "${source.chunk_id}", which does not resolve in course "${state.course_id}".`,
        actual: source.chunk_id,
      });
      continue;
    }
    if (chunk.document_type !== 'PH') {
      findings.push({
        severity: 'error',
        code: 'wrong_source_document',
        path,
        message: `${label} cites the ${chunk.document_type}. Module content is grounded in the Participant Handbook only.`,
        expected: 'PH',
        actual: chunk.document_type,
      });
      continue;
    }
    if (!chunk.unit_code || !unitCodes.has(chunk.unit_code)) {
      findings.push({
        severity: 'error',
        code: 'citation_outside_module',
        path,
        message:
          `${label} cites unit ${chunk.unit_code ?? '(none)'}, which is not in module ` +
          `${state.module_number}. Content from another module does not belong in this package.`,
        expected: [...unitCodes].join(', '),
        actual: chunk.unit_code ?? '(none)',
      });
      continue;
    }
    texts.push(chunk.content);
  }
  return texts;
}

/** No delivered text may point at the source; the audience cannot see it. */
function checkSourceLeak(
  value: string | undefined,
  path: string,
  label: string,
  findings: Finding[],
): void {
  if (!value || value.length === 0) return;
  const leak = findSourceReference(value);
  if (!leak) return;
  findings.push({
    severity: 'error',
    code: 'source_reference_in_script',
    path,
    message:
      `${label} names ${leak.what} ("${leak.match}"). Delivered content must not refer to the ` +
      'handbook, page or figure numbers, unit or module numbers, or QR codes. Say it in the ' +
      'video\'s or the slide\'s own terms; the citation belongs in sources.',
    actual: leak.match,
  });
}

/**
 * Checks the eighteen segments as one film rather than eighteen clips.
 *
 * Four things are checkable without watching anything: that each segment opens on
 * the state the last one closed in, that the protagonist and the locations stay the
 * ones the story bible declared, that graphics have not taken over, and that the
 * final segment returns to the opening image.
 */
function checkStoryContinuity(state: ModulePackageState, findings: Finding[]): void {
  const segments = [...state.segments].sort((a, b) => a.segment_number - b.segment_number);
  const story = state.story;

  if (!story) {
    findings.push({
      severity: 'error',
      code: 'missing_story_bible',
      path: 'story',
      message:
        'This package has no story bible, so nothing fixes the protagonist, the locations, the ' +
        'light or the narrator across eighteen separately generated clips. Call set_module_story ' +
        'before writing the segments.',
    });
  }

  for (const [index, segment] of segments.entries()) {
    const path = `segments[${segment.segment_number}]`;
    const previous = index > 0 ? segments[index - 1] : undefined;

    // The cut itself: does this segment open on what the last one closed on?
    if (previous && segment.continues_from.trim().length > 0 && previous.ends_with.trim().length > 0) {
      const link = linkStrength(previous.ends_with, segment.continues_from);
      if (link.overlap === 0) {
        findings.push({
          severity: 'error',
          code: 'continuity_break',
          path: `${path}.continues_from`,
          message:
            `Segment ${segment.segment_number} opens on something with nothing in common with how ` +
            `segment ${previous.segment_number} ended. Previous ends with: "${previous.ends_with.slice(0, 80)}". ` +
            `This continues from: "${segment.continues_from.slice(0, 80)}". Carry the person, the ` +
            'object or the movement across the cut.',
        });
      } else if (link.overlap < WEAK_LINK_OVERLAP) {
        findings.push({
          severity: 'warning',
          code: 'weak_continuity',
          path: `${path}.continues_from`,
          message:
            `Segment ${segment.segment_number} shares little with the end of segment ` +
            `${previous.segment_number} (${link.shared.join(', ') || 'nothing'}). If these two clips ` +
            'were generated separately, would a viewer believe they are consecutive shots?',
          actual: link.overlap.toFixed(2),
        });
      }

      // And does it open on what the previous segment said it would?
      if (previous.next_segment_starts_with) {
        const promised = linkStrength(previous.next_segment_starts_with, segment.continues_from);
        if (promised.overlap === 0) {
          findings.push({
            severity: 'warning',
            code: 'handoff_not_honoured',
            path: `${path}.continues_from`,
            message:
              `Segment ${previous.segment_number} said segment ${segment.segment_number} would open ` +
              `on "${previous.next_segment_starts_with.slice(0, 70)}", but it opens on something ` +
              'else. Fix whichever of the two is wrong.',
          });
        }
      }
    }

    if (!story) continue;

    // The protagonist has to be described to every generation, by name.
    const protagonist = story.protagonist.name.toLowerCase();
    if (protagonist.length > 0 && !segment.character_continuity.toLowerCase().includes(protagonist)) {
      findings.push({
        severity: 'error',
        code: 'protagonist_not_carried',
        path: `${path}.character_continuity`,
        message:
          `Segment ${segment.segment_number} does not name ${story.protagonist.name} in its ` +
          'character continuity. Every clip is generated blind, so the protagonist must be ' +
          'described in each one or the film changes person mid-shot.',
      });
    }

    // Locations must be ones the film established, not new places per segment.
    const named = story.locations.find((l) =>
      segment.location_continuity.toLowerCase().includes(l.name.toLowerCase()),
    );
    if (story.locations.length > 0 && !named) {
      findings.push({
        severity: 'warning',
        code: 'unknown_location',
        path: `${path}.location_continuity`,
        message:
          `Segment ${segment.segment_number} is set somewhere the story bible does not list ` +
          `(${story.locations.map((l) => l.name).join(', ')}). Keep to a small set of connected ` +
          'places, or add this one to the bible if the story genuinely goes there.',
        actual: segment.location_continuity.slice(0, 70),
      });
    }
  }

  // Graphics support the film; they are not the film.
  const graphics = segments.filter((s) => s.visual_mode === 'supporting_graphic').length;
  const cap = Math.floor(state.plan.video.segment_count * MAX_GRAPHIC_SEGMENTS_PCT);
  if (graphics > cap) {
    findings.push({
      severity: 'error',
      code: 'too_many_graphics',
      path: 'segments',
      message:
        `${graphics} of ${segments.length} segments are supporting graphics, against a cap of ${cap}. ` +
        'Real-world action is the primary visual language; a film of diagrams is a slideshow.',
      expected: `<= ${cap}`,
      actual: String(graphics),
    });
  }

  // The last shot should answer the first.
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first && last && first.segment_number === 1 && last.segment_number === state.plan.video.segment_count) {
    const callback = linkStrength(
      `${first.scene_description} ${first.ends_with}`,
      `${last.scene_description} ${last.ends_with}`,
    );
    if (callback.overlap === 0) {
      findings.push({
        severity: 'warning',
        code: 'no_closing_callback',
        path: `segments[${last.segment_number}].scene_description`,
        message:
          'The final segment shares no image with the opening one. The ending should return to ' +
          'where the film began and show what it has become, so the viewer feels the question ' +
          'from the first ten seconds has been answered.',
      });
    }
  }
}

export function validateModulePackage(state: ModulePackageState): ModuleValidationReport {
  const findings: Finding[] = [];
  const plan = state.plan;

  // --- Video ------------------------------------------------------------
  const segmentsByNumber = new Map(state.segments.map((s) => [s.segment_number, s]));
  let segmentWords = 0;

  for (const planned of plan.video.segments) {
    const path = `segments[${planned.segment_number}]`;
    const segment = segmentsByNumber.get(planned.segment_number);
    if (!segment) {
      findings.push({
        severity: 'error',
        code: 'missing_segment',
        path,
        message:
          `Segment ${planned.segment_number} (${planned.start_timecode}-${planned.end_timecode}) has ` +
          'not been written. All 18 segments are needed for a 3-minute video.',
      });
      continue;
    }

    const words = countWords(segment.narration);
    segmentWords += words;

    if (segment.narration.trim().length === 0) {
      findings.push({
        severity: 'error',
        code: 'empty_narration',
        path: `${path}.narration`,
        message: `Segment ${planned.segment_number} has no narration.`,
      });
    } else if (words > planned.max_words) {
      // Overrunning is the failure that cannot be absorbed: the generator produces
      // ten seconds and the rest of the line is simply lost.
      findings.push({
        severity: 'error',
        code: 'segment_overruns',
        path: `${path}.narration`,
        message:
          `Segment ${planned.segment_number}'s narration is ${words} words, which does not fit ` +
          `10 seconds at ${plan.words_per_minute} words per minute. Cut it to ` +
          `${planned.min_words}-${planned.max_words} words.`,
        expected: `${planned.min_words}-${planned.max_words} words`,
        actual: `${words} words`,
      });
    } else if (words < planned.min_words) {
      findings.push({
        severity: 'warning',
        code: 'segment_underruns',
        path: `${path}.narration`,
        message:
          `Segment ${planned.segment_number}'s narration is ${words} words and will leave dead air ` +
          `in a 10-second segment. Aim for ${planned.target_words}.`,
        expected: `${planned.min_words}-${planned.max_words} words`,
        actual: `${words} words`,
      });
    }

    // Each clip is generated on its own with no memory of the others, so every one
    // of these has to be stated in writing or the generator invents it afresh.
    for (const field of [
      'story_purpose',
      'continues_from',
      'scene_description',
      'visual_direction',
      'character_continuity',
      'location_continuity',
      'object_continuity',
      'ends_with',
    ] as const) {
      if ((segment[field] ?? '').trim().length === 0) {
        findings.push({
          severity: 'error',
          code: 'missing_continuity_field',
          path: `${path}.${field}`,
          message:
            `Segment ${planned.segment_number} has no ${field.replace(/_/g, ' ')}. Each segment is ` +
            'generated in isolation, so anything not written down is lost.',
        });
      }
    }

    const isLast = planned.segment_number === plan.video.segment_count;
    if (!isLast) {
      for (const field of ['next_segment_starts_with', 'transition'] as const) {
        if ((segment[field] ?? '').trim().length === 0) {
          findings.push({
            severity: 'error',
            code: 'missing_handoff',
            path: `${path}.${field}`,
            message:
              `Segment ${planned.segment_number} does not say ${
                field === 'transition'
                  ? 'how it hands over to'
                  : 'what must open'
              } segment ${planned.segment_number + 1}. Without it the 18 clips cut together as ` +
              'unrelated shots.',
          });
        }
      }
    }

    // A segment that opens a unit must say what that unit is about.
    if (planned.introduces_unit && segment.narration.trim().length > 0) {
      if (!namesUnit(`${segment.narration} ${segment.story_purpose}`, planned.allocation.unit_title)) {
        findings.push({
          severity: 'warning',
          code: 'unit_not_introduced',
          path: `${path}.narration`,
          message:
            `Segment ${planned.segment_number} opens the unit "${planned.allocation.unit_title}" but ` +
            'its narration does not say what the unit is about. Name it and give the learner ' +
            'something in the same breath -- an announcement on its own spends ten of the ninety ' +
            'teaching seconds saying nothing.',
          expected: planned.allocation.unit_title,
        });
      }
    }

    // Sentences are a proxy for ideas, and ten seconds holds one.
    if (sentenceCount(segment.narration) > 2) {
      findings.push({
        severity: 'warning',
        code: 'too_many_ideas',
        path: `${path}.narration`,
        message:
          `Segment ${planned.segment_number}'s narration runs to ${sentenceCount(segment.narration)} ` +
          'sentences. Ten seconds carries one idea; split the rest across the segments that follow.',
      });
    }

    // The film is a rural documentary. These are the visuals that break its world.
    if (segment.visual_mode !== 'supporting_graphic') {
      for (const field of ['scene_description', 'visual_direction', 'transition'] as const) {
        const value = segment[field];
        if (!value) continue;
        const strange = findOutOfWorldVisual(value);
        if (!strange) continue;
        findings.push({
          severity: 'warning',
          code: 'out_of_world_visual',
          path: `${path}.${field}`,
          message:
            `Segment ${planned.segment_number} calls for ${strange.what} ("${strange.match}") in a ` +
            'segment marked as real-world footage. The film is one continuous rural documentary; ' +
            'show the idea through the world already established, or mark the segment as a ' +
            'supporting graphic if a diagram genuinely explains it better.',
          actual: strange.match,
        });
      }
    }

    for (const field of [
      'narration',
      'scene_description',
      'visual_direction',
      'on_screen_text',
      'story_purpose',
    ] as const) {
      checkSourceLeak(segment[field], `${path}.${field}`, `Segment ${planned.segment_number}'s ${field}`, findings);
    }

    if (segment.sources.length === 0) {
      findings.push({
        severity: 'error',
        code: 'missing_citation',
        path: `${path}.sources`,
        message: `Segment ${planned.segment_number} cites nothing.`,
      });
    } else {
      const cited = checkCitations(
        state,
        segment.sources,
        `${path}.sources`,
        `Segment ${planned.segment_number}`,
        findings,
      );
      if (cited.length > 0 && segment.narration.trim().length > 0) {
        const overlap = groundingOverlap(segment.narration, cited.join('\n'));
        if (overlap < config.grounding.minOverlap) {
          findings.push({
            severity: 'warning',
            code: 'low_grounding_overlap',
            path: `${path}.narration`,
            message:
              `Only ${(overlap * 100).toFixed(0)}% of segment ${planned.segment_number}'s distinctive ` +
              'words appear in the handbook text it cites. A script is expected to reword, so this ' +
              'is a lexical signal only -- check it asserts nothing the unit does not say.',
            expected: `>= ${config.grounding.minOverlap.toFixed(2)}`,
            actual: overlap.toFixed(2),
          });
        }
      }
    }
  }

  // --- The film as one film --------------------------------------------
  if (state.segments.length > 0) {
    checkStoryContinuity(state, findings);
  }

  // --- Slides -----------------------------------------------------------
  const slidesByNumber = new Map(state.slides.map((s) => [s.slide_number, s]));
  let notesWords = 0;

  for (const planned of plan.slides.slides) {
    const path = `slides[${planned.slide_number}]`;
    const slide = slidesByNumber.get(planned.slide_number);
    if (!slide) {
      findings.push({
        severity: 'error',
        code: 'missing_slide',
        path,
        message: `Slide ${planned.slide_number} has not been written. The deck is ${plan.slides.slide_count} slides.`,
      });
      continue;
    }

    const words = countWords(slide.speaker_notes);
    notesWords += words;

    if (slide.title.trim().length === 0) {
      findings.push({
        severity: 'error',
        code: 'missing_slide_title',
        path: `${path}.title`,
        message: `Slide ${planned.slide_number} has no title.`,
      });
    }
    if (slide.bullets.length < planned.min_bullets || slide.bullets.length > planned.max_bullets) {
      findings.push({
        severity: 'warning',
        code: 'slide_bullet_count',
        path: `${path}.bullets`,
        message:
          `Slide ${planned.slide_number} has ${slide.bullets.length} bullets. ` +
          `${planned.min_bullets}-${planned.max_bullets} reads comfortably at this size.`,
        expected: `${planned.min_bullets}-${planned.max_bullets}`,
        actual: String(slide.bullets.length),
      });
    }
    for (const [index, bullet] of slide.bullets.entries()) {
      if (countWords(bullet) > 14) {
        findings.push({
          severity: 'warning',
          code: 'bullet_too_long',
          path: `${path}.bullets[${index}]`,
          message:
            `Slide ${planned.slide_number} bullet ${index + 1} runs to a sentence. Bullets are cues ` +
            'on screen; the explanation belongs in the speaker notes.',
          actual: bullet.slice(0, 60),
        });
      }
    }

    if (words === 0) {
      findings.push({
        severity: 'error',
        code: 'missing_speaker_notes',
        path: `${path}.speaker_notes`,
        message:
          `Slide ${planned.slide_number} has no speaker notes, so it carries none of its ` +
          `${planned.seconds} seconds of the session.`,
      });
    } else if (words < planned.min_notes_words || words > planned.max_notes_words) {
      findings.push({
        severity: 'warning',
        code: 'slide_notes_budget',
        path: `${path}.speaker_notes`,
        message:
          `Slide ${planned.slide_number}'s notes run about ` +
          `${Math.round((words / plan.words_per_minute) * 60)}s against its ${planned.seconds}s share.`,
        expected: `${planned.min_notes_words}-${planned.max_notes_words} words`,
        actual: `${words} words`,
      });
    }

    // Half the slide is the right-hand column; a slide without a visual brief
    // leaves it empty or decorative, which is the same thing.
    if (planned.role === 'body' && (!slide.visual || slide.visual.type === 'none')) {
      findings.push({
        severity: 'warning',
        code: 'missing_slide_visual',
        path: `${path}.visual`,
        message:
          `Slide ${planned.slide_number} has no teaching visual. The right-hand column is half the ` +
          'slide: give it a process, comparison, component set or other labelled diagram that ' +
          'explains the idea, or say why this slide genuinely needs none.',
      });
    } else if (slide.visual && slide.visual.type !== 'scene' && slide.visual.type !== 'none') {
      if (slide.visual.labels.length < 2) {
        findings.push({
          severity: 'warning',
          code: 'visual_not_drawable',
          path: `${path}.visual.labels`,
          message:
            `Slide ${planned.slide_number}'s ${slide.visual.type} visual has fewer than two labels, ` +
            'so it cannot be drawn as a diagram and falls back to a text card. Give it the steps, ' +
            'parts or sides in order.',
        });
      }
      if (slide.visual.labels.length > 6) {
        findings.push({
          severity: 'warning',
          code: 'visual_overcrowded',
          path: `${path}.visual.labels`,
          message:
            `Slide ${planned.slide_number}'s visual carries ${slide.visual.labels.length} labels. ` +
            'Six is the most that stays readable at this size; split the idea across two slides.',
        });
      }
    }

    if (planned.introduces_unit && !namesUnit(`${slide.title} ${slide.speaker_notes}`, planned.allocation.unit_title)) {
      findings.push({
        severity: 'warning',
        code: 'unit_not_introduced',
        path: `${path}.title`,
        message:
          `Slide ${planned.slide_number} opens the unit "${planned.allocation.unit_title}" without ` +
          'naming what it covers. The deck follows the handbook\'s units; the learner should know ' +
          'which one they are in.',
      });
    }

    checkSourceLeak(slide.title, `${path}.title`, `Slide ${planned.slide_number}'s title`, findings);
    checkSourceLeak(slide.speaker_notes, `${path}.speaker_notes`, `Slide ${planned.slide_number}'s notes`, findings);
    for (const [index, bullet] of slide.bullets.entries()) {
      checkSourceLeak(bullet, `${path}.bullets[${index}]`, `Slide ${planned.slide_number} bullet ${index + 1}`, findings);
    }

    if (slide.sources.length === 0) {
      findings.push({
        severity: 'error',
        code: 'missing_citation',
        path: `${path}.sources`,
        message: `Slide ${planned.slide_number} cites nothing.`,
      });
    } else {
      checkCitations(state, slide.sources, `${path}.sources`, `Slide ${planned.slide_number}`, findings);
    }
  }

  // No slide may hold more than half a minute of talking: that is what keeps the
  // deck readable rather than dense.
  for (const planned of plan.slides.slides) {
    const slide = slidesByNumber.get(planned.slide_number);
    if (!slide) continue;
    const spoken = Math.round((countWords(slide.speaker_notes) / plan.words_per_minute) * 60);
    if (spoken > plan.slides.max_slide_seconds) {
      findings.push({
        severity: 'error',
        code: 'slide_over_time',
        path: `slides[${planned.slide_number}].speaker_notes`,
        message:
          `Slide ${planned.slide_number} carries about ${spoken}s of narration, over the ` +
          `${plan.slides.max_slide_seconds}s a single slide may hold. Split it, or cut it to ` +
          `${planned.max_notes_words} words.`,
        expected: `<= ${plan.slides.max_slide_seconds}s`,
        actual: `${spoken}s`,
      });
    }
  }

  // The deck follows the handbook's unit order; reordering units for aesthetics
  // breaks the sequence the handbook teaches in.
  const slideUnitOrder = plan.slides.slides
    .filter((s) => s.role === 'body' && slidesByNumber.has(s.slide_number))
    .map((s) => s.allocation.unit_code);
  const expectedOrder = plan.units.map((u) => u.unit_code);
  const seenOrder = [...new Set(slideUnitOrder)];
  const expectedSeen = expectedOrder.filter((u) => seenOrder.includes(u));
  if (seenOrder.join('|') !== expectedSeen.join('|')) {
    findings.push({
      severity: 'warning',
      code: 'unit_order_changed',
      path: 'slides',
      message:
        `The deck presents units as ${seenOrder.join(', ')}, but the handbook has them as ` +
        `${expectedSeen.join(', ')}. Keep the handbook's order: it is the sequence the module ` +
        'teaches in.',
    });
  }

  // --- Unit coverage ----------------------------------------------------
  const citedUnits = (chunkIds: string[]): Set<string> => {
    const codes = new Set<string>();
    for (const id of chunkIds) {
      const chunk = getChunk(state.course_id, id);
      if (chunk?.unit_code) codes.add(chunk.unit_code);
    }
    return codes;
  };
  const videoUnits = citedUnits(state.segments.flatMap((s) => s.sources.map((x) => x.chunk_id)));
  const slideUnits = citedUnits(state.slides.flatMap((s) => s.sources.map((x) => x.chunk_id)));

  const unitCoverage = plan.units.map((unit) => {
    const inVideo = state.segments
      .filter((s) => s.sources.some((x) => unit.chunk_ids.includes(x.chunk_id)))
      .map((s) => s.segment_number);
    const inSlides = state.slides
      .filter((s) => s.sources.some((x) => unit.chunk_ids.includes(x.chunk_id)))
      .map((s) => s.slide_number);
    return {
      unit_code: unit.unit_code,
      unit_title: unit.unit_title,
      covered_by_segments: inVideo,
      covered_by_slides: inSlides,
      covered: inVideo.length > 0 && inSlides.length > 0,
    };
  });

  const written = state.segments.length > 0 || state.slides.length > 0;
  for (const unit of unitCoverage) {
    if (state.segments.length > 0 && !videoUnits.has(unit.unit_code)) {
      findings.push({
        severity: 'error',
        code: 'unit_not_covered_by_video',
        path: 'segments',
        message:
          `No segment covers unit ${unit.unit_code} (${unit.unit_title}). The 3-minute video must ` +
          'cover every unit in the module; the plan allocated segments to it.',
        actual: unit.unit_code,
      });
    }
    if (state.slides.length > 0 && !slideUnits.has(unit.unit_code)) {
      findings.push({
        severity: 'error',
        code: 'unit_not_covered_by_slides',
        path: 'slides',
        message:
          `No slide covers unit ${unit.unit_code} (${unit.unit_title}). The 14-slide deck must cover ` +
          'every unit in the module; the plan allocated slides to it.',
        actual: unit.unit_code,
      });
    }
  }
  void written;

  const summary = {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length,
  };

  return {
    package_id: state.package_id,
    course_id: state.course_id,
    module_number: state.module_number,
    version: state.version,
    passed: summary.errors === 0,
    video: {
      segments_written: state.segments.length,
      segments_planned: plan.video.segment_count,
      total_words: segmentWords,
      estimated_seconds: Math.round((segmentWords / plan.words_per_minute) * 60),
      planned_seconds: plan.video.total_seconds,
    },
    slides: {
      slides_written: state.slides.length,
      slides_planned: plan.slides.slide_count,
      notes_words: notesWords,
      estimated_seconds: Math.round((notesWords / plan.words_per_minute) * 60),
      planned_seconds: plan.slides.total_seconds,
    },
    unit_coverage: unitCoverage,
    summary,
    findings,
  };
}
