/**
 * The video profile: the presenter, and the world they stand in.
 *
 * Two jobs. The first is asking: five questions about the presenter and one about
 * the setting, with the attire list depending on the gender chosen, and answers
 * accepted as numbers or as words because a user replying "female, 30-40, deep,
 * south indian, saree" has answered just as clearly as one replying "2,3,5,2,4".
 *
 * The second, and the reason this is a module rather than six fields, is the
 * character lock. Each scene is generated on its own and the generator remembers
 * nothing between calls, so a presenter described afresh per scene comes back as
 * a different person -- different face, different clothes, different voice. The
 * fix is that the description is written once, here, from the profile, and the
 * identical sentence is repeated into every scene prompt. Consistency is then a
 * property of the code rather than something the writer has to remember.
 *
 * The profile is saved and reused. Asking the same six questions before every
 * module is the kind of friction that makes a tool unpleasant to use twice.
 */

import { getDb, nowIso } from '../storage/db.js';
import {
  AGE_RANGES,
  ATTIRES,
  DEMOGRAPHICS,
  ENVIRONMENTS,
  GENDERS,
  SKIN_TONES,
  type AgeRange,
  type Attire,
  type CharacterLock,
  type Demographic,
  type Environment,
  type EnvironmentLock,
  type Gender,
  type SkinTone,
  type VideoProfile,
} from '../types/video-script.js';

export class VideoProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoProfileError';
  }
}

// ---------------------------------------------------------------------------
// The option lists, exactly as the user is shown them
// ---------------------------------------------------------------------------

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** Extra words that also select this option, beyond the value and the label. */
  aliases?: string[];
}

export const GENDER_CHOICES: Choice<Gender>[] = [
  { value: 'male', label: 'Male', aliases: ['m', 'man'] },
  { value: 'female', label: 'Female', aliases: ['f', 'woman'] },
];

export const AGE_CHOICES: Choice<AgeRange>[] = [
  { value: '20-25', label: '20-25' },
  { value: '25-30', label: '25-30' },
  { value: '30-40', label: '30-40' },
  { value: '40-50', label: '40-50' },
  { value: '50+', label: '50+', aliases: ['50', 'over 50'] },
];

export const SKIN_TONE_CHOICES: Choice<SkinTone>[] = [
  { value: 'light', label: 'Light' },
  { value: 'light-medium', label: 'Light-medium' },
  { value: 'medium-wheatish', label: 'Medium / Wheatish', aliases: ['medium', 'wheatish'] },
  { value: 'medium-deep', label: 'Medium-deep' },
  { value: 'deep', label: 'Deep', aliases: ['dark'] },
];

export const DEMOGRAPHIC_CHOICES: Choice<Demographic>[] = [
  { value: 'north-indian', label: 'North Indian', aliases: ['north'] },
  { value: 'south-indian', label: 'South Indian', aliases: ['south'] },
  { value: 'east-indian', label: 'East Indian', aliases: ['east'] },
  { value: 'western-indian', label: 'Western Indian', aliases: ['west', 'west indian'] },
  { value: 'pan-indian', label: 'Pan-Indian / Neutral Indian', aliases: ['pan indian', 'neutral'] },
];

const MALE_ATTIRE: Choice<Attire>[] = [
  { value: 'formal-shirt-trousers', label: 'Formal Indian - Shirt & Trousers', aliases: ['formal'] },
  { value: 'business-casual', label: 'Business Casual Indian', aliases: ['business casual', 'casual'] },
  { value: 'traditional-kurta-pajama', label: 'Traditional Indian - Kurta/Pajama', aliases: ['kurta', 'kurta pajama', 'traditional'] },
  { value: 'semi-formal-kurta-jacket', label: 'Semi-formal Indian - Kurta & Jacket', aliases: ['semi formal', 'kurta jacket'] },
  { value: 'field-work', label: 'Professional Field/Work Attire', aliases: ['field', 'work attire', 'work'] },
  { value: 'topic-specific', label: 'Topic-specific Attire', aliases: ['topic specific', 'topic'] },
];

const FEMALE_ATTIRE: Choice<Attire>[] = [
  { value: 'formal-shirt-trousers', label: 'Formal Indian - Shirt & Trousers', aliases: ['formal'] },
  { value: 'business-casual', label: 'Business Casual Indian', aliases: ['business casual', 'casual'] },
  { value: 'traditional-kurta-salwar', label: 'Traditional Indian - Kurta/Salwar', aliases: ['kurta', 'kurta salwar', 'salwar', 'traditional'] },
  { value: 'saree', label: 'Indian Saree', aliases: ['sari'] },
  { value: 'semi-formal-kurta-jacket', label: 'Semi-formal Indian - Kurta & Jacket', aliases: ['semi formal', 'kurta jacket'] },
  { value: 'field-work', label: 'Professional Field/Work Attire', aliases: ['field', 'work attire', 'work'] },
  { value: 'topic-specific', label: 'Topic-specific Attire', aliases: ['topic specific', 'topic'] },
];

