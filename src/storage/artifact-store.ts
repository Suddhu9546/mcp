/**
 * Artifact and version storage.
 *
 * Every mutation creates a new version and never overwrites an old one
 * (INVARIANT 9). Rollback is itself a new version, so history is append-only and
 * always recoverable.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StoryboardState, StoryboardTarget } from '../types/storyboard.js';
import type { SourceRef } from '../types/source.js';
import type { TimingStrategy } from '../types/timing.js';
import { ensureCourseRegistered } from '../courses/course-manager.js';
import { getDb, nowIso, transaction } from './db.js';
import { config } from '../util/config.js';

export interface ArtifactRecord {
  artifact_id: string;
  course_id: string;
  template_version: string;
  timing_strategy: TimingStrategy;
  current_version: number;
  status: string;
  /** JSON SourceFingerprint, absent for artifacts created before the check. */
  source_fingerprint?: string;
  created_at: string;
  updated_at: string;
}

export interface VersionRecord {
  artifact_id: string;
  version: number;
  docx_path?: string;
  note?: string;
  created_at: string;
}

export interface ChangeRecord {
  change_id: number;
  artifact_id: string;
  version: number;
  target: StoryboardTarget | null;
  field?: string;
  change_type: string;
  old_value?: string;
  new_value?: string;
  reason?: string;
  sources: SourceRef[];
  created_at: string;
}

export interface ChangeInput {
  target: StoryboardTarget | null;
  field?: string;
  change_type: string;
  old_value?: string;
  new_value?: string;
  reason?: string;
  sources?: SourceRef[];
}

export class ArtifactNotFoundError extends Error {
  constructor(artifactId: string) {
    super(`No storyboard artifact "${artifactId}".`);
    this.name = 'ArtifactNotFoundError';
  }
}

export class VersionConflictError extends Error {
  constructor(artifactId: string, expected: number, actual: number) {
    super(
      `Version conflict on "${artifactId}": the patch targets base version ${expected} ` +
        `but the current version is ${actual}. Re-read the storyboard and reapply.`,
    );
    this.name = 'VersionConflictError';
  }
}

/**
 * Allocates the next artifact id, e.g. "SB-2026-00003".
 *
 * The counter is per calendar year and derived from existing rows inside the
 * caller's transaction, so two concurrent creates cannot collide.
 */
function nextArtifactId(): string {
  const year = new Date().getUTCFullYear();
  const prefix = `SB-${year}-`;
  const row = getDb()
    .prepare('SELECT artifact_id FROM storyboard_artifacts WHERE artifact_id LIKE ? ORDER BY artifact_id DESC LIMIT 1')
    .get(`${prefix}%`) as { artifact_id: string } | undefined;
  const last = row ? Number(row.artifact_id.slice(prefix.length)) : 0;
  return `${prefix}${String(last + 1).padStart(5, '0')}`;
}

export interface CreateArtifactInput {
  course_id: string;
  template_version: string;
  timing_strategy: TimingStrategy;
  state: StoryboardState;
  note?: string;
  /** JSON SourceFingerprint of the sources this storyboard is written against. */
  source_fingerprint?: string;
}

