/**
 * Validation of a submitted video script.
 *
 * The brief's final checklist mixes two kinds of item. Some are mechanical -- does
 * the narration fit the seconds, is every scene present, does a scene cite a chunk
 * that exists in this module, does the text name a page number. Those are checked
 * here, and a failure is an error rather than advice, because none of them is a
 * matter of taste and all of them make the video unusable.
 *
 * The rest -- is the writing good, is the example well chosen, does the visual
 * really explain the idea -- are judgements, and this server holds no model. They
 * stay with the client, and are not pretended at with a heuristic that would pass
 * bad writing and fail good writing at about the same rate.
 *
 * Two of the checklist's items are guaranteed rather than checked, because the
 * server produces them: the presenter is identical in every scene, and the
 * pace and audio-accuracy directives are present in every prompt, since all three
 * are stamped in by the composer from one source. They are reported as passed with
 * that stated, so a reader of the report knows they were not skipped.
 */

import { getChunk } from '../documents/retriever.js';
import { countWords } from './scene-plan.js';
import {
  MAX_SCENE_COUNT,
  MAX_TOTAL_SECONDS,
  MIN_SCENE_COUNT,
  MIN_TOTAL_SECONDS,
  type AuthoredScene,
  type VideoScriptFinding,
  type VideoScriptPlan,
  type VideoScriptValidation,
} from '../types/video-script.js';

/**
 * Words that reveal the handbook to a viewer who does not have one.
 *
 * "Module" and "unit" are the common ones and are caught with a number after them
 * -- "in this module" is natural speech and fine, "in unit 3.2" is a leak.
 */
const SOURCE_LEAK_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /\bparticipant handbook\b/i, what: 'the handbook by name' },
  { pattern: /\bhandbook\b/i, what: 'the handbook' },
  { pattern: /\b(?:page|pp?\.)\s*\d+/i, what: 'a page number' },
  { pattern: /\b(?:figure|fig\.|table|annexure|appendix)\s*\d/i, what: 'a figure or table number' },
  { pattern: /\bunit\s*\d/i, what: 'a unit number' },
  { pattern: /\bmodule\s*\d/i, what: 'a module number' },
  { pattern: /\bchapter\s*\d/i, what: 'a chapter number' },
  { pattern: /\bqr\s*code\b/i, what: 'a QR code' },
  { pattern: /\b[A-Z]{3}\/N\d{4}\b/, what: 'a qualification code' },
  { pattern: /\bNOS\b/, what: 'a qualification code' },
];

/** Fields a viewer sees or hears. A leak in any of them is a leak. */
function viewerFacing(scene: AuthoredScene): { field: string; text: string }[] {
  return [
    { field: 'narration', text: scene.narration },
    { field: 'on_screen_text', text: scene.on_screen_text ?? '' },
    { field: 'visual_description', text: scene.visual_description },
    { field: 'educational_visual_elements', text: scene.educational_visual_elements.join(' ') },
    { field: 'location', text: scene.location },
    { field: 'character_action', text: scene.character_action },
  ];
}

