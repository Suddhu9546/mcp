/**
 * Composing the AI video-generation prompt for one scene.
 *
 * The prompt is assembled here rather than written by the client, and that is the
 * central design decision of this feature. A prompt has to restate, every single
 * time, who the presenter is, what they are wearing, how they sound, that they
 * start speaking immediately, where the pauses go, and that each line is spoken
 * once and not repeated -- because the generator produces each clip in isolation
 * and remembers none of it. Asking a writer to repeat nine fixed blocks across
 * eighteen scenes produces eighteen slightly different versions of them, and
 * slightly different is exactly what a viewer sees as a different person.
 *
 * The second reason is precision. A generator does not infer; it fills gaps with
 * whatever is statistically nearby, and every gap is a defect waiting to be
 * rendered. So the prompt is written as labelled, numbered, unambiguous
 * instructions rather than as prose: exact timings in seconds, the spoken line
 * quoted in full and marked as the complete audio, and an explicit list of things
 * not to do. Prose invites interpretation. A checklist does not.
 *
 * The prompt is written in English regardless of what is being taught, because
 * that is what the generators accept.
 */

import {
  SCENE_END_PAUSE,
  SENTENCE_PAUSE,
  SPEAKING_PACE,
  SPEECH_LEAD_IN_SECONDS,
  type AuthoredScene,
  type CharacterLock,
  type EnvironmentLock,
  type PlannedScene,
} from '../types/video-script.js';

/** Splits narration into its sentences, for the per-sentence timing instruction. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The audio directive, identical in structure in every scene.
 *
 * Every clause here exists because a generator does the opposite without it:
 * clips that open on two seconds of silence, lines delivered twice, a word
 * stuttered at the cut, a phrase restarted mid-sentence, sentences run together
 * with no breath so two consecutive clips sound like one chopped-up take. They are
 * cheap to state and expensive to discover after rendering.
 *
 * The line is quoted whole and then marked as the entire audio, because a
 * generator handed a quoted line and a described scene will otherwise add an
 * "and now let us look at..." of its own to bridge them.
 */
function audioBlock(narration: string, seconds: number): string[] {
  const sentences = sentencesOf(narration);
  const spoken = narration.trim();

  const lines = [
    `1. The presenter starts speaking within ${SPEECH_LEAD_IN_SECONDS} of the clip starting. No ` +
      'silent opening beat.',
    `2. The spoken audio is exactly and only this, word for word: "${spoken}"`,
    '3. Speak that line once. Do not repeat it, do not repeat any word or phrase inside it, do ' +
      'not stutter, do not restart a phrase, and do not add, drop, reorder or paraphrase any ' +
      'word.',
    '4. Say nothing else. No greeting, no sign-off, no bridging line, no improvised words, no ' +
      'filler sounds.',
  ];

  if (sentences.length > 1) {
    lines.push(
      `5. There are ${sentences.length} sentences. Leave ${SENTENCE_PAUSE} between them -- a real ` +
        'breath, not a hard cut.',
    );
  } else {
    lines.push('5. This is one sentence, delivered without an internal break.');
  }

  lines.push(
    `6. The line begins and ends inside these ${seconds} seconds. It is complete: it does not ` +
      'continue from the previous clip and it is not finished by the next one.',
    `7. End with ${SCENE_END_PAUSE} after the final word, before the clip ends. Do not cut on ` +
      'the last syllable.',
    `8. Delivery pace: ${SPEAKING_PACE}.`,
  );

  return lines;
}

/**
 * The accuracy directive, in every scene whether it carries text or not.
 *
 * Misspelled on-screen text is the most common way one of these videos comes back
 * unusable, and it is unusable in the worst way: the clip looks right, the audio is
 * right, and a learner sees "CALORIFC VALUE" burned into a training video. It has
 * to be re-generated, and nothing in the script was wrong.
 *
 * Three things cause it and all three are addressed here. Text that was asked for
 * gets rendered approximately, so the exact string is repeated and the model is
 * told to copy it character for character. Text that was NOT asked for gets
 * invented -- signage, watermarks, labels, dummy lettering on a wall -- and comes
 * out as garbled pseudo-words, so anything unlisted is forbidden outright and the
 * permitted strings are enumerated. And a model that cannot render text cleanly
 * will still try, so it is given the alternative: no text beats broken text.
 *
 * The block appears even on scenes with no on-screen text, because those are
 * exactly the scenes where invented background lettering appears unchallenged.
 */
