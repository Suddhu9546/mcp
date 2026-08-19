import { config as loadDotenv } from 'dotenv';
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
  },
  assessment: {
    // The reference template runs ten questions per module.
    questionsPerModule: num('ASSESSMENT_QUESTIONS_PER_MODULE', 10),
  },
  grounding: {
    minOverlap: num('GROUNDING_MIN_OVERLAP', 0.35),
    minTokenLength: num('GROUNDING_MIN_TOKEN_LENGTH', 4),
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

export function templateFile(version = 'v1'): string {
  return path.join(config.paths.templates, `storyboard-template-${version}.docx`);
}