/** Creates an artifact and its version 1. */
export function createArtifact(input: CreateArtifactInput): ArtifactRecord {
  const db = getDb();
  return transaction(db, () => {
    // The course row is a foreign key target and may not exist yet if documents
    // have not been ingested in this database.
    ensureCourseRegistered(input.course_id);
    const artifactId = nextArtifactId();
    const ts = nowIso();
    const state: StoryboardState = { ...input.state, artifact_id: artifactId, version: 1 };

    db.prepare(
      `INSERT INTO storyboard_artifacts
         (artifact_id, course_id, template_version, timing_strategy, current_version, status,
          source_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'draft', ?, ?, ?)`,
    ).run(
      artifactId,
      input.course_id,
      input.template_version,
      input.timing_strategy,
      input.source_fingerprint ?? null,
      ts,
      ts,
    );

    db.prepare(
      'INSERT INTO storyboard_versions (artifact_id, version, state_json, note, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(artifactId, 1, JSON.stringify(state), input.note ?? 'Initial generation', ts);

    db.prepare(
      `INSERT INTO storyboard_changes (artifact_id, version, target_json, change_type, reason, created_at)
       VALUES (?, 1, 'null', 'created', ?, ?)`,
    ).run(artifactId, input.note ?? 'Initial generation', ts);

    return getArtifact(artifactId);
  });
}

export function getArtifact(artifactId: string): ArtifactRecord {
  const row = getDb()
    .prepare('SELECT * FROM storyboard_artifacts WHERE artifact_id = ?')
    .get(artifactId) as unknown as ArtifactRecord | undefined;
  if (!row) throw new ArtifactNotFoundError(artifactId);
  return row;
}

export function listArtifacts(courseId?: string): ArtifactRecord[] {
  const db = getDb();
  const rows = courseId
    ? db.prepare('SELECT * FROM storyboard_artifacts WHERE course_id = ? ORDER BY artifact_id').all(courseId)
    : db.prepare('SELECT * FROM storyboard_artifacts ORDER BY artifact_id').all();
  return rows as unknown as ArtifactRecord[];
}

/** Loads a state snapshot. Defaults to the current version. */
export function getState(artifactId: string, version?: number): StoryboardState {
  const artifact = getArtifact(artifactId);
  const v = version ?? artifact.current_version;
  const row = getDb()
    .prepare('SELECT state_json FROM storyboard_versions WHERE artifact_id = ? AND version = ?')
    .get(artifactId, v) as { state_json: string } | undefined;
  if (!row) throw new Error(`Artifact "${artifactId}" has no version ${v}.`);
  return JSON.parse(row.state_json) as StoryboardState;
}

export interface CommitInput {
  artifact_id: string;
  /** The version this edit was computed against. Rejected if it is not current. */
  base_version: number;
  state: StoryboardState;
  changes: readonly ChangeInput[];
  note?: string;
}

/**
 * Writes a new version.
 *
 * `base_version` is checked against the current version so an edit computed from
 * a stale read cannot silently overwrite a newer one.
 */
export function commitVersion(input: CommitInput): { version: number; artifact: ArtifactRecord } {
  const db = getDb();
  return transaction(db, () => {
    const artifact = getArtifact(input.artifact_id);
    if (artifact.current_version !== input.base_version) {
      throw new VersionConflictError(input.artifact_id, input.base_version, artifact.current_version);
    }

    const version = artifact.current_version + 1;
    const ts = nowIso();
    const state: StoryboardState = { ...input.state, artifact_id: input.artifact_id, version };

    db.prepare(
      'INSERT INTO storyboard_versions (artifact_id, version, state_json, note, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(input.artifact_id, version, JSON.stringify(state), input.note ?? null, ts);

    const insertChange = db.prepare(
      `INSERT INTO storyboard_changes
         (artifact_id, version, target_json, field, change_type, old_value, new_value, reason, sources_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of input.changes) {
      insertChange.run(
        input.artifact_id,
        version,
        JSON.stringify(c.target),
        c.field ?? null,
        c.change_type,
        c.old_value ?? null,
        c.new_value ?? null,
        c.reason ?? null,
        c.sources ? JSON.stringify(c.sources) : null,
        ts,
      );
    }

    db.prepare(
      'UPDATE storyboard_artifacts SET current_version = ?, updated_at = ? WHERE artifact_id = ?',
    ).run(version, ts, input.artifact_id);

    return { version, artifact: getArtifact(input.artifact_id) };
  });
}

/** Records the rendered .docx for a version. */
/**
 * Writes the rendered storyboard to disk and records it against the version.
 *
 * One folder per course, holding one file: the storyboard as it currently stands.
 * Previously the folder was named for the artifact and the file for the version,
 * so every draft of a course made a new folder and every render added a file --
 * a subject rebuilt a few times left a dozen directories, and picking the finished
 * document out of them meant knowing which artifact id and which version number
 * were the real ones.
 *
 * The version history is unaffected: it lives in the database, which is where it
 * is queryable. What is on disk is the deliverable, and there is exactly one of it.
 */
/** "20260823-174412", for a filename that sorts chronologically. */
function fileStamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * Writes a rendered document and records its path against the version.
 *
 * Every render is kept. Earlier versions of this function deleted the other .docx
 * files in the folder so that only one candidate document existed, which read as
 * tidiness but meant a delivered document could not be produced again: the render
 * that replaced it left the older version's `docx_path` pointing at a file that
 * was gone. A storyboard that someone has been sent is not a draft any more, and
 * deleting it is not this function's decision to make.
 *
 * The name carries both the version and the moment: the version says which content
 * this is, and the timestamp distinguishes two renders of that same content -- for
 * instance the same storyboard before and after a template change.
 */
export function attachDocx(artifactId: string, version: number, bytes: Uint8Array): string {
  const { course_id } = getArtifact(artifactId);
  const dir = path.join(config.paths.artifacts, course_id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `${course_id}-storyboard-${artifactId}-v${version}-${fileStamp(new Date())}.docx`,
  );

  writeFileSync(file, bytes);
  getDb()
    .prepare('UPDATE storyboard_versions SET docx_path = ? WHERE artifact_id = ? AND version = ?')
    .run(file, artifactId, version);
  return file;
}

export function listVersions(artifactId: string): VersionRecord[] {
  getArtifact(artifactId);
  const rows = getDb()
    .prepare('SELECT artifact_id, version, docx_path, note, created_at FROM storyboard_versions WHERE artifact_id = ? ORDER BY version')
    .all(artifactId) as unknown as { artifact_id: string; version: number; docx_path: string | null; note: string | null; created_at: string }[];
  return rows.map((r) => ({
    artifact_id: r.artifact_id,
    version: r.version,
    ...(r.docx_path !== null ? { docx_path: r.docx_path } : {}),
    ...(r.note !== null ? { note: r.note } : {}),
    created_at: r.created_at,
  }));
}

/** Change log, optionally narrowed to a version range. */
export function listChanges(artifactId: string, fromVersion?: number, toVersion?: number): ChangeRecord[] {
  getArtifact(artifactId);
  const params: (string | number)[] = [artifactId];
  let sql = 'SELECT * FROM storyboard_changes WHERE artifact_id = ?';
  if (fromVersion !== undefined) {
    sql += ' AND version >= ?';
    params.push(fromVersion);
  }
  if (toVersion !== undefined) {
    sql += ' AND version <= ?';
    params.push(toVersion);
  }
  sql += ' ORDER BY version, change_id';

  const rows = getDb().prepare(sql).all(...params) as unknown as {
    change_id: number;
    artifact_id: string;
    version: number;
    target_json: string;
    field: string | null;
    change_type: string;
    old_value: string | null;
    new_value: string | null;
    reason: string | null;
    sources_json: string | null;
    created_at: string;
  }[];

  return rows.map((r) => ({
    change_id: r.change_id,
    artifact_id: r.artifact_id,
    version: r.version,
    target: JSON.parse(r.target_json) as StoryboardTarget | null,
    ...(r.field !== null ? { field: r.field } : {}),
    change_type: r.change_type,
    ...(r.old_value !== null ? { old_value: r.old_value } : {}),
    ...(r.new_value !== null ? { new_value: r.new_value } : {}),
    ...(r.reason !== null ? { reason: r.reason } : {}),
    sources: r.sources_json ? (JSON.parse(r.sources_json) as SourceRef[]) : [],
    created_at: r.created_at,
  }));
}

/**
 * Restores a previous version's state as a new version.
 *
 * The historical versions are untouched, so a rollback can itself be rolled back.
 */
export function rollback(artifactId: string, toVersion: number, reason?: string): { version: number } {
  const artifact = getArtifact(artifactId);
  const restored = getState(artifactId, toVersion);
  const result = commitVersion({
    artifact_id: artifactId,
    base_version: artifact.current_version,
    state: restored,
    note: reason ?? `Rolled back to version ${toVersion}`,
    changes: [
      {
        target: null,
        change_type: 'rollback',
        old_value: String(artifact.current_version),
        new_value: String(toVersion),
        reason: reason ?? `Restored the state of version ${toVersion}`,
      },
    ],
  });
  return { version: result.version };
}
