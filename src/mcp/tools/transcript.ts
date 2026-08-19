/**
 * Single-unit video transcript of a caller-chosen duration.
 *
 * This is not the module-content flow (see ./module.ts), which produces a fixed
 * 12-minute package for a whole module and is what the guided flow offers. These
 * tools stay available for the narrower request -- "a two-minute script on unit
 * 7.1" -- and are reached only when a user asks for exactly that.
 */

import { z } from 'zod';
import { findPhUnits, readPhUnit, UnitNotFoundError } from '../../documents/ph-outline.js';
import { getChunk } from '../../documents/retriever.js';
import type { SourceRef } from '../../types/source.js';
import type { TranscriptScene } from '../../types/video.js';
import { buildScenePlan, DEFAULT_WORDS_PER_MINUTE, timecode } from '../../video/scene-plan.js';
import { parseDuration } from '../../video/duration.js';
import { renderVideoScript } from '../../video/render.js';
import {
  commitTranscript,
  createTranscript,
  getTranscriptRecord,
  getTranscriptState,
  listTranscripts,
  listTranscriptVersions,
} from '../../video/transcript-store.js';
import { countWords, validateVideoTranscript } from '../../video/validator.js';
import { writeArtifactFile } from '../../storage/file-output.js';
import { resolveCourse } from './catalog.js';
import type { ToolDefinition } from './result.js';
import { fail, ok, textResult as text } from './result.js';
const planTool: ToolDefinition = {
  name: 'plan_video_transcript',
  title: 'Plan a video transcript',
  description:
    'Creates a video transcript draft for one Participant Handbook unit and returns its scene ' +
    'plan. The plan divides the requested duration into scenes, gives each scene a word budget ' +
    'at a stated speaking rate, and attaches to each scene the exact handbook text it must be ' +
    'built from and the chunk_ids it must cite. Accepts either subject + unit_code, or a heading ' +
    'to resolve -- which is the shortcut flow, where the user names a unit and skips the menus. ' +
    'The handbook is the source of truth: presentation, narration, examples and visual direction ' +
    'are yours to author, the educational content is not.',
  inputSchema: {
    subject: z.string().optional().describe('Subject id, code or course_id, e.g. "biofuels".'),
    unit_code: z.string().optional().describe('Unit code such as "7.1".'),
    heading: z.string().optional().describe('Unit heading, when the user named the unit rather than its code.'),
    duration: z
      .union([z.string(), z.number()])
      .describe('Requested length: "2 min", "90 seconds", "1:30", or a bare number meaning minutes.'),
    words_per_minute: z
      .number()
      .int()
      .min(60)
      .max(220)
      .optional()
      .describe(`Narration pace used to size every scene. Defaults to ${DEFAULT_WORDS_PER_MINUTE}.`),
    scene_count: z
      .number()
      .int()
      .min(3)
      .max(12)
      .optional()
      .describe('Overrides the derived scene count. Leave unset unless the user asked for a specific structure.'),
    title: z.string().optional().describe('Video title. Defaults to the unit title.'),
  },
  handler: (args) => {
    let courseId: string;
    let unitCode: string;

    if (args.unit_code && args.subject) {
      courseId = resolveCourse(String(args.subject)).course_id;
      unitCode = String(args.unit_code);
    } else if (args.heading) {
      const found = findPhUnits(String(args.heading), {
        ...(args.subject ? { courseId: resolveCourse(String(args.subject)).course_id } : {}),
      });
      if (found.candidates.length === 0) {
        return fail(found.message ?? `No unit matches "${String(args.heading)}".`, found);
      }
      if (!found.confident) {
        return fail(
          `"${String(args.heading)}" matches more than one unit closely. Ask the user which one ` +
            'they mean, then call plan_video_transcript with its subject and unit_code. ' +
            'Generating from the wrong unit would produce a correct-looking script about the ' +
            'wrong topic.',
          found,
        );
      }
      courseId = found.candidates[0]!.course_id;
      unitCode = found.candidates[0]!.unit.unit_code;
    } else {
      return fail('Give either subject + unit_code, or a heading to resolve.');
    }

    const seconds = parseDuration(args.duration as string | number);

    let reading;
    try {
      reading = readPhUnit(courseId, unitCode);
    } catch (err) {
      if (err instanceof UnitNotFoundError) return fail(err.message, { available_units: err.available });
      throw err;
    }

    const plan = buildScenePlan({
      reading,
      seconds,
      ...(args.words_per_minute ? { wordsPerMinute: Number(args.words_per_minute) } : {}),
      ...(args.scene_count ? { sceneCount: Number(args.scene_count) } : {}),
    });
    const transcript = createTranscript({
      plan,
      ...(args.title ? { title: String(args.title) } : {}),
    });

    return ok({
      transcript_id: transcript.transcript_id,
      base_version: transcript.version,
      title: transcript.title,
      plan,
      next_step:
        'Write one scene per planned scene, using only the source_text attached to that scene, ' +
        'and cite its source_chunk_ids. Then call submit_video_transcript with this ' +
        'transcript_id and base_version, and validate_video_transcript after that. ' +
        'get_video_transcript_spec describes each field.',
    });
  },
};

