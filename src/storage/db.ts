/**
 * Persistence, on Node's built-in SQLite.
 *
 * node:sqlite is used rather than better-sqlite3 so the server needs no native
 * compilation step -- it installs and runs on Windows with `npm install` alone,
 * which matters for a local Antigravity setup.
 *
 * Retrieval uses SQLite's FTS5 with its built-in bm25() ranking. That keeps
 * search deterministic and reproducible with no model and no network: the same
 * query against the same corpus always returns the same ranked chunks.
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { config } from '../util/config.js';

/**
 * `node:sqlite` is loaded through Node's own require rather than a static import.
 *
 * Vite (and therefore Vitest) does not yet list `node:sqlite` among Node's
 * builtins, so a static import gets rewritten to a bare `sqlite` specifier and
 * fails to resolve under the test runner. Going through createRequire keeps the
 * specifier opaque to the bundler while remaining a normal builtin load at
 * runtime. The type-only import above still gives full type checking.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

export type Db = DatabaseSyncType;

// 3: chunking now merges wrapped headings and ignores module-opener unit indexes,
//    so the derived chunk table must be rebuilt from the PDFs.
// 4: a course may now hold many documents of one type. CDR courses carry nine
//    reference documents plus a master file, so document_type alone no longer
//    identifies a document and doc_key does.
const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  course_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  qp_code     TEXT NOT NULL,
  nsqf_level  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'registered',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS course_documents (
  doc_id              TEXT PRIMARY KEY,
  course_id           TEXT NOT NULL REFERENCES courses(course_id),
  document_type       TEXT NOT NULL
                        CHECK (document_type IN ('QP','PH','FG','TIMING','REF','MASTER')),
  -- Identifies one document within its course. A handbook course has one
  -- document per type and uses the type as the key; a CDR course has nine
  -- REF documents and needs a key that tells them apart.
  doc_key             TEXT NOT NULL,
  file_path           TEXT NOT NULL,
  checksum            TEXT NOT NULL,
  page_count          INTEGER NOT NULL,
  printed_page_offset INTEGER,
  chunk_count         INTEGER NOT NULL DEFAULT 0,
  ingested_at         TEXT NOT NULL,
  UNIQUE (course_id, doc_key)
);

-- One row per retrievable chunk. Metadata here is what enforces course and
-- chapter isolation at query time; the FTS index below holds only text.
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id      TEXT PRIMARY KEY,
  course_id     TEXT NOT NULL,
  document_type TEXT NOT NULL,
  doc_id        TEXT NOT NULL REFERENCES course_documents(doc_id),
  pdf_page      INTEGER NOT NULL,
  printed_page  INTEGER,
  -- Denormalised from course_documents so retrieval can scope to a document
  -- without a join on the hot path.
  doc_key       TEXT NOT NULL DEFAULT '',
  chapter       INTEGER,
  unit_code     TEXT,
  nos_code      TEXT,
  section       TEXT NOT NULL,
  subsection    TEXT,
  content       TEXT NOT NULL,
  char_count    INTEGER NOT NULL,
  ordinal       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_scope   ON chunks(course_id, document_type, chapter);
CREATE INDEX IF NOT EXISTS idx_chunks_dockey  ON chunks(course_id, doc_key);
CREATE INDEX IF NOT EXISTS idx_chunks_unit    ON chunks(course_id, unit_code);
CREATE INDEX IF NOT EXISTS idx_chunks_nos     ON chunks(course_id, nos_code);
CREATE INDEX IF NOT EXISTS idx_chunks_page    ON chunks(course_id, document_type, pdf_page);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  section,
  chunk_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS storyboard_artifacts (
  artifact_id      TEXT PRIMARY KEY,
  course_id        TEXT NOT NULL REFERENCES courses(course_id),
  template_version TEXT NOT NULL,
  timing_strategy  TEXT NOT NULL,
  current_version  INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'draft',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storyboard_versions (
  artifact_id TEXT NOT NULL REFERENCES storyboard_artifacts(artifact_id),
  version     INTEGER NOT NULL,
  state_json  TEXT NOT NULL,
  docx_path   TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE IF NOT EXISTS storyboard_changes (
  change_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL REFERENCES storyboard_artifacts(artifact_id),
  version     INTEGER NOT NULL,
  target_json TEXT NOT NULL,
  field       TEXT,
  change_type TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  reason      TEXT,
  sources_json TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_changes_artifact ON storyboard_changes(artifact_id, version);

-- Video transcripts. Separate from storyboard artifacts rather than a variant of
-- them: the two share no structure, no timing source and no output format, and
-- keeping them apart is what stops one flow's rules leaking into the other.
CREATE TABLE IF NOT EXISTS video_transcripts (
  transcript_id     TEXT PRIMARY KEY,
  course_id         TEXT NOT NULL,
  subject_id        TEXT,
  unit_code         TEXT NOT NULL,
  unit_title        TEXT NOT NULL,
  requested_seconds INTEGER NOT NULL,
  words_per_minute  INTEGER NOT NULL,
  current_version   INTEGER NOT NULL DEFAULT 1,
  state_json        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_transcript_versions (
  transcript_id TEXT NOT NULL REFERENCES video_transcripts(transcript_id),
  version       INTEGER NOT NULL,
  state_json    TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (transcript_id, version)
);

CREATE INDEX IF NOT EXISTS idx_video_scope ON video_transcripts(course_id, unit_code);

-- Module content packages: the 3-minute video and 9-minute deck for one handbook
-- module, planned and versioned together because they share one coverage
-- requirement -- between them they must cover every unit of that module.
CREATE TABLE IF NOT EXISTS module_packages (
  package_id      TEXT PRIMARY KEY,
  course_id       TEXT NOT NULL,
  subject_id      TEXT,
  module_number   INTEGER NOT NULL,
  module_title    TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  state_json      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS module_package_versions (
  package_id TEXT NOT NULL REFERENCES module_packages(package_id),
  version    INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (package_id, version)
);

CREATE INDEX IF NOT EXISTS idx_module_packages_scope ON module_packages(course_id, module_number);

-- The presenter and narrator a subject has settled on. A learner taking two modules
-- of one subject should meet the same person, so the first module to choose fixes
-- it and the rest reuse it.
CREATE TABLE IF NOT EXISTS subject_characters (
  course_id        TEXT PRIMARY KEY,
  protagonist_json TEXT NOT NULL,
  narrator_json    TEXT NOT NULL,
  established_by   TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Guided-flow state. Persisted rather than held in memory so a session survives a
-- server restart, and so the flow a session is in is a recorded fact -- which is
-- what keeps the three flows from being mixed.
CREATE TABLE IF NOT EXISTS flow_sessions (
  session_id TEXT PRIMARY KEY,
  flow       TEXT,
  step       TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

let instance: Db | undefined;

/**
 * Rebuilds the derived retrieval index when the schema moves on.
 *
 * Only chunk tables are dropped. They are wholly derived from the source PDFs and
 * can be rebuilt by re-ingesting, whereas artifacts and version history cannot be
 * regenerated and are never touched here.
 */
