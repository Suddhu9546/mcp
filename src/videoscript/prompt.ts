/**
 * Composing the AI video-generation prompt for one scene.
 *
 * The prompt is assembled here rather than written by the client, and that is the
 * central design decision of this feature. A prompt has to restate, every single
 * time, who the presenter is, what they are wearing, how they sound, that they
 * start speaking immediately, and that each line is spoken once and not repeated
 * -- because the generator produces each clip in isolation and remembers none of
 * it. Asking a writer to repeat eight fixed blocks across seven scenes produces
 * seven slightly different versions of them, and slightly different is exactly
 * what a viewer sees as a different person.
 *
 * So the client writes only what genuinely varies -- the action, the framing, the
 * teaching visual, the words -- and everything fixed is stamped in from the
 * profile. The presenter is then identical by construction.
 *
 * The prompt is written in English regardless of what is being taught, because
 * that is what the generators accept.
 */

import {
  SPEAKING_PACE,
  SPEECH_LEAD_IN_SECONDS,
  type AuthoredScene,
  type CharacterLock,
  type EnvironmentLock,
  type PlannedScene,
} from '../types/video-script.js';

/**
 * The audio directive, identical in every scene.
 *
 * Every clause here exists because a generator does the opposite without it:
 * clips that open on two seconds of silence, lines delivered twice, a word
 * stuttered at the cut, a phrase restarted mid-sentence. They are cheap to state
 * and expensive to discover after rendering.
 */
function audioBlock(narration: string): string {
  return [
    `The presenter begins speaking within ${SPEECH_LEAD_IN_SECONDS} of the clip starting.`,
    `Delivery pace: ${SPEAKING_PACE}.`,
    'Spoken audio, word for word, exactly once: "' + narration.trim() + '"',
    'Speak this line once only. Do not repeat it, do not stutter, do not restart a phrase, do ' +
      'not duplicate any word, and do not add, drop or reorder words. No filler words. No long ' +
      'pauses at the start or the end.',
  ].join(' ');
}

export interface ComposeOptions {
  planned: PlannedScene;
  authored: AuthoredScene;
  character: CharacterLock;
  environment: EnvironmentLock;
  /** Set on every scene but the first, to hold the video together. */
  previousScene?: AuthoredScene;
}

/**
 * Builds the prompt for one scene.
 *
 * Written as labelled lines rather than one paragraph. Generators follow a
 * structured prompt more reliably than prose, and a person reviewing seven of
 * these can see at a glance that the character block is identical in all of them.
 */
export function composeScenePrompt(options: ComposeOptions): string {
  const { planned, authored, character, environment, previousScene } = options;

  const lines: string[] = [
    `SHOT: ${planned.seconds}-second continuous shot, scene ${planned.scene_number} of an ` +
      'educational explainer video.',
    `CHARACTER: ${character.description}. ${character.attire_description} ${character.consistency_clause}`,
    `VOICE: ${character.voice_description}`,
    `ENVIRONMENT: ${authored.location}. ${environment.description}.`,
    `ACTION: ${authored.character_action}`,
    `SCENE: ${authored.visual_description}`,
    `CAMERA: ${authored.camera_framing}. ${authored.camera_movement}.`,
  ];

  if (authored.educational_visual_elements.length > 0) {
    lines.push(
      `EDUCATIONAL VISUALS: ${authored.educational_visual_elements.join('; ')}. These must be ` +
        'clearly legible and must match what is being said.',
    );
  }

  if (authored.on_screen_text && authored.on_screen_text.trim().length > 0) {
    lines.push(
      `ON-SCREEN TEXT: "${authored.on_screen_text.trim()}", clean sans-serif, appearing as it is ` +
        'spoken.',
    );
  }

  const continuity = authored.continuity?.trim();
  if (continuity && continuity.length > 0) {
    lines.push(`CONTINUITY: ${continuity}`);
  } else if (previousScene) {
    lines.push(
      'CONTINUITY: the same presenter, clothing and world as the previous scene, continuing ' +
        'naturally from it.',
    );
  }

  lines.push(`AUDIO: ${audioBlock(authored.narration)}`);
  lines.push(
    'STYLE: realistic Indian educational video, natural lighting, natural expressions, ' +
      'professional but approachable. Not cinematic, not dramatic, no film grading, no slow ' +
      'motion, no music video styling. The subject being taught is the focus; the presenter is ' +
      'the teacher, not the story.',
  );

  return lines.join('\n');
}
