import { config as loadDotenv } from 'dotenv';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

loadDotenv();

/**
 * Configuration for the deterministic tool layer.
 *
 * There is no LLM or AI-credential section here by design. This server executes
 * operations and returns structured results; the connected client supplies all
 * reasoning and generated content. If a future change appears to need a model
 * key here, the operation belongs on the client side instead.
 */

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${key} must be a number, got "${v}".`);
  return n;
}

/** Reads a boolean flag. Anything but "false"/"0" with the key present is true. */
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(v.toLowerCase());
}

const root = process.cwd();
const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(root, p));

export const config = {
  paths: {
    root,
    db: abs(str('DB_PATH', './data/storyboard.db')),
    artifacts: abs(str('ARTIFACT_DIR', './artifacts')),
    courses: abs(str('COURSE_DIR', './courses')),
    templates: abs(str('TEMPLATE_DIR', './templates')),
  },
  chunking: {
    targetChars: num('CHUNK_TARGET_CHARS', 1400),
    overlapChars: num('CHUNK_OVERLAP_CHARS', 200),
  },
  search: {
    defaultLimit: num('SEARCH_DEFAULT_LIMIT', 8),
    maxLimit: num('SEARCH_MAX_LIMIT', 50),
    /**
     * Chunks attached to one module's work order, per unit of that module.
     *
     * A Part A row is a unit and is written about that unit, so each unit gets its
     * own slice: coverage is then guaranteed per row, and the total scales with how
     * many units a module has rather than with how long its chapter is.
     */
    moduleChunksPerUnit: num('MODULE_CHUNKS_PER_UNIT', 6),
    /**
     * Extra chunks of module-wide context, on top of the per-unit slices.
     *
     * The chapter's opening pages and the Facilitator Guide's notes carry no unit
     * code, and they are what Part A activities and Part C scripts draw on.
     */
    moduleContextChunks: num('MODULE_CONTEXT_CHUNKS', 10),
    maxScopeChunks: num('MAX_SCOPE_CHUNKS', 400),
  },
  assessment: {
    // The reference template runs ten questions per module.
    questionsPerModule: num('ASSESSMENT_QUESTIONS_PER_MODULE', 10),
    /**
     * Glossary lines each module contributes.
     *
     * The glossary is one list at the end of the document, but it is gathered a
     * module at a time so every term is written from the sources that use it. Six
     * modules at eight terms each is a glossary of around fifty, less duplicates.
     */
    glossaryTermsPerModule: num('GLOSSARY_TERMS_PER_MODULE', 8),
  },
  grounding: {
    minOverlap: num('GROUNDING_MIN_OVERLAP', 0.35),
    minTokenLength: num('GROUNDING_MIN_TOKEN_LENGTH', 4),
  },
  render: {
    /**
     * Hand the finished .docx to Word once so its table of contents holds real
     * page numbers.
     *
     * Page numbers cannot be computed without laying the document out, so the
     * renderer emits the field with an empty cached result and Word resolves it.
     * Doing that at generation time is what makes the numbers visible in viewers
     * that show cached results rather than resolving fields. Turn it off where
     * Word is absent or the extra seconds per render are unwelcome -- the
     * document is correct either way.
     */
    refreshFields: bool('REFRESH_FIELDS', true),
  },
  logLevel: str('LOG_LEVEL', 'info'),
} as const;

/**
 * Where course directories live.
 *
 * Resolving a *particular* course to its directory is courses/course-config.ts's
 * job, because that is what knows a course's directory aliases. This module stays
 * a leaf that only reads configuration.
 */
export function coursesRoot(): string {
  return config.paths.courses;
}

/**
 * The storyboard template for a track.
 *
 * Each track has its own template directory, because the three tracks' documents
 * genuinely differ -- the Entrepreneur template carries no Instructional Design
 * guidelines section, for instance -- and rendering one to another's template
 * would change the document's structure, not just its wording.
 *
 * The directory is read rather than a fixed filename, so a template can be
 * dropped in under whatever name it arrives with. Exactly one .docx per directory
 * is expected; more than one is ambiguous and is refused rather than guessed at.
 */
export function templateFile(track: string): string {
  const dir = path.join(config.paths.templates, track);
  if (!existsSync(dir)) {
    throw new Error(
      `No storyboard template directory for track "${track}". Expected ${dir} holding one .docx.`,
    );
  }
  const candidates = readdirSync(dir).filter(
    (f) => f.toLowerCase().endsWith('.docx') && !f.startsWith('~$'),
  );
  const exact = candidates.find((f) => f === 'storyboard-template.docx');
  if (exact) return path.join(dir, exact);
  if (candidates.length === 1) return path.join(dir, candidates[0]!);
  if (candidates.length === 0) {
    throw new Error(`No .docx storyboard template in ${dir}. Place the track's template there.`);
  }
  throw new Error(
    `${dir} holds ${candidates.length} .docx files (${candidates.join(', ')}), so the template ` +
      'is ambiguous. Keep one, or name the intended one storyboard-template.docx.',
  );
}
