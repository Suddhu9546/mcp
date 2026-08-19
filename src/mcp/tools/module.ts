/**
 * Module content package tools: the 12 minutes of learning content for one
 * Participant Handbook module.
 *
 * The flow stops at the module. Everything below the module -- which units exist,
 * how they divide across eighteen video segments and fourteen slides, how many
 * words fit ten seconds -- is arithmetic this layer does, not a choice the user is
 * asked to make. What comes back is a set of slots with their budgets and their
 * source material attached; the client writes the content into them.
 *
 *   plan_module_content    -> plan: 18 segments + 14 slides, unit by unit
 *   get_module_source      -> the handbook text behind each slot
 *   submit_module_video    -> the 18 segments
 *   submit_module_slides   -> the 14 slides
 *   validate_module_package-> fit, unit coverage, citations, no source leaks
 *   get_module_video_script-> copy-ready segments, one per generation
 *   get_module_slides      -> the deck as text
 *   render_module_pptx     -> the deck as a .pptx with speaker notes
 *   export_module_package  -> every deliverable as a file, for the user to download
 *
 * Everything that produces text also writes it to a file under the package's
 * directory and returns the path. An eighteen-segment script is tens of kilobytes;
 * past a certain size "copy it out of the reply" stops being a reasonable ask.
 */

import { z } from 'zod';
import { getSubject, listSubjectStatuses } from '../../catalog/subject-catalog.js';
import { findPhUnits, getPhOutline, readPhModule, UnitNotFoundError } from '../../documents/ph-outline.js';
import { getChunk } from '../../documents/retriever.js';
import { renderPptx } from '../../pptx/pptx-writer.js';
import type { SourceRef } from '../../types/source.js';
import type { SlideContent, VideoSegmentContent } from '../../types/module-content.js';
import { buildModulePlan, moduleSourceForPlan } from '../../video/module-plan.js';
import {
  renderModuleDeck,
  renderModuleVideoScript,
  toPptxDeck,
} from '../../video/module-render.js';
import {
  commitModulePackage,
  createModulePackage,
  getModulePackage,
  listModulePackages,
  listModulePackageVersions,
} from '../../video/module-store.js';
import { validateModulePackage } from '../../video/module-validator.js';
import { buildSubtitleCues, toSrt } from '../../video/continuity.js';
import { getCharacterLock, setCharacterLock } from '../../video/character-lock.js';
import { countWords } from '../../video/validator.js';
import {
  moduleFilename,
  writeArtifactFile,
  type WrittenFile,
} from '../../storage/file-output.js';
import type { ToolDefinition } from './result.js';
import { fail, ok, textResult as text } from './result.js';

function resolveCourse(subject: string): { course_id: string; subject_code: string } {
  const entry = getSubject(subject);
  const status = listSubjectStatuses(entry.track).find((s) => s.subject_id === entry.subject_id)!;
  if (!status.ready) throw new Error(`${entry.code} is not available yet. ${status.blocker}`);
  return { course_id: entry.course_id, subject_code: entry.code };
}

/** Citations are rebuilt from the index so page and section describe the real chunk. */
function toSourceRef(courseId: string, chunkId: string, quote?: string): SourceRef {
  const chunk = getChunk(courseId, chunkId);
  if (!chunk) {
    return {
      document_type: 'PH',
      pdf_page: 0,
      section: '(unresolved citation)',
      chunk_id: chunkId,
      ...(quote ? { quote } : {}),
    };
  }
  return {
    document_type: chunk.document_type,
    pdf_page: chunk.pdf_page,
    ...(chunk.printed_page !== undefined ? { printed_page: chunk.printed_page } : {}),
    section: chunk.section,
    ...(chunk.subsection !== undefined ? { subsection: chunk.subsection } : {}),
    chunk_id: chunk.chunk_id,
    ...(quote ? { quote } : {}),
  };
}

const sourceSchema = z.object({
  chunk_id: z.string(),
  quote: z.string().optional(),
});

/**
 * Narrows a validation report to one half of the package.
 *
 * Submitting the video while the deck is still unwritten otherwise reports fourteen
 * missing slides, which reads as "your video is broken" and invites the client to
 * go and fix something that is not wrong. Each submission is answered with findings
 * about what it actually submitted; validate_module_package still reports the lot.
 */
