/**
 * Clears every stored storyboard, so the reuse offer starts from nothing.
 *
 *   npx tsx scripts/reset-storyboards.ts            # report only
 *   npx tsx scripts/reset-storyboards.ts --confirm   # actually delete
 *
 * This exists because the suite used to run against the real database. It built
 * storyboards through the real tools, so every run left hundreds of
 * finished-looking artifacts behind -- and once the flow began offering a saved
 * storyboard back instead of rebuilding it, those test fixtures became what a user
 * was offered. The suite now has its own database (see vitest.config.ts), so this
 * is a one-off cleanup rather than a routine chore.
 *
 * It refuses to run without --confirm, and prints what it would remove first,
 * because storyboard state is the one thing in this system that cannot be
 * regenerated: chunks come back by re-ingesting, a .docx comes back by rendering,
 * and authored content comes back only by writing it again.
 */

import { getDb, transaction } from '../src/storage/db.js';
import { config } from '../src/util/config.js';

const confirmed = process.argv.includes('--confirm');
const db = getDb();

interface Row {
  course_id: string;
  artifacts: number;
  versions: number;
}

const rows = db
  .prepare(
    `SELECT a.course_id,
            COUNT(DISTINCT a.artifact_id) AS artifacts,
            COUNT(v.version)              AS versions
     FROM storyboard_artifacts a
     LEFT JOIN storyboard_versions v ON v.artifact_id = a.artifact_id
     GROUP BY a.course_id
     ORDER BY artifacts DESC`,
  )
  .all() as unknown as Row[];

console.log(`\nDatabase: ${config.paths.db}\n`);

if (rows.length === 0) {
  console.log('No stored storyboards. Nothing to do.');
  process.exit(0);
}

let artifacts = 0;
let versions = 0;
for (const r of rows) {
  console.log(`  ${r.course_id.padEnd(28)} ${String(r.artifacts).padStart(5)} artifacts  ${String(r.versions).padStart(6)} versions`);
  artifacts += r.artifacts;
  versions += r.versions;
}
console.log(`  ${'TOTAL'.padEnd(28)} ${String(artifacts).padStart(5)} artifacts  ${String(versions).padStart(6)} versions`);

// A sample, so that anyone about to delete this can see what it is.
const sample = db
  .prepare(
    `SELECT a.artifact_id, a.course_id, a.created_at
     FROM storyboard_artifacts a ORDER BY a.created_at DESC LIMIT 3`,
  )
  .all() as unknown as { artifact_id: string; course_id: string; created_at: string }[];
console.log('\nMost recent:');
for (const s of sample) console.log(`  ${s.artifact_id}  ${s.course_id}  ${s.created_at}`);

if (!confirmed) {
  console.log(
    '\nReport only. Re-run with --confirm to delete all of the above.\n' +
      'Rendered .docx files on disk are left alone; delete the artifacts folder\n' +
      'separately if you want those gone too.',
  );
  process.exit(0);
}

transaction(db, () => {
  // Children first: changes and versions both reference the artifact.
  db.prepare('DELETE FROM storyboard_changes').run();
  db.prepare('DELETE FROM storyboard_versions').run();
  db.prepare('DELETE FROM storyboard_artifacts').run();
});

const left = db.prepare('SELECT COUNT(*) AS n FROM storyboard_artifacts').get() as unknown as {
  n: number;
};
console.log(`\nDeleted ${artifacts} artifacts and ${versions} versions. Remaining: ${left.n}.`);
