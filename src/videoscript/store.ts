/**
 * Persistence for video scripts.
 *
 * Versioned the same way the storyboard is, and for the same reason: a script is
 * written, validated, corrected and written again, and "what did the last one
 * say" has to be answerable after the correction. A version is a whole state
 * rather than a diff, because the states are small and reconstructing one from a
 * chain of diffs is a class of bug not worth having.
 *
 * A plan alone does not create a row. The row appears when the flow reaches the
 * module, so that re-reading a finished session returns the script that exists
 * rather than planning a second one beside it.
 */

import { getDb, nowIso } from '../storage/db.js';
import type { FinalScene, VideoScriptPlan, VideoScriptState } from '../types/video-script.js';

export class VideoScriptNotFoundError extends Error {
  constructor(scriptId: string) {
    super(`No video script "${scriptId}". Call list_video_scripts to see what exists.`);
    this.name = 'VideoScriptNotFoundError';
  }
}

function nextScriptId(): string {
  const year = new Date().getUTCFullYear();
  const prefix = `VS-${year}-`;
  const row = getDb()
    .prepare(
      'SELECT script_id FROM video_scripts WHERE script_id LIKE ? ORDER BY script_id DESC LIMIT 1',
    )
    .get(`${prefix}%`) as { script_id: string } | undefined;
  const last = row ? Number(row.script_id.slice(prefix.length)) : 0;
  return `${prefix}${String(last + 1).padStart(5, '0')}`;
}

interface ScriptRow {
  script_id: string;
  state_json: string;
  current_version: number;
}

/**
 * The script for a module, created if it does not exist.
 *
 * Keyed on course and module rather than on nothing, so answering the flow twice
 * for the same module continues the same script instead of leaving a trail of
 * empty rows -- which is exactly what the previous feature's store did, and why
 * its table held a hundred of them.
 */
export function openVideoScript(plan: VideoScriptPlan): VideoScriptState {
  const db = getDb();
  const existing = db
    .prepare(
      'SELECT script_id, state_json, current_version FROM video_scripts ' +
        'WHERE course_id = ? AND module_number = ? AND video_type = ?',
    )
    .get(plan.course_id, plan.module_number, plan.video_type) as ScriptRow | undefined;

  if (existing) {
    const state = JSON.parse(existing.state_json) as VideoScriptState;
    // The plan is recomputed from the handbook and the current profile every time,
    // so a re-ingested handbook or a changed presenter is picked up rather than
    // frozen into the row. Authored scenes survive; they are the expensive part.
    return { ...state, plan };
  }

  const now = nowIso();
  const state: VideoScriptState = {
    script_id: nextScriptId(),
    course_id: plan.course_id,
    subject_id: plan.subject_id,
    module_number: plan.module_number,
    module_title: plan.module_title,
    video_type: plan.video_type,
    version: 1,
    plan,
    scenes: [],
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO video_scripts
       (script_id, course_id, subject_id, module_number, module_title, video_type,
        current_version, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    state.script_id,
    state.course_id,
    state.subject_id,
    state.module_number,
    state.module_title,
    state.video_type,
    state.version,
    JSON.stringify(state),
    now,
    now,
  );
  return state;
}

export function getVideoScript(scriptId: string, version?: number): VideoScriptState {
  const db = getDb();
  if (version !== undefined) {
    const row = db
      .prepare('SELECT state_json FROM video_script_versions WHERE script_id = ? AND version = ?')
      .get(scriptId, version) as { state_json: string } | undefined;
    if (!row) {
      throw new VideoScriptNotFoundError(`${scriptId} v${version}`);
    }
    return JSON.parse(row.state_json) as VideoScriptState;
  }
  const row = db
    .prepare('SELECT state_json FROM video_scripts WHERE script_id = ?')
    .get(scriptId) as { state_json: string } | undefined;
  if (!row) throw new VideoScriptNotFoundError(scriptId);
  return JSON.parse(row.state_json) as VideoScriptState;
}

/** Commits the scenes as a new version and returns the committed state. */
export function commitScenes(
  scriptId: string,
  plan: VideoScriptPlan,
  scenes: FinalScene[],
  note: string,
): VideoScriptState {
  const db = getDb();
  const current = getVideoScript(scriptId);
  const now = nowIso();
  // Version 1 is the empty plan, so the first submission is version 2. Numbering
  // submissions from 1 would make "v1" mean two different things.
  const version = current.scenes.length === 0 && current.version === 1 ? 2 : current.version + 1;

  const next: VideoScriptState = {
    ...current,
    plan,
    scenes,
    version,
    updated_at: now,
  };

  db.prepare(
    'UPDATE video_scripts SET current_version = ?, state_json = ?, updated_at = ?, module_title = ? WHERE script_id = ?',
  ).run(version, JSON.stringify(next), now, next.module_title, scriptId);
  db.prepare(
    'INSERT OR REPLACE INTO video_script_versions (script_id, version, state_json, note, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(scriptId, version, JSON.stringify(next), note, now);

  return next;
}

export interface VideoScriptSummary {
  script_id: string;
  course_id: string;
  subject_id: string;
  module_number: number;
  module_title: string;
  video_type: string;
  current_version: number;
  scenes_written: number;
  created_at: string;
  updated_at: string;
}

export function listVideoScripts(courseId?: string): VideoScriptSummary[] {
  const db = getDb();
  const rows = (
    courseId
      ? db
          .prepare(
            'SELECT script_id, state_json FROM video_scripts WHERE course_id = ? ORDER BY updated_at DESC',
          )
          .all(courseId)
      : db.prepare('SELECT script_id, state_json FROM video_scripts ORDER BY updated_at DESC').all()
  ) as { script_id: string; state_json: string }[];

  return rows.map((r) => {
    const s = JSON.parse(r.state_json) as VideoScriptState;
    return {
      script_id: s.script_id,
      course_id: s.course_id,
      subject_id: s.subject_id,
      module_number: s.module_number,
      module_title: s.module_title,
      video_type: s.video_type,
      current_version: s.version,
      scenes_written: s.scenes.length,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  });
}

export function listVideoScriptVersions(
  scriptId: string,
): { version: number; note?: string; created_at: string; scenes_written: number }[] {
  const rows = getDb()
    .prepare(
      'SELECT version, note, created_at, state_json FROM video_script_versions WHERE script_id = ? ORDER BY version',
    )
    .all(scriptId) as { version: number; note: string | null; created_at: string; state_json: string }[];
  return rows.map((r) => ({
    version: r.version,
    ...(r.note ? { note: r.note } : {}),
    created_at: r.created_at,
    scenes_written: (JSON.parse(r.state_json) as VideoScriptState).scenes.length,
  }));
}