/** The attire list depends on the gender: a saree is not offered to a male presenter. */
export function attireChoices(gender: Gender): Choice<Attire>[] {
  return gender === 'male' ? MALE_ATTIRE : FEMALE_ATTIRE;
}

export const ENVIRONMENT_CHOICES: Choice<Environment>[] = [
  { value: 'domestic-small-scale', label: 'Small-scale domestic', aliases: ['domestic', 'home'] },
  { value: 'rural', label: 'Rural', aliases: ['village'] },
  { value: 'semi-urban', label: 'Semi-urban', aliases: ['semi urban', 'town'] },
  { value: 'small-business', label: 'Small business / workplace', aliases: ['small business', 'workplace', 'shop'] },
  { value: 'industrial', label: 'Industrial', aliases: ['industry'] },
  { value: 'large-scale-professional', label: 'Large-scale professional', aliases: ['large scale', 'professional', 'corporate'] },
  { value: 'factory-production', label: 'Factory / production environment', aliases: ['factory', 'production', 'plant'] },
];

// ---------------------------------------------------------------------------
// Reading an answer
// ---------------------------------------------------------------------------

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Resolves one answer against one option list.
 *
 * Accepts the position shown ("3"), the stored value ("medium-wheatish"), the
 * label ("Medium / Wheatish") or an alias ("wheatish"). Returns undefined rather
 * than the nearest match: a presenter who comes out the wrong age is a re-run of
 * the whole video, so guessing is not worth the turn it saves.
 */
export function resolveChoice<T extends string>(answer: string, choices: Choice<T>[]): T | undefined {
  const raw = normalise(answer).replace(/[.)]$/, '');
  if (raw.length === 0) return undefined;

  const index = Number(raw);
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
    return choices[index - 1]!.value;
  }

  const flat = (s: string) => normalise(s).replace(/[^a-z0-9+]+/g, '');
  const key = flat(raw);
  const hit = choices.find(
    (c) =>
      flat(c.value) === key ||
      flat(c.label) === key ||
      (c.aliases ?? []).some((a) => flat(a) === key),
  );
  return hit?.value;
}

export interface CharacterAnswers {
  gender: Gender;
  age_range: AgeRange;
  skin_tone: SkinTone;
  demographic: Demographic;
  attire: Attire;
}

/**
 * Reads the five presenter answers given in one reply.
 *
 * They are asked together because they are one decision -- what the presenter
 * looks like -- and splitting them into five turns makes a two-minute video cost
 * five round trips. The cost of asking together is that they arrive as one string,
 * so it is parsed here: comma, semicolon, slash, pipe or newline separated.
 *
 * Attire is resolved last and against the gender just given, which is the whole
 * reason the order is fixed rather than free.
 */
export function parseCharacterAnswers(answer: string): CharacterAnswers {
  const parts = answer
    .split(/[,;|\n\/]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length !== 5) {
    throw new VideoProfileError(
      `Five answers are needed -- gender, age, skin tone, demographic appearance, attire -- ` +
        `and ${parts.length} ${parts.length === 1 ? 'was' : 'were'} given. Answer in that order, ` +
        'separated by commas, e.g. "2, 3, 3, 1, 4" or "female, 30-40, medium, north indian, saree".',
    );
  }

  const [g, a, s, d, at] = parts as [string, string, string, string, string];

  const gender = resolveChoice(g, GENDER_CHOICES);
  if (!gender) throw new VideoProfileError(optionError('gender', g, GENDER_CHOICES));

  const age_range = resolveChoice(a, AGE_CHOICES);
  if (!age_range) throw new VideoProfileError(optionError('age', a, AGE_CHOICES));

  const skin_tone = resolveChoice(s, SKIN_TONE_CHOICES);
  if (!skin_tone) throw new VideoProfileError(optionError('skin tone', s, SKIN_TONE_CHOICES));

  const demographic = resolveChoice(d, DEMOGRAPHIC_CHOICES);
  if (!demographic) {
    throw new VideoProfileError(optionError('demographic appearance', d, DEMOGRAPHIC_CHOICES));
  }

  const choices = attireChoices(gender);
  const attire = resolveChoice(at, choices);
  if (!attire) {
    throw new VideoProfileError(
      optionError(`attire (the ${gender} list)`, at, choices),
    );
  }

  return { gender, age_range, skin_tone, demographic, attire };
}

