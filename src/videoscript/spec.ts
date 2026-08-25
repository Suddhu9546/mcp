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
  MAX_TOTAL_SECONDS,
  MIN_TOTAL_SECONDS,
  SPEAKING_PACE,
  SPEECH_LEAD_IN_SECONDS,
} from '../types/video-script.js';

export const VIDEO_SCRIPT_SPEC = {
  what_this_is:
    'A 60-90 second educational introduction to one Participant Handbook module, for an LMS. ' +
    'It is not a film. The module content is the hero and the presenter is a teacher who ' +
    'explains it.',

  priority_order:
    'Handbook module content -> educational accuracy -> the learning objective -> visual ' +
    'explanation -> the user video profile -> the fixed presentation rules -> the scene. Never ' +
    'reverse this: presentation never decides what is taught.',

  grounding: [
    'The selected module of the Participant Handbook is the only source of educational content. ' +
    'Every fact, figure, process step, standard and definition must be supported by the text ' +
    'attached to the scene.',
    'Do not add statistics, prices, dates, standards, regulations or brand names the module does ' +
    'not state, and do not fill a gap in the module from general knowledge.',
    'Do not bring in content from another module or another subject.',
    'Identify what matters most in the module and introduce that. A 90-second video cannot cover ' +
    'a module, and trying is how it ends up covering nothing.',
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
      'The voiceover, word for word, within the scene word band. Nothing else is spoken.',
    on_screen_text: 'Optional. Short, and only where it reinforces what is said.',
    sources: 'chunk_ids from this scene\'s allocated handbook text.',
  },

  narration_rules: [
    'Write inside the scene\'s min_words and max_words. Roughly 11-17 words per 10 seconds. A ' +
    'scene written over its band has its last words cut off by the generator.',
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

  what_the_server_adds:
    'Do not write the presenter\'s appearance, clothing, voice, accent, pace or the ' +
    'audio-accuracy instructions into any field. The server stamps them into every scene prompt ' +
    'from the saved video profile, identically, which is what keeps the presenter the same person ' +
    'in every scene. Writing them yourself produces seven near-identical descriptions and one ' +
    'presenter per scene.',

  duration: `${MIN_TOTAL_SECONDS}-${MAX_TOTAL_SECONDS} seconds in total, fixed by the plan.`,

  how_to_work:
    'Write all scenes in one pass and submit them together with submit_video_script. That call ' +
    'validates, composes the generation prompts and writes the file, so a finished script is two ' +
    'calls from the plan. If validation reports findings, fix those scenes and submit again.',
} as const;
