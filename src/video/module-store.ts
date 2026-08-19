/**
 * Module content package storage.
 *
 * Same discipline as the other stores: every write is a new version, no version is
 * overwritten, and a write carries the version it was based on so a stale patch is
 * refused. The video half and the slide half are written by separate calls -- a
 * module's package is a lot of content and asking for all of it in one submission
 * would mean losing the lot to one validation failure -- so each call patches the
 * half it names and leaves the other untouched.
 */

import type {
  ModulePackageState,
  ModulePlan,
  SlideContent,
  StoryBible,
  VideoSegmentContent,
} from '../types/module-content.js';
import { getDb, nowIso, transaction } from '../storage/db.js';

export interface ModulePackageRecord {
  package_id: string;
  course_id: string;
  subject_id?: string;
  module_number: number;
  module_title: string;
  current_version: number;
  segments_written: number;
  slides_written: number;
  created_at: string;
  updated_at: string;
}

export class ModulePackageNotFoundError extends Error {
  constructor(packageId: string) {
    super(`No module content package "${packageId}".`);
    this.name = 'ModulePackageNotFoundError';
  }
}

export class ModulePackageConflictError extends Error {
  constructor(packageId: string, expected: number, actual: number) {
    super(
      `Version conflict on "${packageId}": the patch targets base version ${expected} but the ` +
        `current version is ${actual}. Re-read it with get_module_package and reapply.`,
    );
    this.name = 'ModulePackageConflictError';
  }
}

function nextPackageId(): string {
  const year = new Date().getUTCFullYear();
  const prefix = `MP-${year}-`;
  const row = getDb()
    .prepare(
      'SELECT package_id FROM module_packages WHERE package_id LIKE ? ORDER BY package_id DESC LIMIT 1',
    )
    .get(`${prefix}%`) as { package_id: string } | undefined;
  const last = row ? Number(row.package_id.slice(prefix.length)) : 0;
  return `${prefix}${String(last + 1).padStart(5, '0')}`;
}

export function createModulePackage(plan: ModulePlan, title?: string): ModulePackageState {
  const ts = nowIso();
  const db = getDb();

  return transaction(db, () => {
    const packageId = nextPackageId();
    const state: ModulePackageState = {
      package_id: packageId,
      version: 1,
      course_id: plan.course_id,
      ...(plan.subject_id ? { subject_id: plan.subject_id } : {}),
      ...(plan.subject_code ? { subject_code: plan.subject_code } : {}),
      module_number: plan.module_number,
      module_title: plan.module_title,
      title: title ?? plan.module_title,
      words_per_minute: plan.words_per_minute,
      plan,
      segments: [],
      slides: [],
      created_at: ts,
      updated_at: ts,
    };
    const json = JSON.stringify(state);

    db.prepare(
      `INSERT INTO module_packages (package_id, course_id, subject_id, module_number, module_title,
                                    current_version, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      packageId,
      plan.course_id,
      plan.subject_id ?? null,
      plan.module_number,
      plan.module_title,
      json,
      ts,
      ts,
    );
    db.prepare(
      'INSERT INTO module_package_versions (package_id, version, state_json, note, created_at) VALUES (?, 1, ?, ?, ?)',
    ).run(packageId, json, 'Plan created; no content written yet.', ts);

    return state;
  });
}

export function getModulePackage(packageId: string, version?: number): ModulePackageState {
  const db = getDb();
  const row =
    version === undefined
      ? (db.prepare('SELECT state_json FROM module_packages WHERE package_id = ?').get(packageId) as
          | { state_json: string }
          | undefined)
      : (db
          .prepare('SELECT state_json FROM module_package_versions WHERE package_id = ? AND version = ?')
          .get(packageId, version) as { state_json: string } | undefined);
  if (!row) throw new ModulePackageNotFoundError(version === undefined ? packageId : `${packageId}" v${version}`);
  return JSON.parse(row.state_json) as ModulePackageState;
}

export interface CommitModuleInput {
  package_id: string;
  base_version: number;
  segments?: VideoSegmentContent[];
  slides?: SlideContent[];
  story?: StoryBible;
  title?: string;
  note?: string;
}

export function commitModulePackage(input: CommitModuleInput): ModulePackageState {
  const db = getDb();
  return transaction(db, () => {
    const row = db
      .prepare('SELECT current_version, state_json FROM module_packages WHERE package_id = ?')
      .get(input.package_id) as { current_version: number; state_json: string } | undefined;
    if (!row) throw new ModulePackageNotFoundError(input.package_id);
    if (row.current_version !== input.base_version) {
      throw new ModulePackageConflictError(input.package_id, input.base_version, row.current_version);
    }

    const previous = JSON.parse(row.state_json) as ModulePackageState;
    const ts = nowIso();
    const state: ModulePackageState = {
      ...previous,
      version: row.current_version + 1,
      ...(input.title !== undefined ? { title: input.title } : {}),
      // Only what the call names is replaced, so writing the deck cannot wipe the
      // video and revising the story bible cannot wipe either.
      ...(input.story !== undefined ? { story: input.story } : {}),
      segments: input.segments ?? previous.segments,
      slides: input.slides ?? previous.slides,
      updated_at: ts,
    };
    const json = JSON.stringify(state);

    db.prepare(
      'UPDATE module_packages SET current_version = ?, state_json = ?, updated_at = ? WHERE package_id = ?',
    ).run(state.version, json, ts, input.package_id);
    db.prepare(
      'INSERT INTO module_package_versions (package_id, version, state_json, note, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(input.package_id, state.version, json, input.note ?? null, ts);

    return state;
  });
}

export function listModulePackages(courseId?: string): ModulePackageRecord[] {
  const db = getDb();
  const sql =
    `SELECT package_id, course_id, subject_id, module_number, module_title, current_version,
            state_json, created_at, updated_at
     FROM module_packages` +
    (courseId ? ' WHERE course_id = ?' : '') +
    ' ORDER BY created_at DESC';
  const rows = (courseId ? db.prepare(sql).all(courseId) : db.prepare(sql).all()) as unknown as {
    package_id: string;
    course_id: string;
    subject_id: string | null;
    module_number: number;
    module_title: string;
    current_version: number;
    state_json: string;
    created_at: string;
    updated_at: string;
  }[];

  return rows.map(({ state_json, subject_id, ...rest }) => {
    const state = JSON.parse(state_json) as ModulePackageState;
    return {
      ...rest,
      ...(subject_id !== null ? { subject_id } : {}),
      segments_written: state.segments.length,
      slides_written: state.slides.length,
    };
  });
}

export function listModulePackageVersions(
  packageId: string,
): { version: number; note?: string; created_at: string }[] {
  const rows = getDb()
    .prepare(
      'SELECT version, note, created_at FROM module_package_versions WHERE package_id = ? ORDER BY version ASC',
    )
    .all(packageId) as unknown as { version: number; note: string | null; created_at: string }[];
  return rows.map((r) => ({
    version: r.version,
    ...(r.note !== null ? { note: r.note } : {}),
    created_at: r.created_at,
  }));
}
