/**
 * Video transcript storage.
 *
 * Same discipline as the storyboard store: every write creates a new version and
 * no version is ever overwritten, and a write carries the version it was based on
 * so a stale patch is refused rather than silently clobbering a newer one. A
 * transcript is small, so a version holds the whole state rather than a diff.
 */

import type { ScenePlan, TranscriptScene, VideoTranscriptState } from '../types/video.js';
import { getDb, nowIso, transaction } from '../storage/db.js';

export interface TranscriptRecord {
  transcript_id: string;
  course_id: string;
  subject_id?: string;
  unit_code: string;
  unit_title: string;
  requested_seconds: number;
  words_per_minute: number;
  current_version: number;
  created_at: string;
  updated_at: string;
}

export class TranscriptNotFoundError extends Error {
  constructor(transcriptId: string) {
    super(`No video transcript "${transcriptId}".`);
    this.name = 'TranscriptNotFoundError';
  }
}

export class TranscriptVersionConflictError extends Error {
  constructor(transcriptId: string, expected: number, actual: number) {
    super(
      `Version conflict on "${transcriptId}": the patch targets base version ${expected} but ` +
        `the current version is ${actual}. Re-read it with get_video_transcript and reapply.`,
    );
    this.name = 'TranscriptVersionConflictError';
  }
}

/** Allocates the next id, e.g. "VT-2026-00007". Per calendar year, like storyboards. */
function nextTranscriptId(): string {
  const year = new Date().getUTCFullYear();
  const prefix = `VT-${year}-`;
  const row = getDb()
    .prepare(
      'SELECT transcript_id FROM video_transcripts WHERE transcript_id LIKE ? ORDER BY transcript_id DESC LIMIT 1',
    )
    .get(`${prefix}%`) as { transcript_id: string } | undefined;
  const last = row ? Number(row.transcript_id.slice(prefix.length)) : 0;
  return `${prefix}${String(last + 1).padStart(5, '0')}`;
}

export interface CreateTranscriptInput {
  plan: ScenePlan;
  title?: string;
  note?: string;
}

/**
 * Creates a transcript as version 1: the plan filled in, the scenes empty.
 *
 * The plan is stored with the transcript rather than recomputed on read, so a
 * transcript can always be validated and rendered against the plan it was actually
 * written to, even if the handbook is re-ingested afterwards.
 */
