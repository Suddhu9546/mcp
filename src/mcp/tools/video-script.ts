/**
 * The video script tools: a 60-90 second info video for one handbook module.
 *
 * Six tools, and a finished script is two calls:
 *
 *   plan_video_script     the scenes, their budgets, their handbook text, the
 *                         locked presenter and the rules -- all of it, at once
 *   submit_video_script   validates, composes the generation prompts, writes the
 *                         file, returns the finished script
 *
 * The two-call shape is deliberate and is the main thing separating this feature
 * from the one it replaces. Every round trip re-sends the tool list and the whole
 * conversation, so a flow that fetches the spec, then the source, then submits, then
 * validates, then renders, then exports costs six times what it needs to for a
 * ninety-second video. Everything the writer needs travels with the plan, and
 * everything the server does with the result happens in the submit.
 *
 * The remaining four are for reading state and for the profile, which the guided
 * flow sets but a client driving directly may want to set itself.
 */

import { z } from 'zod';
import { getSubject, subjectStatus } from '../../catalog/subject-catalog.js';
import { ingestCourse } from '../../documents/ingest.js';
import { UnitNotFoundError } from '../../documents/ph-outline.js';
import {
  ATTIRES,
  AGE_RANGES,
  DEMOGRAPHICS,
  ENVIRONMENTS,
  GENDERS,
  SKIN_TONES,
  type AuthoredScene,
  type FinalScene,
  type VideoProfile,
} from '../../types/video-script.js';
import {
  attireChoices,
  describeProfile,
  getSavedProfile,
  saveProfile,
  AGE_CHOICES,
  DEMOGRAPHIC_CHOICES,
  ENVIRONMENT_CHOICES,
  GENDER_CHOICES,
  SKIN_TONE_CHOICES,
} from '../../videoscript/profile.js';
import { buildVideoScriptPlan, countWords } from '../../videoscript/scene-plan.js';
import { composeScenePrompt } from '../../videoscript/prompt.js';
import { VIDEO_SCRIPT_SPEC } from '../../videoscript/spec.js';
import { validateVideoScript } from '../../videoscript/validator.js';
import { renderVideoScript, writeVideoScriptFile } from '../../videoscript/render.js';
import {
  commitScenes,
  getVideoScript,
  listVideoScriptVersions,
  listVideoScripts,
  openVideoScript,
} from '../../videoscript/store.js';
import type { ToolDefinition } from './result.js';
import { fail, ok } from './result.js';

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

/** The six questions, as data, so a direct caller can render them itself. */
function profileQuestions() {
  const list = <T extends string>(cs: { value: T; label: string }[]) =>
    cs.map((c, i) => ({ number: i + 1, value: c.value, label: c.label }));
  return {
    gender: { question: "What should be the presenter's gender?", options: list(GENDER_CHOICES) },
    age: { question: "What is the presenter's age group?", options: list(AGE_CHOICES) },
    skin_tone: { question: "What should be the presenter's skin tone?", options: list(SKIN_TONE_CHOICES) },
    demographic: {
      question: "What should be the presenter's demographic appearance?",
      options: list(DEMOGRAPHIC_CHOICES),
    },
    attire: {
      question: "What should be the presenter's attire?",
      note: 'The list depends on the gender chosen.',
      male_options: list(attireChoices('male')),
      female_options: list(attireChoices('female')),
    },
    environment: {
      question: 'Which environment should the video be set in?',
      options: list(ENVIRONMENT_CHOICES),
    },
  };
}

const getProfileTool: ToolDefinition = {
  name: 'get_video_profile',
  title: 'Get the saved video profile',
  description:
    'Returns the saved presenter and environment, if one has been set. The profile is what the ' +
    'presenter looks like, wears and sounds like, and where the video is set -- presentation ' +
    'only, never what is taught. When none is saved this returns the six questions to ask, so ' +
    'nothing has to be hardcoded on the client. The guided flow asks these itself; call this ' +
    'only when driving the tools directly.',
  inputSchema: {},
  handler: () => {
    const profile = getSavedProfile();
    if (!profile) {
      return ok({
        saved: false,
        questions: profileQuestions(),
        next_call: {
          tool: 'set_video_profile',
          why: 'Save the answers, then plan_video_script.',
        },
      });
    }
    return ok({ saved: true, profile, described: describeProfile(profile) });
  },
};

