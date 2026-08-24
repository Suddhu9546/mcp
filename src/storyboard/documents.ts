/**
 * Storyboard documents as they exist on disk.
 *
 * The database is not the portable record. `data/` is gitignored and local to one
 * machine, `artifacts/` is committed and travels with the repository -- so a
 * checkout on a second machine has the documents and none of the rows that
 * describe them. A reuse check that consulted only the database therefore reported
 * "nothing built yet" for a subject whose finished storyboard was sitting in the
 * folder next to it, and regenerated a document that had already been delivered.
 *
 * So the folder is the source of truth for *whether a storyboard exists*, and the
 * database is enrichment for *what is known about it*. That ordering is what makes
 * the answer the same on every machine, which is the property the previous
 * arrangement could not have.
 *
 * The filename carries what the database would otherwise have to:
 *
 *   solar-pv-storyboard-SB-2026-00001-v13-20260823-192546.docx
 *   └ course ──┘          └ artifact ─┘ └v┘ └── rendered ──┘
 *
 * which is why it is written that way rather than as a bare course name.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../util/config.js';

export interface StoryboardDocument {
  course_id: string;
  docx_path: string;
  filename: string;
  bytes: number;
  /** When the document was rendered, from its name where present, else its mtime. */
  rendered_at: string;
  /** Artifact it came from, when the name carries one. */
  artifact_id?: string;
  /** Version it was rendered from, when the name carries one. */
  version?: number;
  /**
   * True when the timestamp came from the filename rather than the filesystem.
   * An mtime changes when a file is copied or checked out, so a name-derived
   * timestamp is the trustworthy one and this says which was used.
   */
  timestamp_from_name: boolean;
}

/**
 * `<course>-storyboard-<artifact>-v<n>-<YYYYMMDD>-<HHMMSS>.docx`
 *
 * The course part is matched lazily and not captured: course ids contain hyphens
 * ("agri-residue-aggregator"), so it cannot be told from the rest of the name by
 * splitting, and the folder already says which course this is.
 */
const NAME_RE = /^.+-storyboard-(SB-\d{4}-\d{5})-v(\d+)-(\d{8})-(\d{6})\.docx$/;

function isoFromStamp(day: string, time: string): string {
  const iso =
    `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` +
    `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  // Written in local time by the renderer, so it is read back the same way.
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toISOString();
}

/**
 * Every rendered storyboard on disk for one course, newest first.
 *
 * Files whose names do not carry an artifact id are still listed: a document
 * rendered before the naming convention existed, or one someone renamed, is just
 * as much a delivered storyboard. It is dated by its mtime instead, and says so,
 * because that is weaker evidence than a name.
 */
export function listStoryboardDocuments(courseId: string): StoryboardDocument[] {
  const dir = path.join(config.paths.artifacts, courseId);
  if (!existsSync(dir)) return [];

  const found: StoryboardDocument[] = [];
  for (const filename of readdirSync(dir)) {
    if (!filename.toLowerCase().endsWith('.docx') || filename.startsWith('~$')) continue;
    const full = path.join(dir, filename);

    let stat;
    try {
      stat = statSync(full);
    } catch {
      // Vanished between listing and stat, which is not this function's problem.
      continue;
    }
    if (!stat.isFile()) continue;

    const m = NAME_RE.exec(filename);
    found.push({
      course_id: courseId,
      docx_path: full,
      filename,
      bytes: stat.size,
      ...(m
        ? {
            artifact_id: m[1]!,
            version: Number(m[2]),
            rendered_at: isoFromStamp(m[3]!, m[4]!),
            timestamp_from_name: true,
          }
        : { rendered_at: stat.mtime.toISOString(), timestamp_from_name: false }),
    });
  }

  return found.sort(
    (a, b) => b.rendered_at.localeCompare(a.rendered_at) || b.filename.localeCompare(a.filename),
  );
}

/** The newest rendered storyboard on disk for a course, if there is one. */
export function newestStoryboardDocument(courseId: string): StoryboardDocument | undefined {
  return listStoryboardDocuments(courseId)[0];
}

/** Where a course's documents live, for a message that has to name the place. */
export function storyboardDocumentDir(courseId: string): string {
  return path.join(config.paths.artifacts, courseId);
}
