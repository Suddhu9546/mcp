/**
 * What the client is told to write.
 *
 * This ships with the plan rather than sitting behind a separate call, because a
 * second round trip to learn the rules is a second round trip on every video. It
 * is deliberately short: the plan already carries each scene's role, direction,
 * seconds, word band and handbook text, so what remains here is the handful of
 * rules that apply to all of them and the list of fields to fill.
 */

import {
  MAX_SCENE_COUNT,
  MAX_SENTENCES_PER_SCENE,
  MAX_TOTAL_SECONDS,
  MIN_SCENE_COUNT,
  MIN_TOTAL_SECONDS,
  SCENE_END_PAUSE,
  SCENE_SECONDS,
  SENTENCE_PAUSE,
  SPEAKING_PACE,
  SPEECH_LEAD_IN_SECONDS,
  WORDS_PER_SCENE_MAX,
  WORDS_PER_SCENE_MIN,
} from '../types/video-script.js';

export const VIDEO_SCRIPT_SPEC = {
  what_this_is:
    `A ${MIN_TOTAL_SECONDS}-${MAX_TOTAL_SECONDS} second educational introduction to one ` +
    'Participant Handbook module, for an LMS. It covers the whole module at introduction depth: ' +
    'every learning area is named and given something concrete. It is not a film. The module ' +
    'content is the hero and the presenter is a teacher who explains it.',

  priority_order:
    'Handbook module content -> educational accuracy -> the learning objective -> visual ' +
    'explanation -> the user video profile -> the fixed presentation rules -> the scene. Never ' +
    'reverse this: presentation never decides what is taught.',

  the_four_hard_rules: [
    `Every scene is exactly ${SCENE_SECONDS} seconds. No scene may run longer.`,
    `Every scene's narration is ${WORDS_PER_SCENE_MIN}-${WORDS_PER_SCENE_MAX} words. Not fewer, ` +
    'not more. This is checked and a scene outside the band is rejected.',
    'Every sentence begins and ends inside one scene. Never leave a clause, a list or a thought ' +
    'for the next scene to finish, and never open a scene by completing the previous one. Each ' +
    'scene is generated as its own clip, so a sentence that spans two of them breaks.',
    `At most ${MAX_SENTENCES_PER_SCENE} sentences per scene, so there is room for ` +
    `${SENTENCE_PAUSE} between them and ${SCENE_END_PAUSE} before the cut.`,
  ],

  grounding: [
    'The selected module of the Participant Handbook is the only source of educational content. ' +
    'Every fact, figure, process step, standard and definition must be supported by the text ' +
    'attached to the scene.',
    'Do not add statistics, prices, dates, standards, regulations or brand names the module does ' +
    'not state, and do not fill a gap in the module from general knowledge.',
    'Do not bring in content from another module or another subject.',
    'Each learning area gets two or three consecutive scenes and each scene gets its own slice ' +
    'of that area\'s text. Write each scene from its own slice: the second scene of an area ' +
    'continues it, it does not re-introduce it.',
    'Narration, examples, phrasing and all visual direction are yours to write. Only the facts ' +
    'are constrained.',
  ],

  it_is_not_a_film: [
    'No character backstory, no invented personal history, no character development.',
    'No drama, no conflict, no emotional storytelling, no cinematic set pieces.',
    'No conversations between characters. One presenter, speaking to the learner.',
    'No action that does not help explain the topic.',
    'The presenter demonstrates, points at, holds and shows things. That is the whole of their ' +
    'role.',
  ],

  scene_fields: {
    educational_purpose: 'What this scene does for the learner, in one sentence.',
    location:
      'Where this scene is, inside the chosen environment. It may adapt for the teaching -- a ' +
      'closer part of the same premises, the equipment itself -- but not move to an unrelated ' +
      'world.',
    visual_description: 'What is on screen: the presenter, the setting, and the teaching visual.',
    character_action:
      'What the presenter does. Teaching action only: holds, points, demonstrates, indicates.',
    camera_framing:
      'Explicit. e.g. "medium shot, presenter centre-left, chest up, equipment visible right".',
    camera_movement: 'e.g. "locked off", "slow push in", "gentle pan left to follow the hand".',
    educational_visual_elements:
      'The concrete things shown to explain the point: the labelled diagram and its labels, the ' +
      'formula, the equipment, the meter and its reading. Where a concept can be shown, show it ' +
      'rather than leaving a generic background.',
    continuity: 'Optional. What carries over from the previous scene, where it helps.',
    narration:
      `The voiceover, word for word: ${WORDS_PER_SCENE_MIN}-${WORDS_PER_SCENE_MAX} words, ` +
      'complete sentences, ending on a full stop. Nothing else is spoken.',
    on_screen_text:
      'Optional. Short, and only where it reinforces what is said. Generators misspell burned-in ' +
      'text, and the longer and more unusual the string the likelier it is: keep it to a few ' +
      'plain words, and leave it out where it adds nothing.',
    sources: "chunk_ids from this scene's own allocated slice.",
  },

  narration_rules: [
    `${WORDS_PER_SCENE_MIN}-${WORDS_PER_SCENE_MAX} words, every scene. Over the band the ` +
    'generator cuts the last words off; under it the clip trails into silence.',
    'End on a full stop, question mark or exclamation mark. Never on a comma, and never on a ' +
    'word like "and", "so", "which" or "to" that promises something after it.',
    'No sentence fragments. Every sentence is a whole sentence.',
    'It must sound like a real Indian instructor speaking, not a textbook read aloud. Short ' +
    'sentences, plain words, second person where it fits.',
    'One idea per scene.',
    `Delivery is ${SPEAKING_PACE}, and the presenter starts speaking within ` +
    `${SPEECH_LEAD_IN_SECONDS} of the clip. Do not write a line that needs a run-up.`,
    'Scene 1 opens with a natural spoken "Namastey".',
    'No repeated words, no restarted phrases, no filler.',
    'Never mention the handbook, a page, a figure, a table, a unit number, a module number or a ' +
    'qualification code. The viewer has none of those. Citations go in `sources`.',
  ],

  on_screen_accuracy: [
    'Misspelled on-screen text is the commonest way one of these videos comes back unusable, so ' +
    'every scene prompt carries an accuracy block naming exactly which text may appear and ' +
    'forbidding everything else, including invented background lettering.',
    'That block is generated from your on_screen_text and your educational_visual_elements. ' +
    'Whatever you put in those two fields is what the generator is told it may render -- so ' +
    'write them as the exact words that should appear, correctly spelled, and nothing more.',
    'Name the labels you want on a diagram explicitly in educational_visual_elements. A visual ' +
    'described only as "a labelled chart" leaves the generator to invent the labels, which is ' +
    'where the nonsense words come from.',
    'Every figure you write must be one the handbook states. The prompt tells the generator not ' +
    'to change any number it is given, which only helps if the number was right to begin with.',
  ],

  what_the_server_adds:
    "Do not write the presenter's appearance, clothing, voice, accent, pace, the pause timings " +
    'or the audio-accuracy instructions into any field. The server stamps them into every scene ' +
    'prompt from the saved video profile, identically, which is what keeps the presenter the ' +
    'same person in every scene. Writing them yourself produces eighteen near-identical ' +
    'descriptions and one presenter per scene.',

  duration:
    `${MIN_TOTAL_SECONDS}-${MAX_TOTAL_SECONDS} seconds in total: ${MIN_SCENE_COUNT}-` +
    `${MAX_SCENE_COUNT} scenes of ${SCENE_SECONDS} seconds each, fixed by the plan.`,

  how_to_work:
    'Write all scenes in one pass and submit them together with submit_video_script. That call ' +
    'validates, composes the generation prompts and writes the file, so a finished script is two ' +
    'calls from the plan. If validation reports findings, fix those scenes and submit again.',
} as const;