function halfReport(
  report: ReturnType<typeof validateModulePackage>,
  half: 'segments' | 'slides',
): { passed: boolean; errors: number; warnings: number; findings: typeof report.findings } {
  const findings = report.findings.filter((f) => f.path.startsWith(half));
  const errors = findings.filter((f) => f.severity === 'error').length;
  return {
    passed: errors === 0,
    errors,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const planTool: ToolDefinition = {
  name: 'plan_module_content',
  title: 'Plan a module content package',
  description:
    'Plans the full 12 minutes of content for one Participant Handbook module. The video is ' +
    'three parts: Part 1 (segments 1-6, 60s) orients the learner to the whole module using the ' +
    'handbook\'s stated learning outcomes, Part 2 (segments 7-15, 90s) teaches every unit in ' +
    'handbook order, Part 3 (segments 16-18, 30s) consolidates. The deck is sized to the module ' +
    'rather than fixed: nine minutes across as many slides as it needs, never more than 30 seconds ' +
    'on any one slide. Returns a package_id, the plan, and a content map of the module\'s outcomes ' +
    'and units. Every segment and slide is told which unit it covers, which portion, which ' +
    'chunk_ids to cite and how many words fit its seconds. Accepts a module number, or a topic to ' +
    'resolve to the module that holds it. Ask the user nothing further: every duration and count ' +
    'is settled.',
  inputSchema: {
    subject: z.string().optional().describe('Subject id, code or course_id, e.g. "biofuels".'),
    module_number: z.number().int().optional().describe('Participant Handbook module (chapter) number.'),
    topic: z
      .string()
      .optional()
      .describe('A topic or unit heading; the module containing it is used. Requires no module_number.'),
    words_per_minute: z
      .number()
      .int()
      .min(60)
      .max(220)
      .optional()
      .describe('Narration pace used to size every segment and slide. Defaults to 140.'),
    title: z.string().optional().describe('Title for the video and deck. Defaults to the module title.'),
  },
  handler: (args) => {
    let courseId: string;
    let moduleNumber: number;

    if (args.module_number !== undefined && args.subject) {
      courseId = resolveCourse(String(args.subject)).course_id;
      moduleNumber = Number(args.module_number);
    } else if (args.topic) {
      const found = findPhUnits(String(args.topic), {
        ...(args.subject ? { courseId: resolveCourse(String(args.subject)).course_id } : {}),
      });
      if (found.candidates.length === 0) {
        return fail(found.message ?? `No unit matches "${String(args.topic)}".`, found);
      }
      if (!found.confident) {
        return fail(
          `"${String(args.topic)}" matches units in more than one place closely enough that ` +
            'picking one would be a guess. Ask the user which they mean, then pass its module.',
          found,
        );
      }
      courseId = found.candidates[0]!.course_id;
      moduleNumber = found.candidates[0]!.unit.module_number;
    } else {
      return fail('Give either subject + module_number, or a topic to resolve.');
    }

    let reading;
    try {
      reading = readPhModule(courseId, moduleNumber);
    } catch (err) {
      if (err instanceof UnitNotFoundError) return fail(err.message);
      throw err;
    }

    const plan = buildModulePlan({
      reading,
      ...(args.words_per_minute ? { wordsPerMinute: Number(args.words_per_minute) } : {}),
    });
    const state = createModulePackage(plan, args.title ? String(args.title) : undefined);

    // A subject's character is locked the first time it is chosen, so a second
    // module of the same subject does not introduce a different person.
    const locked = getCharacterLock(courseId);

    return ok({
      package_id: state.package_id,
      base_version: state.version,
      title: state.title,
      module: { number: plan.module_number, title: plan.module_title, unit_count: plan.units.length },
      ...(locked
        ? {
            locked_character: locked,
            character_note:
              `This subject already has a presenter: ${locked.protagonist.name}. Reuse them and the ` +
              'same narrator in set_module_story -- a learner taking two modules of one subject ' +
              'should meet the same person.',
          }
        : {}),
      plan,
      next_call: {
        tool: 'get_module_content_spec',
        args: { package_id: state.package_id },
      },
      next_step:
        'Generate now, without asking the user anything further -- the module, the duration and ' +
        'the units are all settled. In order: get_module_content_spec (what to write), ' +
        'get_module_source (the handbook text), set_module_story (the film\'s constants, which ' +
        `must be set BEFORE any segment), submit_module_video (${plan.video.segment_count} ` +
        `segments), submit_module_slides (${plan.slides.slide_count} slides), ` +
        'validate_module_package, then export_module_package and give the user the files. Each ' +
        'result names the next call; follow it.',
    });
  },
};

const sourceTool: ToolDefinition = {
  name: 'get_module_source',
  title: 'Get a module package\'s source text',
  description:
    'Returns the Participant Handbook text behind a package: by default every unit of the module ' +
    'in full, and optionally the exact portion allocated to one video segment or one slide. The ' +
    'plan says which unit and portion each slot covers; this is the text to write it from. Content ' +
    'may present this material any way that teaches well, but may not go beyond it.',
  inputSchema: {
    package_id: z.string(),
    segment_number: z.number().int().optional().describe('Return only this segment\'s allocated text.'),
    slide_number: z.number().int().optional().describe('Return only this slide\'s allocated text.'),
  },
  handler: (args) => {
    const state = getModulePackage(String(args.package_id));
    const reading = readPhModule(state.course_id, state.module_number);
    const mapped = moduleSourceForPlan(reading, state.plan);

    if (args.segment_number !== undefined) {
      const number = Number(args.segment_number);
      const planned = state.plan.video.segments.find((s) => s.segment_number === number);
      if (!planned) return fail(`This package has no segment ${number}.`);
      return ok({ package_id: state.package_id, segment: planned, source_text: mapped.segments[number] });
    }
    if (args.slide_number !== undefined) {
      const number = Number(args.slide_number);
      const planned = state.plan.slides.slides.find((s) => s.slide_number === number);
      if (!planned) return fail(`This package has no slide ${number}.`);
      return ok({ package_id: state.package_id, slide: planned, source_text: mapped.slides[number] });
    }

    return ok({
      package_id: state.package_id,
      module_number: state.module_number,
      module_title: state.module_title,
      word_count: reading.word_count,
      units: reading.units.map((u) => ({
        unit_code: u.unit.unit_code,
        unit_title: u.unit.title,
        word_count: u.word_count,
        chunk_ids: u.chunk_ids,
        text: u.text,
      })),
      note:
        'This is the whole module. The plan states which unit and which portion of it each ' +
        'segment and slide covers; keep to that allocation so the package covers every unit once.',
    });
  },
};

const specTool: ToolDefinition = {
  name: 'get_module_content_spec',
  title: 'Get module content field spec',
  description:
    'What to write into each video segment and each slide, what is fixed by the plan, and the ' +
    'standard the output is held to. Read this before submit_module_video or submit_module_slides.',
  inputSchema: {},
  handler: () =>
    ok({
      how_to_approach_the_video: [
        'You are directing a short documentary, not writing eighteen prompts. Write the whole ' +
          '3-minute film first -- the person, the problem, what they discover, what goes wrong, ' +
          'what they do about it -- and only then cut it into eighteen 10-second shots.',
        'Do not optimise segments independently. Optimise the relationship between them. Segment 1 ' +
          'creates a question, segment 2 begins answering it, segment 3 raises the next one, and ' +
          'so on to segment 18, which pays back the opening image.',
        'The plan gives every segment its story beat and its handbook material. The beat decides ' +
          'how the segment is dramatised; the material decides what is true.',
        'Test: if segments 7 and 8 were generated separately and shown back to back, would a ' +
          'viewer believe they are consecutive shots of the same film? If not, rewrite the joint.',
        'Second test: watched with the sound off, does the story still read? If not, the film is ' +
          'narration with pictures attached.',
      ],
      story_bible_first: {
        tool: 'set_module_story',
        why:
          'Each 10-second clip is generated separately and the generator remembers nothing between ' +
          'calls. Every constant -- who the protagonist is, what they are wearing, where we are, ' +
          'what the light is doing, who is narrating -- exists only because the script repeats it.',
        contains:
          'logline, protagonist (name, age, role, appearance, clothing, personality), 3-6 connected ' +
          'locations, visual style, narrator profile, the opening image, the closing callback, and ' +
          'a line per act.',
      },
      the_three_parts: {
        part_1:
          'Segments 1-6, 60 seconds: MODULE ORIENTATION. What this module is about, why it matters, ' +
          'and what the learner will be able to do -- built from the handbook\'s stated learning ' +
          'outcomes, which the plan attaches to segments 4 and 5. This is not unit teaching: do not ' +
          'start teaching unit 1 here.',
        part_2:
          'Segments 7-15, 90 seconds: THE UNITS. Every unit of the module, in handbook order. The ' +
          'plan says which unit each segment carries and whether it opens one. A segment that opens ' +
          'a unit must name what the unit is about and teach something in the same ten seconds -- ' +
          '"now let us move to the next unit" wastes a ninth of the teaching time.',
        part_3:
          'Segments 16-18, 30 seconds: CONCLUSION. The main thing learned, how the units connect, ' +
          'and the practical takeaway, returning to the opening image. No new fact, and not ' +
          '"thank you for watching".',
      },
      video_segments: {
        count: '18, each exactly 10 seconds. The generator produces ten seconds per generation.',
        story_purpose: 'What this segment does for the story: its beat, in your own words.',
        continues_from:
          'The exact visual, action or state inherited from the previous segment\'s last moment. ' +
          'This is the single most important field: it is what makes eighteen separate generations ' +
          'read as one continuous film. Segment 1 states the world it opens in.',
        narration:
          'The voice-over. It must read naturally within ten seconds at the plan\'s pace -- about ' +
          '23 words, one idea. Simple Indian English, short sentences, spoken not written.',
        scene_description: 'What is happening on screen: who, where, what action.',
        visual_direction:
          'Camera, movement, framing and light. Concrete enough to generate from without ' +
          'interpretation, and consistent with the film\'s camera language.',
        character_continuity:
          'The protagonist restated BY NAME with appearance and clothing, every single segment. ' +
          'The generator has no memory; omit this and the person changes mid-film.',
        location_continuity: 'Which of the bible\'s locations this is, and its current state.',
        object_continuity:
          'The object carried in from the last segment and out into the next. Prefer continuing an ' +
          'object over introducing a new one: bale -> bale lifted -> bale on the trailer -> trailer ' +
          'arriving.',
        ends_with: 'The exact visual or action at the final moment of these ten seconds.',
        next_segment_starts_with:
          'What segment N+1 must open on. Required except on segment 18, and segment N+1\'s ' +
          'continues_from must match it.',
        transition:
          'How the hand-over is motivated from INSIDE the scene: a movement, a hand, a vehicle, a ' +
          'door, a match cut, a sound bridge. Not a white flash or a graphic wipe.',
        visual_mode:
          '"real_world" or "supporting_graphic". At most 3 of the 18 may be graphics -- real action ' +
          'is the film\'s primary language, and a film of diagrams is a slideshow.',
        on_screen_text: 'Text burned onto the screen. Optional, and short.',
        sources: 'chunk_ids from this segment\'s allocation in the plan.',
      },
      voice_and_subtitles: {
        narrator:
          'One narrator for all 18 segments -- same accent, gender, age, tone and pace, as recorded ' +
          'in the story bible. Indian English unless the user says otherwise.',
        narration_style:
          'Simple Indian English a learner understands on one listen. Short sentences, ' +
          'conversational, practical. No corporate jargon, no marketing language, no poetry.',
        subtitles:
          'Generated for you: get_module_subtitles builds a progressive word-by-word typewriter ' +
          'reveal, timed across each segment\'s ten seconds, as SRT or as cues. Do not write ' +
          'subtitle text into the segments.',
      },
      rural_relatability: [
        'The audience includes rural learners. Prefer situations they would recognise: fields, ' +
          'residue, tractors, bales, sacks, weighing scales, collection points, storage sheds, ' +
          'village roads, small workshops, real conversations, practical money decisions.',
        'The test is "this could happen in my village", not "this looks like an ad".',
        'Show, do not tell. If the narration says supply is seasonal, show harvest, then storage, ' +
          'then the empty months. If it says moisture matters, show the meter, the reading, and the ' +
          'load being accepted or turned away.',
        'Avoid white studios, holograms, floating icons, corporate offices and stock-footage ' +
          'montages. If an abstract idea must be explained, explain it inside the world the film ' +
          'has already built.',
      ],
      slides: {
        count:
          'Set by the plan, not fixed: nine minutes divided into as many slides as the module needs, ' +
          'with a hard limit of 30 seconds of narration on any one slide. Longer modules get more ' +
          'slides rather than denser ones.',
        structure:
          'Slide 1 opens the module. Slide 2 states what the learner will be able to do, from the ' +
          'handbook\'s outcomes. The body slides work through the units in handbook order, and the ' +
          'first slide of each unit names it. The last slide consolidates.',
        title: 'The slide\'s point, not a label. "Moisture decides burn quality", not "Moisture".',
        bullets:
          '3-5 short cues, under about 12 words each. Bullets are what the audience reads at a ' +
          'glance; they are not the narration written out.',
        speaker_notes:
          'What the presenter says while the slide is up -- roughly 90 words. This is where the ' +
          'teaching actually happens, so it carries the explanation, the example and the reason ' +
          'it matters.',
        key_takeaway: 'Optional: one line the learner should leave the slide with.',
        visual:
          'The right-hand teaching visual, and the half of the slide that carries the structure of ' +
          'the idea. Give it a type, a description, and the labels in order. The labelled types ' +
          '(process, workflow, lifecycle, comparison, components, relationship, cause_effect, ' +
          'measurement) are DRAWN into the .pptx as real editable shapes from your labels -- so a ' +
          'process with four steps becomes four cards and three arrows, not a stock photograph. ' +
          'Use "scene" only for a genuine photograph brief. A slide whose right side decorates ' +
          'rather than teaches has wasted half its area.',
        sources: 'chunk_ids from this slide\'s allocation in the plan.',
      },
      the_deck_design: [
        'The deck has its own look and it is not the video\'s: warm cream page, deep green type, ' +
          'one green accent, hairline borders, generous space. It is applied automatically by ' +
          'render_module_pptx -- do not describe backgrounds, colours or fonts in slide content.',
        'Every slide shares that system. The composition is fixed: unit label, title under an ' +
          'accent rule, teaching cues left, visual right.',
        'Premium here means restraint. No gradients, no shadows, no second accent, no decorative ' +
          'icons, no paragraphs on a slide.',
      ],
      video_and_deck_are_complementary: [
        'They teach the same module and must agree on terminology, unit names and concepts.',
        'They must not be the same words. The video introduces, motivates and shows; the deck ' +
          'structures and teaches in depth. Do not paste narration into speaker notes.',
        'Where the video demonstrates a process as action, the deck shows it as a labelled ' +
          'diagram. Same knowledge, different form.',
      ],
      read_only: {
        'segment timings, count and word budgets': 'Fixed: 18 x 10 seconds.',
        'slide count and per-slide seconds': 'Fixed: 14 slides across 9 minutes.',
        'which unit each segment and slide covers': 'Allocated by the plan so every unit is covered.',
      },
      quality_standard: [
        'Write as an experienced professional scriptwriting team would: polished, specific, and ' +
          'ready to use without rewriting or interpretation.',
        'Concrete beats abstract. "Meera lifts a handful of damp straw and lets it fall" beats ' +
          '"a person working in a field".',
        'The protagonist drives the story. They should not merely appear in different places while ' +
          'a narrator explains things -- their actions are what move the film forward, and they ' +
          'should change from someone who notices a problem to someone ready to act.',
        'Plain language, short sentences, second person where it fits. A capable learner, not a ' +
          'specialist.',
        'The deck is not the video written down. The video motivates and orients; the deck teaches ' +
          'in depth.',
      ],
      what_validation_enforces: [
        'Every segment states continues_from, ends_with, character continuity, location continuity ' +
          'and object continuity, and every segment but the last says what the next one opens on.',
        'Consecutive segments must share something: a segment whose opening has nothing in common ' +
          'with the previous segment\'s ending is reported as a continuity break.',
        'The protagonist is named in every segment, and locations come from the story bible.',
        'At most 3 of 18 segments may be supporting graphics.',
        'The final segment must share an image with the first.',
        'Narration must fit ten seconds, and carries one idea.',
      ],
      grounding_rules: [
        'The Participant Handbook module is the source of truth. Every fact, figure, process step ' +
          'and definition must be supported by the allocated unit text.',
        'Narration, storytelling, examples, structure and visual direction are yours to author.',
        'Do not introduce statistics, standards, prices, dates, brands or regulations the units do ' +
          'not state.',
        'Between them the video and the deck must cover every unit of the module. Validation ' +
          'reports a unit that neither covers as an error.',
      ],
      never_mention_the_source: [
        'The viewer and the audience have no handbook. Nothing in narration, scene description, ' +
          'visual direction, on-screen text, slide titles, bullets or speaker notes may name the ' +
          'handbook or a page, figure, table, unit, module or qualification code.',
        'Citations belong in the sources arrays. Validation reports a reference in the content as ' +
          'an error.',
      ],
    }),
};

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

const storySchema = z.object({
  logline: z.string().describe('The whole 3-minute film in one sentence.'),
  protagonist: z.object({
    name: z.string().describe('A real name. The same person appears in all 18 segments.'),
    gender: z.string(),
    age_range: z.string().describe('e.g. "late 20s".'),
    role: z.string().describe('e.g. "smallholder farmer turning aggregator".'),
    appearance: z.string().describe('Face, build, hair -- restated to the generator every segment.'),
    clothing: z.string().describe('Exact and unchanging, unless the story needs a time change.'),
    footwear: z.string().optional(),
    personality: z.string(),
  }),
  locations: z
    .array(z.object({ name: z.string(), description: z.string() }))
    .describe('A small set of connected places, typically 3-6. The film should not wander.'),
  visual_style: z.object({
    palette: z.string(),
    lighting: z.string(),
    time_of_day: z.string(),
    weather: z.string(),
    season: z.string().optional(),
    camera_language: z.string().describe('Lens, movement and framing habits the whole film keeps.'),
  }),
  narrator: z.object({
    accent: z.string().describe('Indian English unless told otherwise.'),
    gender: z.string(),
    age_range: z.string(),
    tone: z.string(),
    pace: z.string(),
  }),
  opening_image: z.string().describe('The image the film opens on.'),
  closing_callback: z.string().describe('How segment 18 returns to that image and pays it off.'),
  acts: z.object({
    discovery: z.string().describe('Segments 1-4: the problem and the question.'),
    exploration: z.string().describe('Segments 5-12: understanding the opportunity, and the setbacks.'),
    action: z.string().describe('Segments 13-17: turning knowledge into action.'),
    payoff: z.string().describe('Segment 18: the return to the opening.'),
  }),
});

const setStoryTool: ToolDefinition = {
  name: 'set_module_story',
  title: 'Set the film\'s story bible',
  description:
    'Records the constants of the 3-minute film: the protagonist, the handful of locations, the ' +
    'light and camera language, the narrator, the three acts and the opening image the ending ' +
    'returns to. Write this BEFORE the segments. Each 10-second clip is generated separately and ' +
    'the generator remembers nothing between calls, so continuity exists only where it is written ' +
    'down -- and validation checks every segment against what you record here. Build the whole ' +
    'story first, then cut it into eighteen shots; do not write eighteen prompts and hope they ' +
    'join up.',
  inputSchema: {
    package_id: z.string(),
    base_version: z.number().int(),
    story: storySchema,
    replace_subject_character: z
      .boolean()
      .optional()
      .describe('Deliberately change the presenter this subject has already established.'),
    note: z.string().optional(),
  },
  handler: (args) => {
    const story = args.story as z.infer<typeof storySchema>;
    if (story.locations.length === 0) {
      return fail('A film needs at least one location. Name the places the story actually visits.');
    }
    const target = getModulePackage(String(args.package_id));
    const locked = getCharacterLock(target.course_id);
    if (
      locked &&
      locked.protagonist.name.toLowerCase() !== story.protagonist.name.toLowerCase() &&
      args.replace_subject_character !== true
    ) {
      return fail(
        `This subject's presenter is already ${locked.protagonist.name} (established by ` +
          `${locked.established_by}). A learner taking two modules of one subject should meet the ` +
          'same person, so reuse them -- or pass replace_subject_character: true if the change is ' +
          'deliberate and every earlier module will be re-shot.',
        { locked },
      );
    }

    const committed = commitModulePackage({
      package_id: String(args.package_id),
      base_version: Number(args.base_version),
      story,
      ...(args.note ? { note: String(args.note) } : {}),
    });
    setCharacterLock(
      target.course_id,
      story.protagonist,
      story.narrator,
      committed.package_id,
      args.replace_subject_character === true,
    );
    return ok({
      package_id: committed.package_id,
      version: committed.version,
      protagonist: story.protagonist.name,
      character_locked_for_subject: target.course_id,
      locations: story.locations.map((l) => l.name),
      next_call: { tool: 'submit_module_video', args: { package_id: committed.package_id } },
      next_step:
        'Now write the eighteen segments against the plan\'s beats with submit_module_video. Every ' +
        'segment must name ' +
        `${story.protagonist.name} in character_continuity and be set in one of: ` +
        `${story.locations.map((l) => l.name).join(', ')}.`,
    });
  },
};

const segmentSchema = z.object({
  segment_number: z.number().int().describe('1-18, matching the plan.'),
  story_purpose: z
    .string()
    .describe(
      'What this segment does for the film, in your own words. Part 1 orients to the module, ' +
        'Part 2 teaches its allocated unit, Part 3 consolidates.',
    ),
  continues_from: z
    .string()
    .describe(
      'The exact visual, action or state inherited from the previous segment\'s final moment. ' +
        'Segment 1 states the world it opens in.',
    ),
  narration: z.string().describe('Voice-over for these ten seconds; about 23 words, one idea.'),
  scene_description: z.string().describe('What happens on screen: who, where, what action.'),
  visual_direction: z.string().describe('Camera, movement, framing, light.'),
  character_continuity: z
    .string()
    .describe('The protagonist restated by name, with appearance and clothing, for this generation.'),
  location_continuity: z.string().describe('Which location from the story bible, and its state.'),
  object_continuity: z.string().describe('The object carried in from the last segment and out to the next.'),
  on_screen_text: z.string().optional(),
  ends_with: z.string().describe('The exact visual or action at the final moment of these ten seconds.'),
  next_segment_starts_with: z
    .string()
    .optional()
    .describe('What segment N+1 must open on. Required except on segment 18.'),
  transition: z
    .string()
    .optional()
    .describe('How the hand-over is motivated from inside the scene. Required except on segment 18.'),
  visual_mode: z
    .enum(['real_world', 'supporting_graphic'])
    .optional()
    .describe('Defaults to real_world. At most 3 of the 18 may be supporting_graphic.'),
  sources: z.array(sourceSchema),
});

const submitVideoTool: ToolDefinition = {
  name: 'submit_module_video',
  title: 'Submit the module video segments',
  description:
    'Writes the eighteen 10-second segments and commits a new version. Submit all eighteen ' +
    'together -- they are one film and are checked as one. The slide half of the package is left ' +
    'untouched. Word counts and citation metadata are filled in from the plan and the handbook ' +
    'index; you supply the words and the chunk_ids.',
  inputSchema: {
    package_id: z.string(),
    base_version: z.number().int(),
    title: z.string().optional(),
    segments: z.array(segmentSchema),
    note: z.string().optional(),
  },
  handler: (args) => {
    const state = getModulePackage(String(args.package_id));
    const incoming = args.segments as z.infer<typeof segmentSchema>[];
    const planned = new Map(state.plan.video.segments.map((s) => [s.segment_number, s]));

    const errors: string[] = [];
    if (!state.story) {
      errors.push(
        'This package has no story bible. Call set_module_story first: without it there is nothing ' +
          'fixing the protagonist, the locations or the narrator across eighteen separate ' +
          'generations, and the segments cannot be checked for continuity.',
      );
    }
    const seen = new Set<number>();
    for (const segment of incoming) {
      if (!planned.has(segment.segment_number)) {
        errors.push(
          `Segment ${segment.segment_number} is not in the plan, which has segments 1-` +
            `${state.plan.video.segment_count}.`,
        );
      }
      if (seen.has(segment.segment_number)) errors.push(`Segment ${segment.segment_number} was submitted twice.`);
      seen.add(segment.segment_number);
    }
    if (errors.length > 0) {
      return fail('Nothing was committed because part of the submission could not be applied.', errors);
    }

    const segments: VideoSegmentContent[] = incoming
      .map((segment) => {
        const plan = planned.get(segment.segment_number)!;
        return {
          segment_number: segment.segment_number,
          segment_id: plan.segment_id,
          role: plan.role,
          story_purpose: segment.story_purpose,
          continues_from: segment.continues_from,
          narration: segment.narration,
          scene_description: segment.scene_description,
          visual_direction: segment.visual_direction,
          character_continuity: segment.character_continuity,
          location_continuity: segment.location_continuity,
          object_continuity: segment.object_continuity,
          ...(segment.on_screen_text ? { on_screen_text: segment.on_screen_text } : {}),
          ends_with: segment.ends_with,
          ...(segment.next_segment_starts_with
            ? { next_segment_starts_with: segment.next_segment_starts_with }
            : {}),
          ...(segment.transition ? { transition: segment.transition } : {}),
          visual_mode: segment.visual_mode ?? 'real_world',
          word_count: countWords(segment.narration),
          sources: segment.sources.map((s) => toSourceRef(state.course_id, s.chunk_id, s.quote)),
        };
      })
      .sort((a, b) => a.segment_number - b.segment_number);

    const committed = commitModulePackage({
      package_id: String(args.package_id),
      base_version: Number(args.base_version),
      segments,
      ...(args.title ? { title: String(args.title) } : {}),
      ...(args.note ? { note: String(args.note) } : {}),
    });
    const report = validateModulePackage(committed);
    const video = halfReport(report, 'segments');

    return ok({
      package_id: committed.package_id,
      version: committed.version,
      segments_written: segments.length,
      of_planned: state.plan.video.segment_count,
      validation: { ...video, timing: report.video },
      next_call:
        video.errors === 0
          ? { tool: 'submit_module_slides', args: { package_id: state.package_id } }
          : { tool: 'submit_module_video', args: { package_id: state.package_id, base_version: committed.version } },
      next_step:
        video.errors === 0
          ? `Write the ${state.plan.slides.slide_count} slides with submit_module_slides. Do not ` +
            'stop here and do not show the user the script yet -- the deck is half the package.'
          : `Fix the findings above and resubmit the video against base_version ${committed.version}.`,
    });
  },
};

const visualSchema = z.object({
  type: z
    .enum([
      'process',
      'lifecycle',
      'comparison',
      'components',
      'workflow',
      'relationship',
      'cause_effect',
      'measurement',
      'scene',
      'none',
    ])
    .describe(
      'What kind of visual explains this slide. The labelled types (process, workflow, lifecycle, ' +
        'comparison, components, relationship, cause_effect, measurement) are DRAWN into the .pptx ' +
        'as real shapes from your labels. "scene" is a photograph or illustration brief; "none" ' +
        'only where a visual genuinely adds nothing.',
    ),
  description: z.string().describe('What the visual shows and what it teaches.'),
  labels: z
    .array(z.string())
    .describe(
      'The steps, parts or sides, in order, 2-6 of them, a few words each. These become the ' +
        'boxes of the drawn diagram, so they must read on their own.',
    ),
  avoid: z.string().optional().describe('What must not appear, when an image is generated.'),
});

const slideSchema = z.object({
  slide_number: z.number().int().describe('Matching the plan; the deck length is set by the plan.'),
  title: z.string().describe("The slide's point, not a label."),
  bullets: z.array(z.string()).describe('3-5 short on-screen cues, under about 12 words each.'),
  speaker_notes: z
    .string()
    .describe("What the presenter says while this slide is up: the slide's share of the nine minutes."),
  key_takeaway: z.string().optional().describe('One line the learner should leave the slide with.'),
  visual: visualSchema
    .optional()
    .describe('The right-hand teaching visual. Required on body slides; it may not be decoration.'),
  sources: z.array(sourceSchema),
});

const submitSlidesTool: ToolDefinition = {
  name: 'submit_module_slides',
  title: 'Submit the module slides',
  description:
    'Writes the fourteen slides and commits a new version. Submit all fourteen together -- the ' +
    'deck is checked as one for unit coverage. The video half of the package is left untouched. ' +
    'Slide copy must be written from the unit content, not copied out of it.',
  inputSchema: {
    package_id: z.string(),
    base_version: z.number().int(),
    title: z.string().optional(),
    slides: z.array(slideSchema),
    note: z.string().optional(),
  },
  handler: (args) => {
    const state = getModulePackage(String(args.package_id));
    const incoming = args.slides as z.infer<typeof slideSchema>[];
    const planned = new Map(state.plan.slides.slides.map((s) => [s.slide_number, s]));

    const errors: string[] = [];
    const seen = new Set<number>();
    for (const slide of incoming) {
      if (!planned.has(slide.slide_number)) {
        errors.push(
          `Slide ${slide.slide_number} is not in the plan, which has slides 1-${state.plan.slides.slide_count}.`,
        );
      }
      if (seen.has(slide.slide_number)) errors.push(`Slide ${slide.slide_number} was submitted twice.`);
      seen.add(slide.slide_number);
    }
    if (errors.length > 0) {
      return fail('Nothing was committed because part of the submission could not be applied.', errors);
    }

    const slides: SlideContent[] = incoming
      .map((slide) => {
        const plan = planned.get(slide.slide_number)!;
        return {
          slide_number: slide.slide_number,
          slide_id: plan.slide_id,
          role: plan.role,
          title: slide.title,
          bullets: slide.bullets,
          speaker_notes: slide.speaker_notes,
          ...(slide.key_takeaway ? { key_takeaway: slide.key_takeaway } : {}),
          ...(slide.visual ? { visual: slide.visual } : {}),
          notes_word_count: countWords(slide.speaker_notes),
          sources: slide.sources.map((s) => toSourceRef(state.course_id, s.chunk_id, s.quote)),
        };
      })
      .sort((a, b) => a.slide_number - b.slide_number);

    const committed = commitModulePackage({
      package_id: String(args.package_id),
      base_version: Number(args.base_version),
      slides,
      ...(args.title ? { title: String(args.title) } : {}),
      ...(args.note ? { note: String(args.note) } : {}),
    });
    const report = validateModulePackage(committed);
    const deck = halfReport(report, 'slides');

    return ok({
      package_id: committed.package_id,
      version: committed.version,
      slides_written: slides.length,
      of_planned: state.plan.slides.slide_count,
      validation: { ...deck, timing: report.slides },
      unit_coverage: report.unit_coverage,
      next_call:
        deck.errors === 0
          ? { tool: 'validate_module_package', args: { package_id: state.package_id } }
          : { tool: 'submit_module_slides', args: { package_id: state.package_id, base_version: committed.version } },
      next_step:
        deck.errors === 0
          ? 'Call validate_module_package, then export_module_package, and give the user every ' +
            'file it returns.'
          : `Fix the findings above and resubmit the deck against base_version ${committed.version}.`,
    });
  },
};

// ---------------------------------------------------------------------------
// Validation and output
// ---------------------------------------------------------------------------

const validateTool: ToolDefinition = {
  name: 'validate_module_package',
  title: 'Validate a module content package',
  description:
    'Checks the package mechanically: all 18 segments and 14 slides written, every segment\'s ' +
    'narration short enough to fit its ten seconds, notes within their budget, every unit of the ' +
    'module covered by both the video and the deck, every citation resolving to a chunk of this ' +
    'module, and no reference to the handbook, a page, a figure or a unit number in any delivered ' +
    'text. Whether the writing is good is your judgement, not this tool\'s.',
  inputSchema: { package_id: z.string(), version: z.number().int().optional() },
  handler: (args) =>
    ok(
      validateModulePackage(
        getModulePackage(
          String(args.package_id),
          args.version !== undefined ? Number(args.version) : undefined,
        ),
      ),
    ),
};

const videoScriptTool: ToolDefinition = {
  name: 'get_module_video_script',
  title: 'Get the module video script',
  description:
    'Returns the 3-minute script as eighteen self-contained 10-second segments in plain text, ' +
    'each ready to paste straight into the video generator: narration, scene, visual direction, ' +
    'on-screen text and the transition into the next segment. No page numbers or citations. Also ' +
    'writes the script to a .txt file and returns its path: ATTACH THAT FILE FOR THE USER TO ' +
    'DOWNLOAD alongside the text, since eighteen full segments are more than anyone wants to ' +
    'copy out of a chat window. Give the user the text as it stands.',
  inputSchema: { package_id: z.string(), version: z.number().int().optional() },
  handler: (args) => {
    const state = getModulePackage(
      String(args.package_id),
      args.version !== undefined ? Number(args.version) : undefined,
    );
    if (state.segments.length === 0) {
      return fail(
        `Package ${state.package_id} has no video segments yet. Write them from its plan and call ` +
          'submit_module_video first.',
      );
    }
    const report = validateModulePackage(state);
    const script = renderModuleVideoScript(state);
    const file = writeArtifactFile(
      state.package_id,
      moduleFilename(state.module_number, 'video-script', state.version, 'txt'),
      script,
      'video_script',
    );
    return text(script, {
      package_id: state.package_id,
      version: state.version,
      segments: state.segments.length,
      validation_passed: report.passed,
      errors: report.summary.errors,
      warnings: report.summary.warnings,
      file,
      handling:
        'Attach the file above so the user can download it, and give them the script text too. ' +
        'Copy one segment at a time into the video generator. Do not add sources to it.',
    });
  },
};

const slidesTextTool: ToolDefinition = {
  name: 'get_module_slides',
  title: 'Get the module slide deck as text',
  description:
    'Returns the 14 slides as plain text -- title, bullets, speaker notes -- for reading or ' +
    'copying. Call render_module_pptx for the .pptx file itself.',
  inputSchema: { package_id: z.string(), version: z.number().int().optional() },
  handler: (args) => {
    const state = getModulePackage(
      String(args.package_id),
      args.version !== undefined ? Number(args.version) : undefined,
    );
    if (state.slides.length === 0) {
      return fail(
        `Package ${state.package_id} has no slides yet. Write them from its plan and call ` +
          'submit_module_slides first.',
      );
    }
    const report = validateModulePackage(state);
    const deck = renderModuleDeck(state);
    const file = writeArtifactFile(
      state.package_id,
      moduleFilename(state.module_number, 'deck', state.version, 'txt'),
      deck,
      'deck_text',
    );
    return text(deck, {
      package_id: state.package_id,
      version: state.version,
      slides: state.slides.length,
      validation_passed: report.passed,
      errors: report.summary.errors,
      warnings: report.summary.warnings,
      file,
      handling: 'Attach the file for download. render_module_pptx gives the same deck as PowerPoint.',
    });
  },
};

const renderPptxTool: ToolDefinition = {
  name: 'render_module_pptx',
  title: 'Render the module deck to PowerPoint',
  description:
    'Writes the 14-slide deck to a .pptx file, with each slide\'s speaker notes attached as ' +
    'PowerPoint notes, and returns the path. Refuses by default if validation has errors; pass ' +
    'allow_invalid to render a draft anyway.',
  inputSchema: {
    package_id: z.string(),
    version: z.number().int().optional(),
    allow_invalid: z.boolean().optional(),
  },
  handler: async (args) => {
    const state = getModulePackage(
      String(args.package_id),
      args.version !== undefined ? Number(args.version) : undefined,
    );
    if (state.slides.length === 0) {
      return fail(`Package ${state.package_id} has no slides yet. Call submit_module_slides first.`);
    }

    const report = validateModulePackage(state);
    if (!report.passed && args.allow_invalid !== true) {
      return fail(
        `Validation found ${report.summary.errors} error(s), so the deck was not rendered. Fix the ` +
          'findings, or pass allow_invalid: true to render a draft deliberately.',
        report,
      );
    }

    const bytes = await renderPptx(toPptxDeck(state));
    const file = writeArtifactFile(
      state.package_id,
      moduleFilename(state.module_number, 'deck', state.version, 'pptx'),
      bytes,
      'deck_pptx',
    );

    return ok({
      package_id: state.package_id,
      version: state.version,
      pptx_path: file.path,
      file,
      bytes: file.bytes,
      slides: state.slides.length,
      validation_passed: report.passed,
      handling: 'Attach this file so the user can download the deck.',
      note:
        'Speaker notes are attached to each slide, so the 9 minutes of narration travels with the ' +
        'deck. Restyle in PowerPoint if a house template is required.',
    });
  },
};

const subtitlesTool: ToolDefinition = {
  name: 'get_module_subtitles',
  title: 'Get the video subtitles',
  description:
    'Builds the subtitle track from the segments\' narration as a progressive, word-by-word ' +
    'typewriter reveal, synced to each segment\'s ten seconds. Format "srt" (the default) is a ' +
    'SubRip file to burn in or load into an editor; "cues" returns the timings as data. Word ' +
    'timing is estimated from word length -- there is no audio to align against -- so treat it as ' +
    'a starting point an editor nudges, not a finished sync.',
  inputSchema: {
    package_id: z.string(),
    version: z.number().int().optional(),
    format: z.enum(['srt', 'cues']).optional(),
  },
  handler: (args) => {
    const state = getModulePackage(
      String(args.package_id),
      args.version !== undefined ? Number(args.version) : undefined,
    );
    if (state.segments.length === 0) {
      return fail(`Package ${state.package_id} has no segments yet, so there is nothing to subtitle.`);
    }

    const cues = state.plan.video.segments.flatMap((planned) => {
      const segment = state.segments.find((s) => s.segment_number === planned.segment_number);
      if (!segment) return [];
      return buildSubtitleCues(segment.narration, planned.start_seconds, planned.seconds);
    });

    if (args.format === 'cues') {
      return ok({ package_id: state.package_id, cue_count: cues.length, cues });
    }
    const srt = toSrt(cues);
    const file = writeArtifactFile(
      state.package_id,
      moduleFilename(state.module_number, 'subtitles', state.version, 'srt'),
      srt,
      'subtitles',
    );
    return text(srt, {
      package_id: state.package_id,
      version: state.version,
      cue_count: cues.length,
      reveal: 'progressive word-by-word (typewriter); each cue shows the line revealed so far',
      file,
      handling: 'Attach the .srt file for the user to download; an editor loads it directly.',
      note: 'Timing is estimated from word length. Nudge in the editor against the recorded voice-over.',
    });
  },
};

const exportTool: ToolDefinition = {
  name: 'export_module_package',
  title: 'Export the module package as files',
  description:
    'Writes every deliverable for a finished package and returns their paths: the video script as ' +
    '.txt, the subtitle track as .srt, the deck as .pptx and as .txt. Call this whenever a module ' +
    'has been generated, and ATTACH THE RETURNED FILES so the user can download them from the ' +
    'conversation rather than copying a long script out of it. Refuses by default if validation ' +
    'has errors; pass allow_invalid to export a draft anyway.',
  inputSchema: {
    package_id: z.string(),
    version: z.number().int().optional(),
    allow_invalid: z.boolean().optional(),
  },
  handler: async (args) => {
    const state = getModulePackage(
      String(args.package_id),
      args.version !== undefined ? Number(args.version) : undefined,
    );
    if (state.segments.length === 0 && state.slides.length === 0) {
      return fail(
        `Package ${state.package_id} has nothing written yet. Submit the segments and the slides ` +
          'first.',
      );
    }

    const report = validateModulePackage(state);
    if (!report.passed && args.allow_invalid !== true) {
      return fail(
        `Validation found ${report.summary.errors} error(s), so nothing was exported. Fix the ` +
          'findings, or pass allow_invalid: true to export a draft deliberately.',
        report,
      );
    }

    const files: WrittenFile[] = [];
    if (state.segments.length > 0) {
      files.push(
        writeArtifactFile(
          state.package_id,
          moduleFilename(state.module_number, 'video-script', state.version, 'txt'),
          renderModuleVideoScript(state),
          'video_script',
        ),
      );
      const cues = state.plan.video.segments.flatMap((planned) => {
        const segment = state.segments.find((x) => x.segment_number === planned.segment_number);
        return segment ? buildSubtitleCues(segment.narration, planned.start_seconds, planned.seconds) : [];
      });
      if (cues.length > 0) {
        files.push(
          writeArtifactFile(
            state.package_id,
            moduleFilename(state.module_number, 'subtitles', state.version, 'srt'),
            toSrt(cues),
            'subtitles',
          ),
        );
      }
    }
    if (state.slides.length > 0) {
      files.push(
        writeArtifactFile(
          state.package_id,
          moduleFilename(state.module_number, 'deck', state.version, 'txt'),
          renderModuleDeck(state),
          'deck_text',
        ),
        writeArtifactFile(
          state.package_id,
          moduleFilename(state.module_number, 'deck', state.version, 'pptx'),
          await renderPptx(toPptxDeck(state)),
          'deck_pptx',
        ),
      );
    }

    return ok({
      package_id: state.package_id,
      version: state.version,
      module: { number: state.module_number, title: state.module_title },
      files,
      validation_passed: report.passed,
      errors: report.summary.errors,
      warnings: report.summary.warnings,
      next_step:
        'Attach every file above to your reply so the user can download them, and say what each ' +
        'one is: the video script, the subtitle track, and the deck as PowerPoint and as text.',
    });
  },
};

const getPackageTool: ToolDefinition = {
  name: 'get_module_package',
  title: 'Get a module content package',
  description:
    'Returns the package state: the plan, the segments and the slides written so far, with their ' +
    'citations. Use get_module_video_script or get_module_slides for the deliverables themselves.',
  inputSchema: { package_id: z.string(), version: z.number().int().optional() },
  handler: (args) =>
    ok(
      getModulePackage(
        String(args.package_id),
        args.version !== undefined ? Number(args.version) : undefined,
      ),
    ),
};

const listPackagesTool: ToolDefinition = {
  name: 'list_module_packages',
  title: 'List module content packages',
  description: 'Lists module packages, newest first, optionally for one subject.',
  inputSchema: { subject: z.string().optional() },
  handler: (args) =>
    ok({
      packages: listModulePackages(
        args.subject ? resolveCourse(String(args.subject)).course_id : undefined,
      ),
    }),
};

const historyTool: ToolDefinition = {
  name: 'get_module_package_history',
  title: 'Get module package history',
  description: 'Returns a package\'s version list. Versions are append-only and can be read back.',
  inputSchema: { package_id: z.string() },
  handler: (args) => {
    const packageId = String(args.package_id);
    return ok({
      package: getModulePackage(packageId),
      versions: listModulePackageVersions(packageId),
    });
  },
};

const moduleOutlineTool: ToolDefinition = {
  name: 'get_module_units',
  title: 'Get the units behind a module',
  description:
    'Lists the units of one handbook module with their lengths. The user-facing flow stops at the ' +
    'module, so this is for your own orientation and for answering a question about what a module ' +
    'contains -- not a menu to put in front of the user.',
  inputSchema: { subject: z.string(), module_number: z.number().int() },
  handler: (args) => {
    const { course_id } = resolveCourse(String(args.subject));
    const outline = getPhOutline(course_id);
    const module = outline.modules.find((m) => m.module_number === Number(args.module_number));
    if (!module) {
      return fail(
        `This handbook has no module ${String(args.module_number)}. It has ` +
          `${outline.modules.map((m) => m.module_number).join(', ')}.`,
      );
    }
    return ok({ course_id, module });
  },
};

export const MODULE_TOOLS: ToolDefinition[] = [
  planTool,
  sourceTool,
  specTool,
  setStoryTool,
  submitVideoTool,
  submitSlidesTool,
  validateTool,
  videoScriptTool,
  subtitlesTool,
  slidesTextTool,
  exportTool,
  renderPptxTool,
  getPackageTool,
  listPackagesTool,
  historyTool,
  moduleOutlineTool,
];