/** "the the", "is is" -- what a duplicated word looks like in a written line. */
function repeatedWord(text: string): string | undefined {
  const match = /\b([\p{L}']+)\s+\1\b/iu.exec(text);
  return match?.[1];
}

const GREETING = /\bnamast[eay]/i;

export interface ValidateOptions {
  scriptId: string;
  version: number;
  plan: VideoScriptPlan;
  scenes: AuthoredScene[];
}

export function validateVideoScript(options: ValidateOptions): VideoScriptValidation {
  const { scriptId, version, plan, scenes } = options;
  const findings: VideoScriptFinding[] = [];
  const checks: { name: string; passed: boolean; detail: string }[] = [];

  const record = (name: string, passed: boolean, detail: string) => {
    checks.push({ name, passed, detail });
  };
  const error = (check: string, message: string, sceneNumber?: number, fix?: string) => {
    findings.push({
      severity: 'error',
      check,
      ...(sceneNumber !== undefined ? { scene_number: sceneNumber } : {}),
      message,
      ...(fix ? { fix } : {}),
    });
  };
  const warn = (check: string, message: string, sceneNumber?: number, fix?: string) => {
    findings.push({
      severity: 'warning',
      check,
      ...(sceneNumber !== undefined ? { scene_number: sceneNumber } : {}),
      message,
      ...(fix ? { fix } : {}),
    });
  };

  // --- every planned scene is present, exactly once -----------------------

  const byNumber = new Map<number, AuthoredScene>();
  for (const scene of scenes) {
    if (byNumber.has(scene.scene_number)) {
      error('scene_set', `Scene ${scene.scene_number} was submitted more than once.`);
      continue;
    }
    byNumber.set(scene.scene_number, scene);
  }
  const missing = plan.scenes.filter((p) => !byNumber.has(p.scene_number)).map((p) => p.scene_number);
  const extra = [...byNumber.keys()].filter(
    (n) => !plan.scenes.some((p) => p.scene_number === n),
  );
  if (missing.length > 0) {
    error(
      'scene_set',
      `Missing scene${missing.length === 1 ? '' : 's'} ${missing.join(', ')}. The plan has ` +
        `${plan.scene_count}; all of them must be submitted together.`,
    );
  }
  if (extra.length > 0) {
    error('scene_set', `Scene${extra.length === 1 ? '' : 's'} ${extra.join(', ')} are not in the plan.`);
  }
  record(
    'scene_set',
    missing.length === 0 && extra.length === 0 && scenes.length === plan.scene_count,
    `${scenes.length} of ${plan.scene_count} scenes submitted.`,
  );

  // --- structure: count and total duration --------------------------------

  const inRange =
    plan.scene_count >= MIN_SCENE_COUNT &&
    plan.scene_count <= MAX_SCENE_COUNT &&
    plan.total_seconds >= MIN_TOTAL_SECONDS &&
    plan.total_seconds <= MAX_TOTAL_SECONDS;
  if (!inRange) {
    error(
      'structure',
      `The plan is ${plan.scene_count} scenes of ${plan.total_seconds}s, outside the required ` +
        `${MIN_SCENE_COUNT}-${MAX_SCENE_COUNT} scenes and ${MIN_TOTAL_SECONDS}-${MAX_TOTAL_SECONDS}s.`,
    );
  }
  record(
    'structure',
    inRange,
    `${plan.scene_count} scenes, ${plan.total_seconds}s total (${MIN_TOTAL_SECONDS}-${MAX_TOTAL_SECONDS}s required).`,
  );

  // --- per-scene checks ---------------------------------------------------

  let fitFailures = 0;
  let emptyFields = 0;
  let leaks = 0;
  let badCitations = 0;
  let repeats = 0;

  for (const planned of plan.scenes) {
    const scene = byNumber.get(planned.scene_number);
    if (!scene) continue;
    const n = planned.scene_number;

    // Required fields. An empty one produces an unusable prompt, so it is an
    // error rather than a nudge.
    const required: [string, string][] = [
      ['educational_purpose', scene.educational_purpose],
      ['location', scene.location],
      ['visual_description', scene.visual_description],
      ['character_action', scene.character_action],
      ['camera_framing', scene.camera_framing],
      ['camera_movement', scene.camera_movement],
      ['narration', scene.narration],
    ];
    for (const [field, value] of required) {
      if (!value || value.trim().length === 0) {
        emptyFields += 1;
        error('required_fields', `Scene ${n} has no ${field}.`, n);
      }
    }

    // Narration fit. The hard one: a scene over its band is cut off mid-word.
    const words = countWords(scene.narration ?? '');
    if (words > planned.max_words) {
      fitFailures += 1;
      error(
        'narration_fit',
        `Scene ${n} narration is ${words} words for ${planned.seconds}s; the maximum that fits ` +
          `is ${planned.max_words}.`,
        n,
        `Cut to about ${planned.target_words} words. The generator truncates the overrun.`,
      );
    } else if (words < planned.min_words) {
      fitFailures += 1;
      error(
        'narration_fit',
        `Scene ${n} narration is ${words} words for ${planned.seconds}s; at least ` +
          `${planned.min_words} are needed or the scene runs on in silence.`,
        n,
        `Aim for about ${planned.target_words} words.`,
      );
    }

    // The greeting, on scene 1 only.
    if (planned.role === 'opening' && !GREETING.test(scene.narration ?? '')) {
      error(
        'opening_greeting',
        `Scene ${n} is the opening and must begin with a natural spoken "Namastey".`,
        n,
      );
    }

    // Duplicated words, which is what a stuttering generation sounds like and
    // what a written duplication guarantees.
    const dup = repeatedWord(scene.narration ?? '');
    if (dup) {
      repeats += 1;
      error(
        'audio_accuracy',
        `Scene ${n} narration repeats the word "${dup}" back to back, which will be spoken twice.`,
        n,
      );
    }

    // Source leaks.
    for (const { field, text } of viewerFacing(scene)) {
      if (!text) continue;
      for (const { pattern, what } of SOURCE_LEAK_PATTERNS) {
        if (pattern.test(text)) {
          leaks += 1;
          error(
            'no_source_leak',
            `Scene ${n} ${field} names ${what}. The viewer has no handbook in front of them.`,
            n,
            'Say the thing itself instead, and keep the citation in `sources`.',
          );
          break;
        }
      }
    }

    // Citations. A teaching scene must cite; a framing scene need not, since it
    // speaks about the module rather than from a passage of it.
    const teaching = planned.role === 'roadmap';
    if (teaching && scene.sources.length === 0) {
      badCitations += 1;
      error(
        'grounding',
        `Scene ${n} introduces ${planned.units.map((u) => u.unit_title).join(', ')} and cites ` +
          'nothing. Cite the chunk_ids it was written from.',
        n,
      );
    }
    for (const chunkId of scene.sources) {
      const chunk = getChunk(plan.course_id, chunkId);
      if (!chunk) {
        badCitations += 1;
        error(
          'grounding',
          `Scene ${n} cites "${chunkId}", which is not a chunk of the ${plan.subject_label} ` +
            'handbook.',
          n,
        );
        continue;
      }
      if (planned.citable_chunk_ids.length > 0 && !planned.citable_chunk_ids.includes(chunkId)) {
        badCitations += 1;
        error(
          'grounding',
          `Scene ${n} cites "${chunkId}", which is not part of the text allocated to it. Cite ` +
            'only from this scene\'s own allocation.',
          n,
        );
      }
    }

    // A teaching scene with no visual element is a talking head explaining
    // something that could have been shown.
    if (teaching && scene.educational_visual_elements.length === 0) {
      warn(
        'visual_support',
        `Scene ${n} introduces a learning area with no educational visual element. If the concept ` +
          'can be shown -- equipment, a labelled diagram, a reading -- show it.',
        n,
      );
    }
  }

  record('required_fields', emptyFields === 0, emptyFields === 0 ? 'All scenes complete.' : `${emptyFields} empty.`);
  record(
    'narration_fit',
    fitFailures === 0,
    fitFailures === 0
      ? `Every scene inside its word band (${plan.words_per_second.min}-${plan.words_per_second.max} words/second).`
      : `${fitFailures} scene(s) outside their band.`,
  );
  record('audio_accuracy', repeats === 0, repeats === 0 ? 'No duplicated words in narration.' : `${repeats} duplication(s).`);
  record('no_source_leak', leaks === 0, leaks === 0 ? 'Nothing viewer-facing names the source.' : `${leaks} leak(s).`);
  record('grounding', badCitations === 0, badCitations === 0 ? 'Every citation resolves within the scene\'s allocation.' : `${badCitations} bad citation(s).`);

  // --- module coverage ----------------------------------------------------

  const cited = new Set(scenes.flatMap((s) => s.sources));
  const uncovered = plan.module_units.filter((u) => {
    const planScenes = plan.scenes.filter((p) => p.units.some((c) => c.unit_code === u.unit_code));
    const unitChunks = new Set(planScenes.flatMap((p) => p.units.flatMap((c) => c.chunk_ids)));
    return ![...unitChunks].some((c) => cited.has(c));
  });
  if (uncovered.length > 0) {
    warn(
      'module_coverage',
      `No scene cites ${uncovered.map((u) => `"${u.unit_title}"`).join(', ')}. A 90-second video ` +
        'need not cover every unit, but check that what was dropped is genuinely the least ' +
        'important part of the module.',
    );
  }
  record(
    'module_coverage',
    true,
    `${plan.module_units.length - uncovered.length} of ${plan.module_units.length} units cited.`,
  );

  // --- guaranteed by construction ----------------------------------------

  record(
    'presenter_consistency',
    true,
    'Guaranteed: the presenter, attire and voice blocks are stamped into every scene prompt from ' +
      'the one saved profile, so they are identical by construction.',
  );
  record(
    'delivery_directives',
    true,
    'Guaranteed: speech lead-in, pace and the speak-once audio directive are stamped into every ' +
      'scene prompt.',
  );
  record(
    'environment',
    true,
    `Guaranteed: every scene prompt carries the "${plan.environment.label}" environment block.`,
  );

  const error_count = findings.filter((f) => f.severity === 'error').length;
  const warning_count = findings.length - error_count;

  return {
    script_id: scriptId,
    version,
    passed: error_count === 0,
    error_count,
    warning_count,
    checks,
    findings,
  };
}
