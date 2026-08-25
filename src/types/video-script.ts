/**
 * Types for the 2.5-3 minute AI info video script.
 *
 * The feature has one job: turn one Participant Handbook module into an
 * educational introduction a learner watches before the module itself. Two and a
 * half to three minutes is long enough to introduce the whole module -- every
 * learning area named and given something concrete -- rather than tease it. It is
 * not a film. The topic is the hero and the presenter is a teacher, so nothing
 * here models plot, character arc or drama; what it models is a fixed teaching
 * structure, a locked presenter, and a word budget per scene.
 *
 * The same division of responsibility as everywhere else in this server applies,
 * and it is what the two halves of a scene express:
 *
 *   planned    scene count, seconds, timecodes, word band, educational role, and
 *              the handbook text allocated to the scene. Computed here, read-only.
 *   authored   purpose, visuals, camera, narration. Only the client can write it.
 *
 * The finished AI video-generation prompt belongs to neither half: it is composed
 * by the server from the authored fields plus the locked presenter, environment,
 * pace, pause and audio-accuracy blocks. Composing it here rather than asking the
 * client to repeat those blocks eighteen times is what makes the presenter provably
 * identical in every scene -- the one thing a viewer notices immediately when it
 * is wrong.
 */

/** The only video type implemented. The 15-minute unit video is a separate build. */
export const VIDEO_TYPE_INFO = 'info_2_5_3_min' as const;
export type VideoType = typeof VIDEO_TYPE_INFO;

// ---------------------------------------------------------------------------
// Duration and pace
// ---------------------------------------------------------------------------

/**
 * The shape of the video, and why it is the only shape that satisfies the rules.
 *
 * Four constraints are fixed and together they leave nothing to choose:
 *
 *   the video runs 2.5-3 minutes          150-180 seconds
 *   no scene runs longer than 10 seconds
 *   every scene's narration is 22-25 words
 *   a sentence never crosses a scene boundary
 *
 * A scene shorter than ten seconds cannot hold twenty-two words, so every scene is
 * exactly ten seconds; 150-180 seconds of ten-second scenes is 15-18 of them. That
 * is what makes this a complete module introduction rather than a teaser: with a
 * six-scene frame there are nine to twelve scenes left for the units, so each unit
 * gets two or three of its own instead of a share of one.
 */
export const SCENE_SECONDS = 10;
export const MIN_TOTAL_SECONDS = 150;
export const MAX_TOTAL_SECONDS = 180;
export const MIN_SCENE_COUNT = 15;
export const MAX_SCENE_COUNT = 18;

/**
 * Words per scene: a band, not a rate.
 *
 * It used to be derived from the seconds. It is stated directly now because the
 * rule is stated directly -- every scene carries 22 to 25 words -- and because
 * every scene is the same length, so a rate would only ever produce this one band.
 *
 * The band and the ten seconds together fix the delivery pace, and it is faster
 * than the pace the first brief asked for: twenty-two words spoken inside ten
 * seconds, with a breath between sentences and a beat of silence at the end, is
 * about 150 words a minute rather than 120-130. The word count and the scene
 * length are the mandatory rules, so the pace follows from them; asking a
 * generator for 130 wpm and 25 words in one clip would simply produce a clip whose
 * last words are cut off.
 */
export const WORDS_PER_SCENE_MIN = 22;
export const WORDS_PER_SCENE_MAX = 25;
export const WORDS_PER_SCENE_TARGET = 23;

export const SPEAKING_PACE =
  'about 150 words per minute -- measured and clearly articulated, never rushed, but with no ' +
  'dead air';

/** The generator must have the presenter talking almost at once, in every clip. */
export const SPEECH_LEAD_IN_SECONDS = '0.5-1 second';

/**
 * Breathing space.
 *
 * A ten-second clip holding twenty-odd words is not a wall of speech. There is a
 * short pause where one sentence ends and the next begins, and a beat of silence
 * before the cut -- without them consecutive clips run into each other and the
 * narration sounds like one unbroken take chopped up, which is exactly what it
 * must not sound like when every scene is generated separately.
 */