function optionError<T extends string>(field: string, given: string, choices: Choice<T>[]): string {
  return (
    `"${given}" is not one of the ${field} options. Answer with a number from 1 to ` +
    `${choices.length}, or the name: ${choices.map((c, i) => `${i + 1} ${c.label}`).join(', ')}.`
  );
}

// ---------------------------------------------------------------------------
// The character lock
// ---------------------------------------------------------------------------

/**
 * The age clause, written without a pronoun.
 *
 * "A woman in her thirties" would read more naturally, but the clause is
 * concatenated after a gender word that the user chose, and a stated age band is
 * what the generator actually needs -- "aged 30 to 40" is less ambiguous to it
 * than "in her thirties" and stays correct however the sentence is assembled.
 */
const AGE_WORDS: Record<AgeRange, string> = {
  '20-25': 'aged 20 to 25',
  '25-30': 'aged 25 to 30',
  '30-40': 'aged 30 to 40',
  '40-50': 'aged 40 to 50',
  '50+': 'aged 50 or older',
};

const SKIN_WORDS: Record<SkinTone, string> = {
  light: 'light skin',
  'light-medium': 'light-medium skin',
  'medium-wheatish': 'medium wheatish skin',
  'medium-deep': 'medium-deep skin',
  deep: 'deep skin',
};

const DEMOGRAPHIC_WORDS: Record<Demographic, string> = {
  'north-indian': 'North Indian features',
  'south-indian': 'South Indian features',
  'east-indian': 'East Indian features',
  'western-indian': 'Western Indian features',
  'pan-indian': 'neutral pan-Indian features',
};

/** Male and female attire read differently, so each has its own wording. */
const ATTIRE_WORDS: Record<Gender, Partial<Record<Attire, string>>> = {
  male: {
    'formal-shirt-trousers':
      'a crisp formal full-sleeved shirt and dark trousers, shirt tucked in, leather belt',
    'business-casual': 'a plain business-casual shirt with sleeves rolled once and chinos',
    'traditional-kurta-pajama': 'a plain cotton kurta with matching pajama and sandals',
    'semi-formal-kurta-jacket': 'a cotton kurta under a fitted Nehru jacket, with trousers',
    'field-work':
      'professional field clothing: a work shirt, sturdy trousers, closed shoes and a safety helmet where the setting calls for one',
    'topic-specific':
      'clothing appropriate to the subject being taught, chosen once and unchanged for the whole video',
  },
  female: {
    'formal-shirt-trousers': 'a crisp formal shirt and tailored dark trousers',
    'business-casual': 'a plain business-casual top and tailored trousers',
    'traditional-kurta-salwar': 'a plain cotton kurta with salwar and a matching dupatta',
    saree: 'a neatly draped cotton saree with a plain blouse',
    'semi-formal-kurta-jacket': 'a cotton kurta under a fitted jacket, with trousers',
    'field-work':
      'professional field clothing: a work shirt, sturdy trousers, closed shoes and a safety helmet where the setting calls for one',
    'topic-specific':
      'clothing appropriate to the subject being taught, chosen once and unchanged for the whole video',
  },
};

/**
 * Writes the presenter out, once.
 *
 * Every clause here is repeated verbatim into every scene prompt. That repetition
 * is the point and is not redundancy to be optimised away: it is the only thing
 * standing between a consistent presenter and six strangers.
 */
export function characterLock(profile: VideoProfile): CharacterLock {
  const genderWord = profile.gender === 'male' ? 'man' : 'woman';
  const attire =
    ATTIRE_WORDS[profile.gender][profile.attire] ??
    'clothing appropriate to the subject being taught, chosen once and unchanged for the whole video';

  const description =
    `An Indian ${genderWord} ${AGE_WORDS[profile.age_range]}, with ${SKIN_WORDS[profile.skin_tone]} ` +
    `and ${DEMOGRAPHIC_WORDS[profile.demographic]}, neatly groomed, warm and approachable, ` +
    'presenting as a professional instructor';

  const attire_description = `Wearing ${attire}.`;

  const voice_description =
    'Speaks Indian English with a natural Indian accent, clear articulation, warm and ' +
    'professional, unhurried and confident.';

  const consistency_clause =
    'Exactly the same person as in every other scene of this video: identical face, identical ' +
    'hairstyle, identical clothing, identical voice. Do not restyle, re-age or re-dress the ' +
    'presenter.';

  return { description, attire_description, voice_description, consistency_clause };
}

