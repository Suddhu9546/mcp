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
// 5: the FTS table carries an indexed `scope` column, so course, document and
//    chapter scoping happens inside the index rather than as a filter applied to
//    its output. Existing rows have no scope text and would match nothing, so the
//    chunk tables are rebuilt.
// 6: the ad-hoc single-unit transcript feature and its two tables are gone.
const SCHEMA_VERSION = 6;

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

-- The scope column holds the chunk's course, document, chapter and unit as
-- opaque tokens (see documents/scope-tokens.ts). Scoping is ANDed into the MATCH
-- expression so SQLite intersects postings lists and visits only in-scope
-- chunks, instead of ranking the whole corpus and discarding what a WHERE clause
-- then rejects. It is weighted 0 in bm25() so it orders nothing.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  section,
  scope,
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
  -- What the sources looked like when this storyboard was written, so that
  -- reusing it can say whether they have moved since. Null for artifacts created
  -- before the check existed; see storage/source-fingerprint.ts.
  source_fingerprint TEXT,
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

-- The video script feature. Three tables and nothing shared with the storyboard:
-- the two features have no common state, and giving them common tables is how a
-- change to one silently becomes a change to the other.

-- The saved presenter and setting. One row: a learner moving between modules of a
-- course should meet the same instructor, and an operator should answer the six
-- configuration questions once rather than before every video.
CREATE TABLE IF NOT EXISTS video_profiles (
  profile_id  TEXT PRIMARY KEY,
  gender      TEXT NOT NULL,
  age_range   TEXT NOT NULL,
  skin_tone   TEXT NOT NULL,
  demographic TEXT NOT NULL,
  attire      TEXT NOT NULL,
  environment TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- One script per module per video type. Keyed that way rather than created per
-- request, so answering the flow twice for the same module continues the script
-- that exists instead of leaving an empty row behind each time.
CREATE TABLE IF NOT EXISTS video_scripts (
  script_id       TEXT PRIMARY KEY,
  course_id       TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  module_number   INTEGER NOT NULL,
  module_title    TEXT NOT NULL,
  video_type      TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  state_json      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_scripts_scope
  ON video_scripts(course_id, module_number, video_type);

CREATE TABLE IF NOT EXISTS video_script_versions (
  script_id  TEXT NOT NULL REFERENCES video_scripts(script_id),
  version    INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (script_id, version)
);

-- Guided-flow state. Persisted rather than held in memory so a session survives a
-- server restart, and so the flow a session is in is a recorded fact -- which is
-- what keeps the two flows from being mixed.
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

/**
 * Adds a column to an existing table, if it is not already there.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
 * exists, and artifacts are the one thing migration may never drop and rebuild --
 * they hold authored content that no amount of re-ingesting brings back. So a new
 * artifact column is added in place, idempotently, and is checked on every open
 * rather than gated on the schema version: a database at the current version may
 * still predate the column.
 */
function addColumnIfMissing(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (columns.length === 0) return; // table does not exist yet; SCHEMA will create it
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Tables left behind by a removed feature.
 *
 * Dropped on every open rather than behind a schema version, because a database
 * written before the feature was removed is still at the current version and would
 * otherwise keep the tables forever. They hold nothing any code reads, so keeping
 * them only makes "what does this database contain" a misleading question.
 */
const REMOVED_TABLES = [
  'module_package_versions',
  'module_packages',
  'subject_characters',
  'video_transcript_versions',
  'video_transcripts',
];

/**
 * Video types that no longer exist.
 *
 * A script is keyed on its video type, so renaming a type strands every row
 * written under the old name: nothing reads them, nothing can reach them, and
 * they still appear in list_video_scripts as though they were work in progress.
 * They are deleted on open for the same reason the removed tables are.
 */
const RETIRED_VIDEO_TYPES = ['info_1_1_5_min'];

function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

function migrate(db: Db): void {
  addColumnIfMissing(db, 'storyboard_artifacts', 'source_fingerprint', 'TEXT');
  db.exec('DROP INDEX IF EXISTS idx_module_packages_scope');
  for (const table of REMOVED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);

  // Guarded on the table existing: migrate() runs before SCHEMA, so on a fresh
  // database there is nothing here yet and nothing to clean.
  if (tableExists(db, 'video_scripts')) {
    for (const type of RETIRED_VIDEO_TYPES) {
      db.prepare(
        'DELETE FROM video_script_versions WHERE script_id IN ' +
          '(SELECT script_id FROM video_scripts WHERE video_type = ?)',
      ).run(type);
      db.prepare('DELETE FROM video_scripts WHERE video_type = ?').run(type);
    }
  }

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