export const SENTENCE_PAUSE = 'a natural breath of about 0.3-0.5 seconds';
export const SCENE_END_PAUSE = 'about 0.5 seconds of silence';

/**
 * Sentences per scene.
 *
 * Twenty-two to twenty-five words is one long sentence or two short ones. Three is
 * the most that can be said in ten seconds while still pausing between them, and a
 * scene of four clauses has stopped being one idea.
 */
export const MAX_SENTENCES_PER_SCENE = 3;

// ---------------------------------------------------------------------------
// The video profile: how the presenter looks, and where they are
// ---------------------------------------------------------------------------

export const GENDERS = ['male', 'female'] as const;
export type Gender = (typeof GENDERS)[number];

export const AGE_RANGES = ['20-25', '25-30', '30-40', '40-50', '50+'] as const;
export type AgeRange = (typeof AGE_RANGES)[number];

export const SKIN_TONES = ['light', 'light-medium', 'medium-wheatish', 'medium-deep', 'deep'] as const;
export type SkinTone = (typeof SKIN_TONES)[number];

export const DEMOGRAPHICS = [
  'north-indian',
  'south-indian',
  'east-indian',
  'western-indian',
  'pan-indian',
] as const;
export type Demographic = (typeof DEMOGRAPHICS)[number];

/** Attire ids. Which are offered depends on gender; see profile.ts. */
export const ATTIRES = [
  'formal-shirt-trousers',
  'business-casual',
  'traditional-kurta-pajama',
  'traditional-kurta-salwar',
  'saree',
  'semi-formal-kurta-jacket',
  'field-work',
  'topic-specific',
] as const;
export type Attire = (typeof ATTIRES)[number];

export const ENVIRONMENTS = [
  'domestic-small-scale',
  'rural',
  'semi-urban',
  'small-business',
  'industrial',
  'large-scale-professional',
  'factory-production',
] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * What the user chose about presentation, saved and reused.
 *
 * Everything here is presentation. Nothing here may influence what is taught --
 * that comes from the handbook alone.
 */
export interface VideoProfile {
  gender: Gender;
  age_range: AgeRange;
  skin_tone: SkinTone;
  demographic: Demographic;
  attire: Attire;
  environment: Environment;
  created_at: string;
  updated_at: string;
}

/**
 * The presenter, written out once and repeated into every scene prompt.
 *
 * A generator producing each clip separately remembers nothing between calls, so
 * a presenter who is described afresh each time comes out as a different person.
 * This is the one description, derived from the profile and never re-worded.
 */
export interface CharacterLock {
  /** One sentence naming every fixed physical attribute. */
  description: string;
  attire_description: string;
  voice_description: string;
  /** The clause appended to every prompt to hold the presenter steady. */
  consistency_clause: string;
}