const ENVIRONMENT_DESCRIPTIONS: Record<Environment, string> = {
  'domestic-small-scale':
    'A small Indian domestic setting: a modest home yard or utility space with everyday household equipment, natural daylight',
  rural:
    'An Indian rural setting: open fields, farm equipment, mud or brick structures and village paths, natural daylight',
  'semi-urban':
    'An Indian semi-urban setting: low-rise buildings, a small market street or a modest institutional yard, natural daylight',
  'small-business':
    'A small Indian business workplace: a compact shop floor, workshop or office with real working equipment, mixed daylight and practical light',
  industrial:
    'An Indian industrial setting: plant equipment, pipework, tanks and safety signage, practical industrial lighting',
  'large-scale-professional':
    'A large-scale Indian professional setting: a spacious modern facility or corporate technical floor, clean and well lit',
  'factory-production':
    'An Indian factory production environment: a production line, machinery, material handling and safety markings, practical factory lighting',
};

export function environmentLock(environment: Environment): EnvironmentLock {
  const choice = ENVIRONMENT_CHOICES.find((c) => c.value === environment)!;
  return {
    id: environment,
    label: choice.label,
    description: ENVIRONMENT_DESCRIPTIONS[environment],
    adaptation_note:
      'This is the primary setting. A scene may move to a different visual within the same world ' +
      'when the teaching needs it -- a close-up of equipment, a labelled diagram over the setting, ' +
      'a different part of the same premises. It may not move to an unrelated place, and the ' +
      'presenter and their clothing never change.',
  };
}

// ---------------------------------------------------------------------------
// Storage: one saved profile, reused until changed
// ---------------------------------------------------------------------------

/**
 * There is one profile, not one per subject.
 *
 * A learner moving between modules of a course should meet the same instructor,
 * and an operator who has answered these questions once should not answer them
 * again. Should per-course presenters ever be wanted, this is the row to key
 * differently -- nothing above depends on there being only one.
 */
const PROFILE_ID = 'default';

interface ProfileRow {
  gender: string;
  age_range: string;
  skin_tone: string;
  demographic: string;
  attire: string;
  environment: string;
  created_at: string;
  updated_at: string;
}

function isValid(row: ProfileRow): boolean {
  return (
    (GENDERS as readonly string[]).includes(row.gender) &&
    (AGE_RANGES as readonly string[]).includes(row.age_range) &&
    (SKIN_TONES as readonly string[]).includes(row.skin_tone) &&
    (DEMOGRAPHICS as readonly string[]).includes(row.demographic) &&
    (ATTIRES as readonly string[]).includes(row.attire) &&
    (ENVIRONMENTS as readonly string[]).includes(row.environment)
  );
}

export function getSavedProfile(): VideoProfile | undefined {
  const row = getDb()
    .prepare(
      'SELECT gender, age_range, skin_tone, demographic, attire, environment, created_at, updated_at ' +
        'FROM video_profiles WHERE profile_id = ?',
    )
    .get(PROFILE_ID) as ProfileRow | undefined;
  if (!row) return undefined;
  // A saved profile written before an option list changed is discarded rather
  // than repaired: re-asking six questions is cheaper than a video built on a
  // value nothing understands any more.
  if (!isValid(row)) return undefined;
  return row as unknown as VideoProfile;
}

export function saveProfile(answers: CharacterAnswers & { environment: Environment }): VideoProfile {
  const now = nowIso();
  const existing = getSavedProfile();
  const profile: VideoProfile = {
    ...answers,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  getDb()
    .prepare(
      `INSERT INTO video_profiles
         (profile_id, gender, age_range, skin_tone, demographic, attire, environment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         gender = excluded.gender, age_range = excluded.age_range, skin_tone = excluded.skin_tone,
         demographic = excluded.demographic, attire = excluded.attire,
         environment = excluded.environment, updated_at = excluded.updated_at`,
    )
    .run(
      PROFILE_ID,
      profile.gender,
      profile.age_range,
      profile.skin_tone,
      profile.demographic,
      profile.attire,
      profile.environment,
      profile.created_at,
      profile.updated_at,
    );
  return profile;
}

/** Reads the profile back as the labels the user picked, for showing them. */
export function describeProfile(profile: VideoProfile): Record<string, string> {
  const label = <T extends string>(choices: Choice<T>[], value: T) =>
    choices.find((c) => c.value === value)?.label ?? value;
  return {
    gender: label(GENDER_CHOICES, profile.gender),
    age: label(AGE_CHOICES, profile.age_range),
    skin_tone: label(SKIN_TONE_CHOICES, profile.skin_tone),
    demographic_appearance: label(DEMOGRAPHIC_CHOICES, profile.demographic),
    attire: label(attireChoices(profile.gender), profile.attire),
    background_environment: label(ENVIRONMENT_CHOICES, profile.environment),
  };
}