function accuracyBlock(authored: AuthoredScene): string[] {
  const onScreen = authored.on_screen_text?.trim();
  const hasVisuals = authored.educational_visual_elements.length > 0;

  // What text this scene is entitled to show, stated exactly. A scene with a
  // labelled diagram genuinely has text in it, so it must not be told that no
  // text may appear -- a prompt that contradicts itself is resolved by the
  // generator however it likes, which is the situation being avoided.
  const permitted: string[] = [];
  if (onScreen) permitted.push(`the caption "${onScreen}", exactly as written`);
  if (hasVisuals) permitted.push('the labels on the teaching visual named above, exactly as named');

  const lines: string[] =
    permitted.length > 0
      ? [
          `1. The only text anywhere in the frame is ${permitted.join(', and ')}. Render it ` +
            'character for character: correctly spelled, in full, not re-worded, not abbreviated, ' +
            'not translated, not pluralised, not auto-corrected.',
          '2. Add no other text of any kind -- no extra captions, titles, subtitles, signage, ' +
            'watermarks or logos, and no decorative, placeholder, dummy, garbled or nonsense ' +
            'lettering on walls, screens, packaging, boards, clothing or equipment anywhere in ' +
            'the background.',
        ]
      : [
          '1. No text of any kind appears in this frame: no captions, titles, subtitles, labels, ' +
            'signage, watermarks or logos.',
          '2. In particular, do not invent background lettering. No decorative, placeholder, ' +
            'dummy, garbled or nonsense words on walls, screens, packaging, boards, clothing or ' +
            'equipment.',
        ];

  lines.push(
    '3. Every number, unit, symbol and measurement shown must be exactly the value given here. ' +
      'Do not round it, change it, or substitute a similar-looking one.',
    '4. Everything shown must be factually correct and must match what is being said at that ' +
      'moment: the equipment, the quantities, the steps and the order they happen in.',
    '5. If any piece of text cannot be rendered cleanly, legibly and correctly spelled, show no ' +
      'text at all. Missing text is acceptable; misspelled text is not.',
  );

  return lines;
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
 * Labelled blocks rather than one paragraph. Generators follow a structured prompt
 * more reliably than prose, and a person reviewing eighteen of these can see at a
 * glance that the character block is identical in all of them.
 */
export function composeScenePrompt(options: ComposeOptions): string {
  const { planned, authored, character, environment, previousScene } = options;

  const blocks: string[] = [
    `SHOT: one continuous ${planned.seconds}-second take. Scene ${planned.scene_number} of an ` +
      'educational explainer video. Single unbroken shot -- no cuts, no jump cuts, no montage.',
    `PRESENTER: ${character.description}. ${character.attire_description} ` +
      `${character.consistency_clause}`,
    `VOICE: ${character.voice_description}`,
    `SETTING: ${authored.location}. ${environment.description}.`,
    `PRESENTER ACTION: ${authored.character_action}`,
    `WHAT IS ON SCREEN: ${authored.visual_description}`,
    `CAMERA: ${authored.camera_framing}. Movement: ${authored.camera_movement}. The presenter ` +
      'stays fully in frame for the whole take.',
  ];

  if (authored.educational_visual_elements.length > 0) {
    blocks.push(
      `TEACHING VISUALS: ${authored.educational_visual_elements.join('; ')}. These must be ` +
        'sharp, legible, and must match what is being said at the moment it is said. Any label ' +
        'on them must be a correctly spelled real word, taken from the terms named here.',
    );
  }

  if (authored.on_screen_text && authored.on_screen_text.trim().length > 0) {
    blocks.push(
      `ON-SCREEN TEXT: render exactly this string and nothing else -- "${authored.on_screen_text.trim()}"` +
        ' -- copied character for character, clean sans-serif, appearing as it is spoken.',
    );
  }

  blocks.push(
    `ACCURACY -- this is critical:\n${accuracyBlock(authored).map((l) => `  ${l}`).join('\n')}`,
  );

  const continuity = authored.continuity?.trim();
  if (continuity && continuity.length > 0) {
    blocks.push(`CONTINUITY: ${continuity}`);
  } else if (previousScene) {
    blocks.push(
      'CONTINUITY: the same presenter, the same clothing and the same world as the previous ' +
        'scene, continuing naturally from it.',
    );
  }

  blocks.push(`AUDIO -- follow every point:\n${audioBlock(authored.narration, planned.seconds).map((l) => `  ${l}`).join('\n')}`);

  blocks.push(
    'STYLE: realistic Indian educational video. Natural daylight or practical lighting, natural ' +
      'expressions, professional but approachable. The subject being taught is the focus; the ' +
      'presenter is the teacher, not the story.',
  );

  blocks.push(
    'DO NOT: misspell any word on screen; render garbled, nonsense or invented lettering ' +
      'anywhere in the frame; add text, captions, subtitles, signage, watermarks or logos beyond ' +
      'what is specified above; change any number or unit shown; change the presenter\'s face, ' +
      'age, build, hairstyle or clothing; add a second person or a voice other than the ' +
      'presenter\'s; add background music; use slow motion, speed ramping, film grain, lens ' +
      'flare or dramatic colour grading; cut away from the presenter; leave the clip silent at ' +
      'either end beyond the pauses specified.',
  );

  return blocks.join('\n');
}