export interface EnvironmentLock {
  id: Environment;
  label: string;
  /** The setting as the generator should render it. */
  description: string;
  /** How far a scene may move from it when the teaching needs a different visual. */
  adaptation_note: string;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * What a scene is for, educationally.
 *
 * Fixed by the structure, not chosen per module: an info video opens, says what
 * the topic is and why it matters, turns to what will be learned, walks the key
 * areas, and hands over to the module. The roadmap scenes are the only ones whose
 * number varies, and they vary with how many units the module has.
 */
export type SceneRole =
  | 'opening'
  | 'topic_introduction'
  | 'learning_transition'
  | 'roadmap'
  | 'consolidation'
  | 'closing';

export interface UnitCoverage {
  unit_code: string;
  unit_title: string;
  /** Which slice of the unit this scene covers, e.g. "2 of 3". */
  portion: string;
  chunk_ids: string[];
  pdf_pages: number[];
  /** Opening of the allocated handbook text. The whole of it is in `source_text`. */
  source_excerpt: string;
  source_word_count: number;
}

export interface PlannedScene {
  scene_number: number;
  scene_id: string;
  role: SceneRole;
  /** What this scene must accomplish. Fixed by the structure. */
  educational_purpose: string;
  /** Direction specific to this role, e.g. the greeting rule on scene 1. */
  role_direction: string;
  seconds: number;
  start_seconds: number;
  end_seconds: number;
  start_timecode: string;
  end_timecode: string;
  target_words: number;
  min_words: number;
  max_words: number;
  /** Empty on the framing scenes; a roadmap scene carries one slice of one unit. */
  units: UnitCoverage[];
  /** The exact handbook text this scene must be built from. */
  source_text: string;
  /** Chunk ids this scene may cite. Empty means the module-wide set applies. */
  citable_chunk_ids: string[];
}

export interface VideoScriptPlan {
  course_id: string;
  subject_id: string;
  subject_label: string;
  track: string;
  track_label: string;
  module_number: number;
  module_title: string;
  video_type: VideoType;
  video_type_label: string;
  scene_count: number;
  scene_seconds: number;
  total_seconds: number;
  total_target_words: number;
  words_per_scene: { target: number; min: number; max: number };
  speaking_pace: string;
  /** The pauses that keep consecutive ten-second clips from running together. */
  breathing: { between_sentences: string; end_of_scene: string; max_sentences: number };
  profile: VideoProfile;
  character: CharacterLock;
  environment: EnvironmentLock;
  /** Every unit of the module, in handbook order, with where it is covered. */
  module_units: { unit_code: string; unit_title: string; scenes: number[] }[];
  scenes: PlannedScene[];
  /** Advisory when the module holds too little text for its teaching scenes. */
  coverage_note?: string;
}

// ---------------------------------------------------------------------------
// The authored half
// ---------------------------------------------------------------------------

/**
 * One scene as the client writes it.
 *
 * Deliberately small. Everything a generator needs that does not change between
 * scenes -- who the presenter is, what they wear, how they sound, how fast they
 * speak, that each line is spoken exactly once -- is added by the server, so the
 * client writes only what is genuinely per-scene.
 */
export interface AuthoredScene {
  scene_number: number;
  /** Why this scene exists, in the writer's words. Must serve the planned role. */
  educational_purpose: string;
  /** Where this scene happens, within or adapted from the chosen environment. */
  location: string;
  /** What is on screen: the presenter, the setting, and the teaching visual. */
  visual_description: string;
  /** What the presenter does. Teaching action only -- no invented incident. */
  character_action: string;
  /** e.g. "medium shot, presenter centre-left, chest up". */
  camera_framing: string;
  /** e.g. "slow push in", "locked off". */
  camera_movement: string;
  /**
   * The concrete things shown to explain the point: a labelled diagram, the
   * equipment, the formula, the standard. Empty only where the words alone teach.
   */
  educational_visual_elements: string[];
  /** What carries over from the previous scene, where continuity helps. */
  continuity?: string;
  /** The voiceover, word for word. Nothing else is spoken. */
  narration: string;
  /** Burned-on text. Short, and only where it reinforces the narration. */
  on_screen_text?: string;
  /** chunk_ids from this scene's allocation. Framing scenes may cite none. */
  sources: string[];
}

/** A scene as it is delivered: planned, authored, and the composed prompt. */
export interface FinalScene extends AuthoredScene {
  scene_id: string;
  role: SceneRole;
  seconds: number;
  start_timecode: string;
  end_timecode: string;
  narration_word_count: number;
  /** Composed by the server from the authored fields plus the locked blocks. */
  ai_video_prompt: string;
}

export interface VideoScriptState {
  script_id: string;
  course_id: string;
  subject_id: string;
  module_number: number;
  module_title: string;
  video_type: VideoType;
  version: number;
  plan: VideoScriptPlan;
  /** Empty until the client submits. */
  scenes: FinalScene[];
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type FindingSeverity = 'error' | 'warning';

export interface VideoScriptFinding {
  severity: FindingSeverity;
  /** Which check failed, e.g. "narration_fit". */
  check: string;
  scene_number?: number;
  message: string;
  /** What to do about it, where the fix is not obvious from the message. */
  fix?: string;
}

export interface VideoScriptValidation {
  script_id: string;
  version: number;
  passed: boolean;
  error_count: number;
  warning_count: number;
  checks: { name: string; passed: boolean; detail: string }[];
  findings: VideoScriptFinding[];
}