const specTool: ToolDefinition = {
  name: 'get_video_transcript_spec',
  title: 'Get video transcript field spec',
  description:
    'Describes what to write into each scene, what is fixed by the plan and may not be changed, ' +
    'and the grounding rules validation enforces. Read this before your first ' +
    'submit_video_transcript call.',
  inputSchema: {},
  handler: () =>
    ok({
      writable: {
        title: 'Video title. Short and concrete; defaults to the unit title if you do not set one.',
        'scenes[].title': 'Scene title, e.g. "Why feedstock choice decides your margin".',
        'scenes[].visual':
          'Camera, animation and on-screen action for this scene, e.g. "Slow push in on the ' +
          'pellet die; cut to an animated cross-section as the narrator names each part."',
        'scenes[].on_screen_text':
          'Text or graphics burned onto the screen. Optional. Write what the viewer should read, ' +
          'never a pointer to the handbook.',
        'scenes[].narration':
          'The spoken words, written to be read aloud in the scene\'s seconds at the plan\'s ' +
          'words-per-minute. This is the educational content and must be supported by the ' +
          'scene\'s cited handbook text.',
        'scenes[].sources':
          'Citations, using chunk_ids from this scene\'s source_chunk_ids in the plan.',
      },
      read_only: {
        'scenes[].scene_number / role / seconds / timecodes': 'Fixed by the scene plan.',
        'scenes[].target_words / min_words / max_words':
          'Derived from the scene\'s seconds and the plan\'s speaking rate.',
        'scenes[].source_text':
          'The handbook text allocated to this scene. Supplied to you; not something you set.',
        'scenes[].word_count': 'Counted from your narration when you submit.',
      },
      the_script_never_mentions_its_source: [
        'The viewer of the video has no handbook in front of them. Nothing in title, visual, ' +
          'on_screen_text or narration may refer to the Participant Handbook, a page number, a ' +
          'figure or table number, a unit or module number, a QR code or a qualification code.',
        'Write "a moisture meter reads water content as a percentage", not "as shown in Figure 53 ' +
          'on page 231". Say the content in the video\'s own terms.',
        'validate_video_transcript reports any such reference as an error, because the script is ' +
          'copied and used as it stands.',
        'Citations still belong in scenes[].sources. That is where traceability lives; the ' +
          'rendered script deliberately omits it.',
      ],
      grounding_rules: [
        'The Participant Handbook is the source of truth. Every fact, figure, definition, ' +
          'process step and claim in the narration must be supported by the unit text supplied ' +
          'in the plan.',
        'Presentation is yours: hooks, analogies, transitions, second-person address, visual ' +
          'direction and pacing are expected and are what make it a video rather than a reading.',
        'Do not introduce statistics, standards, prices, dates, brand names or regulations that ' +
          'the unit does not state, even when you are confident they are true.',
        'Cover the unit in its own order. Each scene has a contiguous slice of the unit; ' +
          'together the body scenes cover all of it.',
        'The recap scene introduces no new fact.',
        'Cite the chunk_ids the plan attached to that scene. Validation rejects a citation that ' +
          'does not resolve, that is not from the Participant Handbook, or that belongs to a ' +
          'different unit.',
      ],
      duration_rules: [
        'Write each scene to its word budget: that is how the finished video lands on the ' +
          'requested duration.',
        'validate_video_transcript reports the estimated read time and flags any scene outside ' +
          'its budget. Fix by editing narration length, not by changing the plan.',
      ],
      exact_reading_is_a_different_flow:
        'If the user asks what the unit actually says, call read_ph_unit and return its text ' +
        'unchanged. Never answer that question from a transcript.',
    }),
};

const sourceSchema = z.object({
  chunk_id: z.string(),
  quote: z.string().optional().describe('The span of handbook text that supports this scene.'),
});