export function createTranscript(input: CreateTranscriptInput): VideoTranscriptState {
  const { plan } = input;
  const ts = nowIso();
  const db = getDb();

  return transaction(db, () => {
    const transcriptId = nextTranscriptId();
    const state: VideoTranscriptState = {
      transcript_id: transcriptId,
      version: 1,
      course_id: plan.course_id,
      ...(plan.subject_id ? { subject_id: plan.subject_id } : {}),
      ...(plan.subject_code ? { subject_code: plan.subject_code } : {}),
      unit_code: plan.unit_code,
      unit_title: plan.unit_title,
      module_number: plan.module_number,
      title: input.title ?? plan.unit_title,
      requested_seconds: plan.requested_seconds,
      words_per_minute: plan.words_per_minute,
      plan,
      scenes: [],
      created_at: ts,
      updated_at: ts,
    };
    const json = JSON.stringify(state);

    db.prepare(
      `INSERT INTO video_transcripts (transcript_id, course_id, subject_id, unit_code, unit_title,
                                      requested_seconds, words_per_minute, current_version,
                                      state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      transcriptId,
      plan.course_id,
      plan.subject_id ?? null,
      plan.unit_code,
      plan.unit_title,
      plan.requested_seconds,
      plan.words_per_minute,
      json,
      ts,
      ts,
    );
    db.prepare(
      'INSERT INTO video_transcript_versions (transcript_id, version, state_json, note, created_at) VALUES (?, 1, ?, ?, ?)',
    ).run(transcriptId, json, input.note ?? 'Plan created; scenes empty.', ts);

    return state;
  });
}

export function getTranscriptRecord(transcriptId: string): TranscriptRecord {
  const row = getDb()
    .prepare(
      `SELECT transcript_id, course_id, subject_id, unit_code, unit_title, requested_seconds,
              words_per_minute, current_version, created_at, updated_at
       FROM video_transcripts WHERE transcript_id = ?`,
    )
    .get(transcriptId) as
    | (Omit<TranscriptRecord, 'subject_id'> & { subject_id: string | null })
    | undefined;
  if (!row) throw new TranscriptNotFoundError(transcriptId);
  const { subject_id, ...rest } = row;
  return { ...rest, ...(subject_id !== null ? { subject_id } : {}) };
}

export function getTranscriptState(transcriptId: string, version?: number): VideoTranscriptState {
  const db = getDb();
  if (version === undefined) {
    const row = db
      .prepare('SELECT state_json FROM video_transcripts WHERE transcript_id = ?')
      .get(transcriptId) as { state_json: string } | undefined;
    if (!row) throw new TranscriptNotFoundError(transcriptId);
    return JSON.parse(row.state_json) as VideoTranscriptState;
  }
  const row = db
    .prepare('SELECT state_json FROM video_transcript_versions WHERE transcript_id = ? AND version = ?')
    .get(transcriptId, version) as { state_json: string } | undefined;
  if (!row) {
    throw new TranscriptNotFoundError(`${transcriptId}" version "${version}`);
  }
  return JSON.parse(row.state_json) as VideoTranscriptState;
}

export interface CommitTranscriptInput {
  transcript_id: string;
  base_version: number;
  scenes: TranscriptScene[];
  title?: string;
  note?: string;
}

export function commitTranscript(input: CommitTranscriptInput): VideoTranscriptState {
  const db = getDb();
  return transaction(db, () => {
    const row = db
      .prepare('SELECT current_version, state_json FROM video_transcripts WHERE transcript_id = ?')
      .get(input.transcript_id) as { current_version: number; state_json: string } | undefined;
    if (!row) throw new TranscriptNotFoundError(input.transcript_id);
    if (row.current_version !== input.base_version) {
      throw new TranscriptVersionConflictError(
        input.transcript_id,
        input.base_version,
        row.current_version,
      );
    }

    const previous = JSON.parse(row.state_json) as VideoTranscriptState;
    const ts = nowIso();
    const state: VideoTranscriptState = {
      ...previous,
      version: row.current_version + 1,
      ...(input.title !== undefined ? { title: input.title } : {}),
      scenes: input.scenes,
      updated_at: ts,
    };
    const json = JSON.stringify(state);

    db.prepare(
      'UPDATE video_transcripts SET current_version = ?, state_json = ?, updated_at = ? WHERE transcript_id = ?',
    ).run(state.version, json, ts, input.transcript_id);
    db.prepare(
      'INSERT INTO video_transcript_versions (transcript_id, version, state_json, note, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(input.transcript_id, state.version, json, input.note ?? null, ts);

    return state;
  });
}

export function listTranscripts(courseId?: string): TranscriptRecord[] {
  const db = getDb();
  const sql =
    `SELECT transcript_id, course_id, subject_id, unit_code, unit_title, requested_seconds,
            words_per_minute, current_version, created_at, updated_at
     FROM video_transcripts` +
    (courseId ? ' WHERE course_id = ?' : '') +
    ' ORDER BY created_at DESC';
  const rows = (courseId ? db.prepare(sql).all(courseId) : db.prepare(sql).all()) as unknown as (Omit<
    TranscriptRecord,
    'subject_id'
  > & { subject_id: string | null })[];
  return rows.map(({ subject_id, ...rest }) => ({
    ...rest,
    ...(subject_id !== null ? { subject_id } : {}),
  }));
}

export function listTranscriptVersions(
  transcriptId: string,
): { version: number; note?: string; created_at: string }[] {
  const rows = getDb()
    .prepare(
      'SELECT version, note, created_at FROM video_transcript_versions WHERE transcript_id = ? ORDER BY version ASC',
    )
    .all(transcriptId) as unknown as { version: number; note: string | null; created_at: string }[];
  return rows.map((r) => ({
    version: r.version,
    ...(r.note !== null ? { note: r.note } : {}),
    created_at: r.created_at,
  }));
}
