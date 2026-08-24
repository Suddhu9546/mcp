/**
 * What a storyboard was built against, so that reusing it can be trusted.
 *
 * A saved storyboard is only as good as the sources its citations point at, and
 * those citations are `chunk_id` values of the form
 * `<course>:<doc>:p<page>:<ordinal>`. The ordinal is *positional*: re-ingesting a
 * revised PDF, or changing the chunker, renumbers it. So a chunk_id is not a
 * stable handle on a piece of text -- it is a stable handle on a *position*, and
 * the text at that position can change underneath a stored citation.
 *
 * That is the failure this file exists to prevent. Left unchecked, reusing an old
 * storyboard produces a document whose citations all resolve, all validate, and
 * all point at the wrong paragraph. Nothing downstream can detect it, because
 * every individual part is internally consistent.
 *
 * So each artifact records a fingerprint of its sources when it is created, and
 * the reuse path compares. A match means reuse is safe and silent. A mismatch is
 * reported, not refused: the content is usually still fine, and whether to accept
 * it is a judgement about the subject rather than about the data.
 *
 * The hash covers each chunk's id and length, not its text. Length catches an
 * edited paragraph, the id catches a moved or renumbered one, and skipping the
 * text keeps the whole thing one cheap query rather than a read of the corpus.
 */

import { createHash } from 'node:crypto';
import { getDb } from './db.js';

export interface DocumentFingerprint {
  document_type: string;
  doc_key?: string;
  chunk_count: number;
  /** Total characters indexed for this document. */
  char_count: number;
}

export interface SourceFingerprint {
  /** Hash over every chunk's id and length, across the course's documents. */
  digest: string;
  /** Per-document counts, so a mismatch can say which document moved. */
  documents: DocumentFingerprint[];
  /** The template the storyboard was rendered against. */
  template_version: string;
  computed_at: string;
}

interface Row {
  document_type: string;
  doc_key: string | null;
  chunk_id: string;
  char_count: number;
}

/**
 * Fingerprints a course's indexed sources as they stand right now.
 *
 * Ordered by chunk_id rather than by ordinal so the digest depends on the set of
 * chunks and not on the order SQLite happens to return them in.
 */
export function computeSourceFingerprint(
  courseId: string,
  templateVersion: string,
): SourceFingerprint {
  const rows = getDb()
    .prepare(
      `SELECT document_type, doc_key, chunk_id, char_count
       FROM chunks WHERE course_id = ?
       ORDER BY chunk_id ASC`,
    )
    .all(courseId) as unknown as Row[];

  const hash = createHash('sha256');
  const byDocument = new Map<string, DocumentFingerprint>();

  for (const row of rows) {
    hash.update(`${row.document_type}|${row.doc_key ?? ''}|${row.chunk_id}|${row.char_count}\n`);

    const key = `${row.document_type}|${row.doc_key ?? ''}`;
    const found = byDocument.get(key);
    if (found) {
      found.chunk_count += 1;
      found.char_count += row.char_count;
    } else {
      byDocument.set(key, {
        document_type: row.document_type,
        ...(row.doc_key ? { doc_key: row.doc_key } : {}),
        chunk_count: 1,
        char_count: row.char_count,
      });
    }
  }

  return {
    digest: hash.digest('hex'),
    documents: [...byDocument.values()].sort((a, b) =>
      `${a.document_type}${a.doc_key ?? ''}`.localeCompare(`${b.document_type}${b.doc_key ?? ''}`),
    ),
    template_version: templateVersion,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Names a document the way a reader would.
 *
 * A qualification course sets `doc_key` to the document type, so naming both gives
 * "PH (PH)". Only a CDR course, whose nine reference documents are all of type
 * REF, has a key that says anything the type does not.
 */
function describeDocument(d: DocumentFingerprint): string {
  return d.doc_key && d.doc_key !== d.document_type
    ? `${d.document_type} (${d.doc_key})`
    : d.document_type;
}

export type FingerprintVerdict =
  /** The sources are byte-for-byte the set the storyboard was written against. */
  | { state: 'unchanged' }
  /** The sources have moved. `changes` says how, in the user's terms. */
  | { state: 'changed'; changes: string[] }
  /** The artifact predates fingerprinting, so nothing can be said either way. */
  | { state: 'unknown'; reason: string };

/**
 * Compares a stored fingerprint against the sources as they stand.
 *
 * Reports the template separately from the documents, because they mean different
 * things to a user: a changed template means the saved content is still correct and
 * only needs re-rendering, while changed documents mean the content itself may no
 * longer match what it cites.
 */
export function compareSourceFingerprint(
  stored: SourceFingerprint | undefined,
  current: SourceFingerprint,
): FingerprintVerdict {
  if (!stored) {
    return {
      state: 'unknown',
      reason:
        'This storyboard was created before source fingerprinting, so whether its sources have ' +
        'changed since cannot be established. Re-rendering is safe; the citations have not been ' +
        're-checked against the current index.',
    };
  }

  if (stored.digest === current.digest && stored.template_version === current.template_version) {
    return { state: 'unchanged' };
  }

  const changes: string[] = [];

  if (stored.template_version !== current.template_version) {
    changes.push(
      `The storyboard template changed from "${stored.template_version}" to ` +
        `"${current.template_version}". The content is unaffected; re-rendering picks up the new ` +
        'template.',
    );
  }

  const before = new Map(stored.documents.map((d) => [`${d.document_type}|${d.doc_key ?? ''}`, d]));
  const after = new Map(current.documents.map((d) => [`${d.document_type}|${d.doc_key ?? ''}`, d]));

  for (const [key, now] of after) {
    const then = before.get(key);
    const label = describeDocument(now);
    if (!then) {
      changes.push(`${label} was not indexed when this storyboard was built, and is now.`);
    } else if (then.chunk_count !== now.chunk_count || then.char_count !== now.char_count) {
      changes.push(
        `${label} was re-indexed: ${then.chunk_count} chunks / ${then.char_count.toLocaleString('en-US')} ` +
          `characters became ${now.chunk_count} / ${now.char_count.toLocaleString('en-US')}. Citations ` +
          'in the saved storyboard may now point at different text.',
      );
    }
  }
  for (const [key, then] of before) {
    if (!after.has(key)) {
      changes.push(`${describeDocument(then)} is no longer indexed, so its citations cannot be resolved.`);
    }
  }

  // The digest covers chunk ids, which move without changing any count. A
  // renumbering that leaves every total identical is exactly the silent case this
  // check exists for, so it is reported rather than passed over.
  if (changes.length === 0) {
    changes.push(
      'The documents hold the same number of chunks and characters, but their chunk identifiers ' +
        'have changed, which happens when a document is re-ingested or the chunker changes. ' +
        'Citations may point at different text than they were written against.',
    );
  }

  return { state: 'changed', changes };
}

/** One line a client can show the user without interpreting the verdict. */
export function describeVerdict(verdict: FingerprintVerdict): string {
  switch (verdict.state) {
    case 'unchanged':
      return 'sources unchanged since it was built';
    case 'changed':
      return `sources have changed since it was built (${verdict.changes.length} difference${
        verdict.changes.length === 1 ? '' : 's'
      })`;
    case 'unknown':
      return 'built before source tracking; cannot confirm its sources are unchanged';
  }
}
