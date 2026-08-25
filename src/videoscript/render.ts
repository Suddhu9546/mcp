/**
 * The finished script, as a person reads it and as a file.
 *
 * Two audiences, one document. Someone reviewing the script wants the narration
 * and the reasoning in order; someone producing the video wants to copy one scene
 * prompt at a time into a generator. Both are served by the same layout -- scene
 * by scene, with the prompt in a block of its own -- rather than by two exports
 * that can drift apart.
 *
 * Nothing here is generated content. It is the submitted scenes, laid out.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../util/config.js';
import type { VideoScriptState } from '../types/video-script.js';

const RULE = '='.repeat(76);
const THIN = '-'.repeat(76);

export function renderVideoScript(state: VideoScriptState): string {
  const { plan } = state;
  const out: string[] = [
    RULE,
    `${plan.video_type_label.toUpperCase()}`,
    `${plan.subject_label}  |  Module ${plan.module_number} - ${plan.module_title}`,
    `${plan.scene_count} scenes  |  ${plan.total_seconds} seconds  |  ${plan.track_label}`,
    `${state.script_id}  v${state.version}`,
    RULE,
    '',
    'PRESENTER (identical in every scene)',
    THIN,
    `  ${plan.character.description}`,
    `  ${plan.character.attire_description}`,
    `  ${plan.character.voice_description}`,
    '',
    'SETTING',
    THIN,
    `  ${plan.environment.label}: ${plan.environment.description}`,
    '',
  ];

  for (const scene of state.scenes) {
    out.push(
      RULE,
      `SCENE ${scene.scene_number}  |  ${scene.role.replace(/_/g, ' ').toUpperCase()}  |  ` +
        `${scene.start_timecode}-${scene.end_timecode} (${scene.seconds}s)`,
      RULE,
      `PURPOSE   : ${scene.educational_purpose}`,
      `LOCATION  : ${scene.location}`,
      `VISUAL    : ${scene.visual_description}`,
      `CAMERA    : ${scene.camera_framing} / ${scene.camera_movement}`,
    );
    if (scene.educational_visual_elements.length > 0) {
      out.push(`TEACHING  : ${scene.educational_visual_elements.join('; ')}`);
    }
    if (scene.on_screen_text) out.push(`ON SCREEN : ${scene.on_screen_text}`);
    out.push(
      '',
      `VOICEOVER (${scene.narration_word_count} words):`,
      `  ${scene.narration}`,
      '',
      'AI VIDEO PROMPT:',
      scene.ai_video_prompt.replace(/^/gm, '  '),
      '',
    );
  }

  out.push(
    RULE,
    `END OF SCRIPT  |  ${state.scenes.length} scenes  |  ` +
      `${state.scenes.reduce((a, s) => a + s.narration_word_count, 0)} spoken words  |  ` +
      `${plan.total_seconds}s`,
    RULE,
  );

  return out.join('\n');
}

export interface WrittenScript {
  path: string;
  filename: string;
  bytes: number;
}

/**
 * Writes the script to disk.
 *
 * A seven-scene script with its prompts runs to several kilobytes, and the file
 * is what a producer actually opens next to the generator. It goes under its own
 * directory so a subject's videos and its storyboards do not interleave, and the
 * version is in the filename so two downloads are distinguishable without opening
 * either.
 */
export function writeVideoScriptFile(state: VideoScriptState, body: string): WrittenScript {
  const dir = path.join(config.paths.artifacts, 'video-scripts', state.script_id);
  mkdirSync(dir, { recursive: true });
  const filename = `${state.subject_id}-module-${state.module_number}-info-video-v${state.version}.txt`;
  const file = path.join(dir, filename);
  const bytes = Buffer.from(body, 'utf8');
  writeFileSync(file, bytes);
  return { path: file, filename, bytes: bytes.length };
}
