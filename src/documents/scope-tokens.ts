/**
 * Scope tokens: how a chunk's course, document and chapter are made searchable.
 *
 * Retrieval is always scoped -- to a course, and usually to a chapter of it or to
 * a named reference document. Expressing that scope as a SQL predicate outside
 * the FTS index means the index cannot use it: SQLite matches the query terms
 * against every chunk of every course, ranks all of them with bm25(), joins each
 * one to `chunks`, and only then discards the 99% that were out of scope. The
 * cost is therefore proportional to the whole corpus, so indexing a second course
 * slows down retrieval for the first -- and a typical query, being an OR of its
 * terms, matches nearly every chunk there is.
 *
 * Encoding the scope as ordinary tokens in an indexed FTS column instead lets the
 * scope be ANDed into the MATCH expression. SQLite then intersects postings lists
 * and visits only chunks that are already in scope, which is a small set and does
 * not grow when an unrelated course is ingested.
 *
 * The tokens are deliberately unlike real words. Every one is prefixed `z` plus a
 * two-letter kind, and reduced to [a-z0-9], so that no word a handbook contains
 * can collide with one and the unicode61 tokenizer cannot split one in half. The
 * same function produces them at index time and at query time, so whatever the
 * porter stemmer does to a token it does identically on both sides.
 */

import type { DocumentType } from '../types/source.js';

/** Reduces an identifier to the characters the tokenizer will keep as one token. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function courseToken(courseId: string): string {
  return `zcrs${slug(courseId)}`;
}

export function documentTypeToken(documentType: DocumentType): string {
  return `zdt${slug(documentType)}`;
}

export function chapterToken(chapter: number): string {
  return `zch${chapter}`;
}

export function docKeyToken(docKey: string): string {
  return `zdk${slug(docKey)}`;
}

export function unitToken(unitCode: string): string {
  // Unit codes are dotted ("1.1"), and the tokenizer would split on the dot.
  return `zun${slug(unitCode)}`;
}

export function nosToken(nosCode: string): string {
  return `zns${slug(nosCode)}`;
}

/**
 * The scope column's value for one chunk: everything it could be scoped by.
 *
 * Written once at ingest time. A chunk with no chapter or unit simply carries
 * fewer tokens, which is what makes an unchaptered Qualification Pack chunk
 * unreachable by a chapter-scoped query -- the same outcome the SQL predicate
 * produced, reached by the index instead of after it.
 */
export function chunkScopeText(chunk: {
  course_id: string;
  document_type: DocumentType;
  doc_key?: string | undefined;
  chapter?: number | undefined;
  unit_code?: string | undefined;
  nos_code?: string | undefined;
}): string {
  const tokens = [courseToken(chunk.course_id), documentTypeToken(chunk.document_type)];
  if (chunk.doc_key) tokens.push(docKeyToken(chunk.doc_key));
  if (chunk.chapter !== undefined && chunk.chapter !== null) tokens.push(chapterToken(chunk.chapter));
  if (chunk.unit_code) tokens.push(unitToken(chunk.unit_code));
  if (chunk.nos_code) tokens.push(nosToken(chunk.nos_code));
  return tokens.join(' ');
}
