/**
 * The film's beats, by part.
 *
 * The failure this fixes is specific: asked for eighteen 10-second segments, a
 * writer produces eighteen self-contained clips, each competently written and none
 * of them continuing the last. The cause is that every segment is optimised on its
 * own, so the fix is to hand each segment its job in the film before a word of it is
 * written.
 *
 * The film is in three parts and the beats follow them. The first minute orients the
 * learner to the whole module -- what it is, why it matters, what they will be able
 * to do -- and its beats are fixed, because that job is the same for every module.
 * The ninety seconds that follow teach the units, so those beats are computed from
 * the units themselves: a unit is introduced, explained, and closed with what to
 * remember, however many segments it was allocated. The last thirty seconds
 * consolidate, and those beats are fixed again.
 */

import type { StoryBeat } from '../types/module-content.js';

const CONTINUITY_NOTE =
  ' One idea only -- ten seconds holds one. Continue the previous segment\'s final moment, and ' +
  'hand over to the next from inside the scene.';

/** Part 1: module orientation, six segments. The same job in every module. */
const ORIENTATION_BEATS: readonly StoryBeat[] = [
  {
    act: 'discovery',
    beat: 'the hook',
    story_function:
      'Open on the world this module lives in and the problem it exists to solve. End on an image ' +
      'that makes the learner want the next ten seconds. Teach nothing yet.',
    emotional_tone: 'curiosity',
  },
  {
    act: 'discovery',
    beat: 'why this matters',
    story_function:
      'Say plainly why this module is worth the learner\'s time -- what it changes for someone ' +
      'doing this work. Concrete and personal, not a claim about the industry.',
    emotional_tone: 'relevance: "this is about my work"',
  },
  {
    act: 'discovery',
    beat: 'what this module covers',
    story_function:
      'Name the ground the module covers, at the level of the module rather than any one unit. ' +
      'This is the map, not the journey.',
    emotional_tone: 'orientation',
  },
  {
    act: 'discovery',
    beat: 'what you will be able to do (1)',
    story_function:
      'Carry the first of the module\'s stated learning outcomes, shown as something a person ' +
      'does rather than read out as an objective.',
    emotional_tone: 'anticipation',
  },
  {
    act: 'discovery',
    beat: 'what you will be able to do (2)',
    story_function:
      'Carry the next stated outcomes the same way. Together with the previous segment these ' +
      'should tell the learner what they will walk away able to do.',
    emotional_tone: 'anticipation',
  },
  {
    act: 'discovery',
    beat: 'into the units',
    story_function:
      'Close the orientation and open the teaching: signal that the module is now going to work ' +
      'through its units one at a time, and lead into the first of them.',
    emotional_tone: 'readiness',
  },
];

/** Part 3: module conclusion, three segments. */
const CONCLUSION_BEATS: readonly StoryBeat[] = [
  {
    act: 'payoff',
    beat: 'the main thing learned',
    story_function:
      'State the single most important thing this module taught, across all its units. No new fact.',
    emotional_tone: 'consolidation',
  },
  {
    act: 'payoff',
    beat: 'how it connects',
    story_function:
      'Show how the units fit together -- how what was learned in one makes sense of another. This ' +
      'is what turns a list of units into a module.',
    emotional_tone: 'understanding',
  },
  {
    act: 'payoff',
    beat: 'what to do with it',
    story_function:
      'Return to the opening image and show what it has become, and give the learner the one ' +
      'practical thing to do next. Not "thank you for watching".',
    emotional_tone: 'practical confidence',
  },
];

export function orientationBeat(indexInPart: number): StoryBeat {
  const beat = ORIENTATION_BEATS[indexInPart];
  if (!beat) throw new Error(`Part 1 has ${ORIENTATION_BEATS.length} beats; no beat ${indexInPart}.`);
  return { ...beat, story_function: `${beat.story_function}${CONTINUITY_NOTE}` };
}

export function conclusionBeat(indexInPart: number): StoryBeat {
  const beat = CONCLUSION_BEATS[indexInPart];
  if (!beat) throw new Error(`Part 3 has ${CONCLUSION_BEATS.length} beats; no beat ${indexInPart}.`);
  return { ...beat, story_function: `${beat.story_function}${CONTINUITY_NOTE}` };
}

/**
 * Part 2: the beat for one teaching segment.
 *
 * Computed rather than tabulated, because how many segments a unit gets depends on
 * how much of the module it is. A unit with one segment must introduce and land its
 * point in ten seconds; a unit with three has room to open, explain and close. The
 * position in the unit decides which of those this segment is.
 */
export function unitBeat(options: {
  unitTitle: string;
  unitCodes: string[];
  positionInUnit: number;
  segmentsForUnit: number;
}): StoryBeat {
  const { unitTitle, positionInUnit, segmentsForUnit } = options;
  const first = positionInUnit === 0;
  const last = positionInUnit === segmentsForUnit - 1;
  const single = segmentsForUnit === 1;

  if (single) {
    return {
      act: 'exploration',
      beat: `unit: ${unitTitle}`,
      story_function:
        `This unit gets one segment, so it must do all of it: name "${unitTitle}", say what it is ` +
        'about, and land its single most important point. Do not spend the segment announcing the ' +
        'unit -- the learner must come away knowing something.' +
        CONTINUITY_NOTE,
      emotional_tone: 'clarity',
    };
  }
  if (first) {
    return {
      act: 'exploration',
      beat: `open unit: ${unitTitle}`,
      story_function:
        `Introduce this unit by name -- "${unitTitle}" -- and say in the same breath what it is ` +
        'about and what the learner will get from it. An introduction that only announces the ' +
        'unit wastes ten of the ninety teaching seconds.' +
        CONTINUITY_NOTE,
      emotional_tone: 'a new question opening',
    };
  }
  if (last) {
    return {
      act: 'exploration',
      beat: `close unit: ${unitTitle}`,
      story_function:
        'Land what the learner should take from this unit, shown as something happening rather ' +
        'than stated as a summary, and lead into the next unit.' +
        CONTINUITY_NOTE,
      emotional_tone: 'a point landing',
    };
  }
  return {
    act: 'exploration',
    beat: `teach unit: ${unitTitle}`,
    story_function:
      'Teach the core of the material allocated here -- the definition, the step or the reason ' +
      'that matters most. Show it happening; do not narrate a list.' +
      CONTINUITY_NOTE,
    emotional_tone: 'understanding building',
  };
}