const sceneSchema = z.object({
  scene_number: z.number().int().describe('Must match a scene_number in the plan.'),
  title: z.string(),
  visual: z.string(),
  on_screen_text: z.string().optional(),
  narration: z.string(),
  sources: z.array(sourceSchema).describe('chunk_ids from this scene\'s source_chunk_ids.'),
});

const submitTool: ToolDefinition = {
  name: 'submit_video_transcript',
  title: 'Submit video transcript scenes',
  description:
    'Writes the authored scenes into a transcript and commits a new version. Scenes replace the ' +
    'previous set wholesale, so submit the complete script each time; base_version is the ' +
    'version you read, and a stale one is refused rather than overwriting newer work. Word ' +
    'counts and citation metadata are filled in from the plan and the handbook index -- you ' +
    'supply the words and the chunk_ids only.',
  inputSchema: {
    transcript_id: z.string(),
    base_version: z.number().int(),
    title: z.string().optional(),
    scenes: z.array(sceneSchema),
    note: z.string().optional().describe('Recorded against this version.'),
  },
  handler: (args) => {
    const transcriptId = String(args.transcript_id);
    const state = getTranscriptState(transcriptId);
    const incoming = args.scenes as z.infer<typeof sceneSchema>[];

    const planned = new Map(state.plan.scenes.map((s) => [s.scene_number, s]));
    const errors: string[] = [];
    const seen = new Set<number>();

    for (const scene of incoming) {
      const plan = planned.get(scene.scene_number);
      if (!plan) {
        errors.push(
          `Scene ${scene.scene_number} is not in the plan, which has scenes ` +
            `${[...planned.keys()].join(', ')}.`,
        );
        continue;
      }
      if (seen.has(scene.scene_number)) {
        errors.push(`Scene ${scene.scene_number} was submitted twice.`);
      }
      seen.add(scene.scene_number);
    }
    if (errors.length > 0) {
      return fail('Nothing was committed because part of the submission could not be applied.', errors);
    }

    // The citation is rebuilt from the chunk index rather than trusted from the
    // client, so a scene's recorded page and section always describe the chunk it
    // actually cites.
    const scenes: TranscriptScene[] = incoming
      .map((scene) => {
        const plan = planned.get(scene.scene_number)!;
        return {
          scene_number: scene.scene_number,
          scene_id: plan.scene_id,
          role: plan.role,
          title: scene.title,
          visual: scene.visual,
          ...(scene.on_screen_text ? { on_screen_text: scene.on_screen_text } : {}),
          narration: scene.narration,
          word_count: countWords(scene.narration),
          sources: scene.sources.map((s) => toSourceRef(state.course_id, s.chunk_id, s.quote)),
        };
      })
      .sort((a, b) => a.scene_number - b.scene_number);

    const committed = commitTranscript({
      transcript_id: transcriptId,
      base_version: Number(args.base_version),
      scenes,
      ...(args.title ? { title: String(args.title) } : {}),
      ...(args.note ? { note: String(args.note) } : {}),
    });

    const report = validateVideoTranscript(committed);
    return ok({
      transcript_id: transcriptId,
      version: committed.version,
      scenes_written: scenes.length,
      of_planned: state.plan.scene_count,
      validation: { passed: report.passed, ...report.summary, duration: report.duration },
      next_step: report.passed
        ? 'Call get_video_transcript to get the finished script as plain text for the user to copy.'
        : 'Call validate_video_transcript for the findings, fix the scenes, and resubmit against ' +
          `base_version ${committed.version}.`,
    });
  },
};