const setProfileTool: ToolDefinition = {
  name: 'set_video_profile',
  title: 'Save the video profile',
  description:
    'Saves the presenter and the environment, replacing any previous profile. Every later video ' +
    'reuses it, so the same instructor appears across a course. Presentation only: nothing here ' +
    'affects what the video teaches.',
  inputSchema: {
    gender: z.enum(GENDERS),
    age_range: z.enum(AGE_RANGES),
    skin_tone: z.enum(SKIN_TONES),
    demographic: z.enum(DEMOGRAPHICS),
    attire: z.enum(ATTIRES).describe('Must be one of the options offered for the chosen gender.'),
    environment: z.enum(ENVIRONMENTS),
  },
  handler: (args) => {
    const gender = args.gender as (typeof GENDERS)[number];
    const attire = args.attire as (typeof ATTIRES)[number];
    const allowed = attireChoices(gender).map((c) => c.value);
    if (!allowed.includes(attire)) {
      return fail(
        `"${attire}" is not an attire option for a ${gender} presenter. Choose one of ` +
          `${allowed.join(', ')}.`,
      );
    }
    const profile = saveProfile({
      gender,
      age_range: args.age_range as VideoProfile['age_range'],
      skin_tone: args.skin_tone as VideoProfile['skin_tone'],
      demographic: args.demographic as VideoProfile['demographic'],
      attire,
      environment: args.environment as VideoProfile['environment'],
    });
    return ok({
      saved: true,
      profile,
      described: describeProfile(profile),
      next_call: { tool: 'plan_video_script', why: 'The profile is set; plan the module.' },
    });
  },
};

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const planTool: ToolDefinition = {
  name: 'plan_video_script',
  title: 'Plan the info video for a module',
  description:
    'Plans a 60-90 second AI info video for one Participant Handbook module and returns ' +
    'everything needed to write it in a single call: the six or seven scenes with their seconds, ' +
    'timecodes and word bands, what each scene must achieve, the handbook text behind it, the ' +
    'locked presenter and environment, and the writing rules. Nothing further needs fetching -- ' +
    'write all the scenes and call submit_video_script. The scene count, durations and unit ' +
    'allocation are computed and are not open to change; the words, visuals and camera are yours ' +
    'to write. Requires a saved video profile, or one passed inline.',
  inputSchema: {
    subject: z
      .string()
      .describe('Subject id, code or role title, e.g. "biofuels" or "Bio-Energy Micro Entrepreneur".'),
    module_number: z.number().int().describe("The Participant Handbook's own module number."),
    profile: z
      .object({
        gender: z.enum(GENDERS),
        age_range: z.enum(AGE_RANGES),
        skin_tone: z.enum(SKIN_TONES),
        demographic: z.enum(DEMOGRAPHICS),
        attire: z.enum(ATTIRES),
        environment: z.enum(ENVIRONMENTS),
      })
      .optional()
      .describe('Use and save these instead of the stored profile.'),
  },
  handler: async (args) => {
    let subject;
    try {
      subject = getSubject(String(args.subject));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    // A handbook on disk but never read is indexed here rather than handed back
    // to the user as a chore. Only a missing handbook is a real blocker.
    const status = subjectStatus(subject);
    if (!status.selectable) return fail(`${status.code} is not available. ${status.blocker}`);
    if (status.needs_index) await ingestCourse(subject.course_id);

    const supplied = args.profile as Omit<VideoProfile, 'created_at' | 'updated_at'> | undefined;
    if (supplied) {
      const allowed = attireChoices(supplied.gender).map((c) => c.value);
      if (!allowed.includes(supplied.attire)) {
        return fail(
          `"${supplied.attire}" is not an attire option for a ${supplied.gender} presenter. ` +
            `Choose one of ${allowed.join(', ')}.`,
        );
      }
    }
    const profile = supplied ? saveProfile(supplied) : getSavedProfile();
    if (!profile) {
      return fail(
        'No video profile is saved, so there is nothing to say about the presenter. Ask the six ' +
          'configuration questions and call set_video_profile, or pass `profile` here.',
        { questions: profileQuestions() },
      );
    }

    try {
      const plan = buildVideoScriptPlan({
        subject,
        moduleNumber: Number(args.module_number),
        profile,
      });
      const state = openVideoScript(plan);
      return ok({
        script_id: state.script_id,
        base_version: state.version,
        already_written: state.scenes.length > 0 ? state.scenes.length : undefined,
        plan,
        spec: VIDEO_SCRIPT_SPEC,
        next_call: {
          tool: 'submit_video_script',
          arguments: { script_id: state.script_id, scenes: `all ${plan.scene_count} scenes` },
          why:
            'Everything needed is in this result. Write every scene and submit them together; ' +
            'that call validates, builds the generation prompts and writes the file.',
        },
      });
    } catch (err) {
      if (err instanceof UnitNotFoundError) return fail(err.message);
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

const sceneSchema = z.object({
  scene_number: z.number().int().min(1),
  educational_purpose: z.string().describe('What this scene does for the learner.'),
  location: z.string().describe('Where it happens, inside the chosen environment.'),
  visual_description: z.string().describe('What is on screen.'),
  character_action: z.string().describe('What the presenter does. Teaching action only.'),
  camera_framing: z.string().describe('e.g. "medium shot, presenter centre-left, chest up".'),
  camera_movement: z.string().describe('e.g. "locked off", "slow push in".'),
  educational_visual_elements: z
    .array(z.string())
    .default([])
    .describe('The diagram, equipment, formula or reading shown to explain the point.'),
  continuity: z.string().optional().describe('What carries over from the previous scene.'),
  narration: z.string().describe('The voiceover, word for word, inside the scene word band.'),
  on_screen_text: z.string().optional().describe('Short burned-on text, where it reinforces.'),
  sources: z.array(z.string()).default([]).describe("chunk_ids from this scene's allocation."),
});

const submitTool: ToolDefinition = {
  name: 'submit_video_script',
  title: 'Submit, validate and produce the video script',
  description:
    'Takes all the scenes at once and does everything remaining in one call: validates them ' +
    'against the plan, composes each scene\'s AI video-generation prompt from the authored ' +
    'fields plus the locked presenter, pace and audio-accuracy blocks, commits a version, ' +
    'renders the script and writes it to a file. Returns the finished script and the path. If ' +
    'validation finds errors nothing is committed and the findings come back scene by scene; fix ' +
    'those scenes and submit again. Do not write the presenter\'s appearance, clothing, voice or ' +
    'the audio directives into any field -- they are added here identically for every scene, ' +
    'which is what keeps the presenter the same person throughout.',
  inputSchema: {
    script_id: z.string().describe('From plan_video_script.'),
    scenes: z.array(sceneSchema).describe('Every scene in the plan, in order.'),
    note: z.string().optional().describe('What changed, for the version log.'),
  },
  handler: (args) => {
    const scriptId = String(args.script_id);
    let state;
    try {
      state = getVideoScript(scriptId);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    // Re-plan rather than trusting the stored plan: the handbook may have been
    // re-ingested and the profile may have changed since the plan was handed out,
    // and validating against a stale plan would pass a script that no longer fits.
    const profile = getSavedProfile();
    if (!profile) {
      return fail(
        'The video profile has been cleared since this script was planned. Call ' +
          'set_video_profile, then plan_video_script again.',
      );
    }
    let plan;
    try {
      plan = buildVideoScriptPlan({
        subject: getSubject(state.subject_id),
        moduleNumber: state.module_number,
        profile,
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    const authored = args.scenes as AuthoredScene[];
    const validation = validateVideoScript({
      scriptId,
      version: state.version + 1,
      plan,
      scenes: authored,
    });

    if (!validation.passed) {
      return ok({
        script_id: scriptId,
        committed: false,
        validation,
        next_call: {
          tool: 'submit_video_script',
          why:
            `${validation.error_count} error${validation.error_count === 1 ? '' : 's'} must be ` +
            'fixed. Nothing was saved. Correct the scenes named in the findings and submit the ' +
            'full set again.',
        },
      });
    }

    const byNumber = new Map(authored.map((s) => [s.scene_number, s]));
    const finals: FinalScene[] = plan.scenes.map((planned) => {
      const scene = byNumber.get(planned.scene_number)!;
      const previous = byNumber.get(planned.scene_number - 1);
      return {
        ...scene,
        educational_visual_elements: scene.educational_visual_elements ?? [],
        sources: scene.sources ?? [],
        scene_id: planned.scene_id,
        role: planned.role,
        seconds: planned.seconds,
        start_timecode: planned.start_timecode,
        end_timecode: planned.end_timecode,
        narration_word_count: countWords(scene.narration),
        ai_video_prompt: composeScenePrompt({
          planned,
          authored: scene,
          character: plan.character,
          environment: plan.environment,
          ...(previous ? { previousScene: previous } : {}),
        }),
      };
    });

    const committed = commitScenes(
      scriptId,
      plan,
      finals,
      args.note ? String(args.note) : `${finals.length} scenes`,
    );
    const body = renderVideoScript(committed);
    const file = writeVideoScriptFile(committed, body);

    return ok({
      script_id: scriptId,
      committed: true,
      version: committed.version,
      validation,
      total_seconds: plan.total_seconds,
      spoken_words: finals.reduce((a, s) => a + s.narration_word_count, 0),
      scenes: finals,
      file,
      script_text: body,
      next_action:
        'The script is finished and saved. Give the user the file and the scene prompts -- each ' +
        'ai_video_prompt is one generation. For another module, say "restart" on the flow session.',
    });
  },
};

// ---------------------------------------------------------------------------
// Reading state back
// ---------------------------------------------------------------------------

const getScriptTool: ToolDefinition = {
  name: 'get_video_script',
  title: 'Get a video script',
  description:
    'Returns a saved video script: its plan, its scenes with their generation prompts, and the ' +
    'rendered text. Pass a version to read an earlier one.',
  inputSchema: {
    script_id: z.string(),
    version: z.number().int().optional(),
    format: z
      .enum(['json', 'text'])
      .optional()
      .describe('"text" returns only the rendered script. Defaults to json.'),
  },
  handler: (args) => {
    try {
      const state = getVideoScript(
        String(args.script_id),
        args.version === undefined ? undefined : Number(args.version),
      );
      const body = renderVideoScript(state);
      if (args.format === 'text') return ok({ script_id: state.script_id, version: state.version, script_text: body });
      return ok({ ...state, script_text: body });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

const listScriptsTool: ToolDefinition = {
  name: 'list_video_scripts',
  title: 'List video scripts',
  description: 'Every video script written so far, newest first, with how many scenes each holds.',
  inputSchema: { subject: z.string().optional().describe('Restrict to one subject.') },
  handler: (args) => {
    const courseId = args.subject ? getSubject(String(args.subject)).course_id : undefined;
    return ok({ scripts: listVideoScripts(courseId) });
  },
};

const historyTool: ToolDefinition = {
  name: 'get_video_script_history',
  title: 'Get a video script\'s versions',
  description: 'The versions of one script, in order, with the note recorded for each.',
  inputSchema: { script_id: z.string() },
  handler: (args) => {
    const scriptId = String(args.script_id);
    try {
      getVideoScript(scriptId);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    return ok({ script_id: scriptId, versions: listVideoScriptVersions(scriptId) });
  },
};

export const VIDEO_SCRIPT_TOOLS: ToolDefinition[] = [
  getProfileTool,
  setProfileTool,
  planTool,
  submitTool,
  getScriptTool,
  listScriptsTool,
  historyTool,
];