const META_TABLE = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

function migrate(db: Db): void {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const found = row ? Number(row.value) : 0;
  if (found === 0 || found === SCHEMA_VERSION) return;

  if (found < SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS chunks_fts');
    db.exec('DROP TABLE IF EXISTS chunks');
    // course_documents gained a column and lost a uniqueness constraint, so it is
    // rebuilt rather than emptied. Both tables are derived from the PDFs on disk;
    // dropping them costs an ingestion, not any authored content.
    db.exec('DROP TABLE IF EXISTS course_documents');
  }
}

export function openDb(dbPath: string = config.paths.db): Db {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // WAL keeps readers from blocking the writer; foreign keys are off by default
  // in SQLite and the schema relies on them.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Migration has to run before the full schema is applied: a new index or column
  // in SCHEMA would otherwise be created against the previous table definition
  // and fail.
  db.exec(META_TABLE);
  migrate(db);
  db.exec(SCHEMA);

  db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
  return db;
}

/** Process-wide handle. The MCP server is single-process and single-writer. */
export function getDb(): Db {
  if (!instance) instance = openDb();
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = undefined;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Runs `fn` inside a transaction, rolling back on throw.
 *
 * Version writes touch three tables; a partial write would leave an artifact
 * whose current_version points at a version row that does not exist.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