/** Rebuilds a citation from the index, so page and section describe the real chunk. */
function toSourceRef(courseId: string, chunkId: string, quote?: string): SourceRef {
  const chunk = getChunk(courseId, chunkId);
  if (!chunk) {
    // An unresolvable citation is recorded as given and reported by validation,
    // rather than being silently dropped here.
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

const validateTool: ToolDefinition = {
  name: 'validate_video_transcript',
  title: 'Validate video transcript',
  description:
    'Checks a transcript mechanically: every planned scene written, each scene within its word ' +
    'budget, the whole script reading back in about the requested duration, and every citation ' +
    'resolving to a chunk of this unit of the Participant Handbook. Whether the narration is a ' +
    'fair rendering of the source is your judgement, not this tool\'s. Findings are reported and ' +
    'never auto-fixed.',
  inputSchema: { transcript_id: z.string(), version: z.number().int().optional() },
  handler: (args) => {
    const state = getTranscriptState(
      String(args.transcript_id),
      args.version !== undefined ? Number(args.version) : undefined,
    );
    return ok(validateVideoTranscript(state));
  },
};

const getTranscriptTool: ToolDefinition = {
  name: 'get_video_transcript',
  title: 'Get video transcript',
  description:
    'Returns the transcript. Format "script" (the default) is the finished scene-by-scene script ' +
    'as plain text, ready to copy straight into a teleprompter or editor: titles, timings, ' +
    'visuals and narration, with no page numbers, citations or word counts in it. Give the user ' +
    'this text as it is -- do not append sources to it. Format "production" adds the sourcing and ' +
    'budget annotations for a reviewer; "json" returns the structured state including the plan ' +
    'and every citation. This flow produces no file by design.',
  inputSchema: {
    transcript_id: z.string(),
    version: z.number().int().optional(),
    format: z.enum(['script', 'production', 'json']).optional(),
  },
  handler: (args) => {
    const state = getTranscriptState(
      String(args.transcript_id),
      args.version !== undefined ? Number(args.version) : undefined,
    );
    if (args.format === 'json') return ok(state);
    if (state.scenes.length === 0) {
      return fail(
        `Transcript ${state.transcript_id} has no scenes written yet. Write them from its plan ` +
          'and call submit_video_transcript first.',
        { plan: state.plan },
      );
    }
    const report = validateVideoTranscript(state);
    const script = renderVideoScript(state, args.format === 'production' ? 'production' : 'script');
    // Written as well as returned: a script is a deliverable, and a deliverable the
    // user can only reach by selecting it out of a chat window is half delivered.
    const file = writeArtifactFile(
      state.transcript_id,
      `unit-${state.unit_code}-script-v${state.version}.txt`,
      script,
      'transcript',
    );
    return text(script, {
      file,
      transcript_id: state.transcript_id,
      version: state.version,
      unit_code: state.unit_code,
      duration: report.duration,
      validation_passed: report.passed,
      errors: report.summary.errors,
      warnings: report.summary.warnings,
      handling:
        'Attach the file above so the user can download it, and give them the script text too. It ' +
        'is ready to use exactly as it stands: do not add a source list, page references or a ' +
        'summary to it.',
    });
  },
};

const listTranscriptsTool: ToolDefinition = {
  name: 'list_video_transcripts',
  title: 'List video transcripts',
  description: 'Lists video transcripts, newest first, optionally for one subject.',
  inputSchema: { subject: z.string().optional() },
  handler: (args) => {
    const courseId = args.subject ? resolveCourse(String(args.subject)).course_id : undefined;
    return ok({ transcripts: listTranscripts(courseId) });
  },
};

const historyTool: ToolDefinition = {
  name: 'get_video_transcript_history',
  title: 'Get video transcript history',
  description:
    'Returns a transcript\'s version list. Versions are append-only, so an earlier draft can ' +
    'always be read back with get_video_transcript and a version number.',
  inputSchema: { transcript_id: z.string() },
  handler: (args) => {
    const transcriptId = String(args.transcript_id);
    return ok({
      transcript: getTranscriptRecord(transcriptId),
      versions: listTranscriptVersions(transcriptId),
    });
  },
};

const unitSourceTool: ToolDefinition = {
  name: 'get_ph_unit_source',
  title: 'Get a unit\'s source text for generation',
  description:
    'Returns a unit\'s handbook text split into the citable blocks the scene plan allocates ' +
    'from, with each block\'s chunk_id and page. Use it while writing when you want more of the ' +
    'unit than one scene\'s allocation, or to check which chunk_id covers a passage. For showing ' +
    'the user what the unit says, use read_ph_unit instead -- that one is the reading flow and ' +
    'carries its handling rules.',
  inputSchema: { subject: z.string(), unit_code: z.string() },
  handler: (args) => {
    const { course_id } = resolveCourse(String(args.subject));
    try {
      const reading = readPhUnit(course_id, String(args.unit_code));
      return ok({
        course_id: reading.course_id,
        unit: reading.unit,
        word_count: reading.word_count,
        blocks: reading.blocks,
        chunk_ids: reading.chunk_ids,
        estimated_read_time: timecode(
          Math.round((reading.word_count / DEFAULT_WORDS_PER_MINUTE) * 60),
        ),
      });
    } catch (err) {
      if (err instanceof UnitNotFoundError) return fail(err.message, { available_units: err.available });
      throw err;
    }
  },
};

export const TRANSCRIPT_TOOLS: ToolDefinition[] = [
  planTool,
  specTool,
  submitTool,
  validateTool,
  getTranscriptTool,
  listTranscriptsTool,
  historyTool,
  unitSourceTool,
];
