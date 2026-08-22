/**
 * Deterministic retrieval over indexed chunks.
 *
 * BM25 via SQLite FTS5. No embeddings and no model: the same query over the same
 * corpus always returns the same ranked results, and every result is explainable
 * by the terms that matched. Semantic judgement is the client's job; this layer's
 * job is to return the right slice of the approved corpus and to make it
 * impossible to reach outside it.
 *
 * INVARIANT 4 -- course isolation -- is enforced here as a mandatory SQL
 * predicate, not as a caller convention. There is no code path that returns a
 * chunk from another course.
 */

import type { DocumentType, SourceRef } from '../types/source.js';
import { DOCUMENT_TYPES } from '../types/source.js';
import { getCourseConfig, getCrosswalkEntry } from '../courses/course-config.js';
import { getDb } from '../storage/db.js';
import {
  chapterToken,
  courseToken,
  docKeyToken,
  documentTypeToken,
  nosToken,
  unitToken,
} from './scope-tokens.js';
import { config } from '../util/config.js';

/** One scope tokens ORed together, parenthesised so it binds before the AND. */
function anyOf(tokens: readonly string[]): string {
  return tokens.length === 1 ? tokens[0]! : `(${tokens.join(' OR ')})`;
}

export interface RetrievedChunk {
  chunk_id: string;
  course_id: string;
  document_type: DocumentType;
  /** Which reference document, for a course routed per document. */
  doc_key?: string;
  pdf_page: number;
  printed_page?: number;
  chapter?: number;
  unit_code?: string;
  nos_code?: string;
  section: string;
  subsection?: string;
  content: string;
  /** BM25 score. Lower is a better match in SQLite; negated here so higher is better. */
  score: number;
}

export interface SearchOptions {
  courseId: string;
  query: string;
  /** Restrict to these document types. Defaults to QP, PH and FG (not TIMING). */
  documentTypes?: readonly DocumentType[];
  /**
   * Restrict to a PH/FG chapter. Callers working from a storyboard module number
   * should pass `chapterForModule(courseId, moduleNumber)` rather than the module
   * number itself.
   */
  chapter?: number;
  /**
   * Restrict to specific reference documents, by doc_key.
   *
   * This is how a CDR module is scoped: its master file names the documents it
   * draws from, and nothing outside them may be retrieved for it.
   */
  docKeys?: readonly string[];
  /** Restrict to a unit code such as "1.1". */
  unitCode?: string;
  /**
   * Restrict to a NOS code such as "SGJ/N4105". This is how QP content is scoped,
   * since the QP is organised by NOS rather than by chapter. Use
   * `nosForModule(courseId, moduleNumber)` to derive it.
   */
  nosCode?: string;
  limit?: number;
}

export class RetrievalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalError';
  }
}

/**
 * Escapes a user query into an FTS5 MATCH expression.
 *
 * FTS5 treats bare punctuation as syntax, so an unescaped query like
 * "CTE / CTO (Consent to Establish)" is a syntax error rather than a search. Each
 * term is quoted, which makes it a literal, and terms are OR-ed so partial
 * matches still rank.
 */
export function toMatchExpression(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}._/-]+/u)
    .map((t) => t.replace(/^[._/-]+|[._/-]+$/g, ''))
    .filter((t) => t.length > 1);

  if (terms.length === 0) {
    throw new RetrievalError(
      `Query "${query}" contains no searchable terms (terms must be at least 2 characters).`,
    );
  }
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** Maps a storyboard module number to the PH/FG chapter that holds its content. */
export function chapterForModule(courseId: string, moduleNumber: number): number {
  return getCrosswalkEntry(courseId, moduleNumber).source_chapter;
}

/** Maps a storyboard module number to the NOS code its QP content sits under. */
export function nosForModule(courseId: string, moduleNumber: number): string {
  return getCrosswalkEntry(courseId, moduleNumber).nos_code;
}

function assertDocumentTypes(types: readonly DocumentType[]): void {
  for (const t of types) {
    if (!DOCUMENT_TYPES.includes(t)) {
      throw new RetrievalError(
        `"${t}" is not an approved document type. Approved types: ${DOCUMENT_TYPES.join(', ')}.`,
      );
    }
  }
}

export function searchCourseContent(options: SearchOptions): RetrievedChunk[] {
  const { courseId, query } = options;
  // Throws for an unregistered course, so a typo cannot silently widen scope.
  getCourseConfig(courseId);

  // MASTER is excluded by default for the same reason TIMING is: it states
  // structure and duration, not teachable content.
  const documentTypes = options.documentTypes ?? (['QP', 'PH', 'FG', 'REF'] as const);
  assertDocumentTypes(documentTypes);

  const limit = Math.min(options.limit ?? config.search.defaultLimit, config.search.maxLimit);

  if (options.docKeys !== undefined && options.docKeys.length === 0) {
    // An empty routing list is a configuration error, not "match everything".
    return [];
  }

  // The scope goes into the MATCH expression rather than into a WHERE clause, so
  // SQLite intersects postings lists and ranks only chunks that are already in
  // scope. As a WHERE clause it ranked every chunk of every course first and
  // discarded almost all of them afterwards, which made each query cost grow with
  // the size of the whole corpus rather than with the slice being searched.
  const scope: string[] = [courseToken(courseId)];
  if (documentTypes.length > 0) {
    scope.push(anyOf(documentTypes.map(documentTypeToken)));
  }
  if (options.chapter !== undefined) scope.push(chapterToken(options.chapter));
  if (options.docKeys !== undefined) scope.push(anyOf(options.docKeys.map(docKeyToken)));
  if (options.unitCode !== undefined) scope.push(unitToken(options.unitCode));
  if (options.nosCode !== undefined) scope.push(nosToken(options.nosCode));

  const match = `${scope.map((s) => `scope : ${s}`).join(' AND ')} AND (${toMatchExpression(query)})`;

  // Tie-break on chunk_id so identical scores return in a stable order; without
  // it the same query could return the same chunks in a different sequence.
  // `scope` is weighted 0: it selects rows, it must not rank them.
  const sql = `
    SELECT c.chunk_id, c.course_id, c.document_type, c.doc_key, c.pdf_page, c.printed_page,
           c.chapter, c.unit_code, c.nos_code, c.section, c.subsection, c.content,
           bm25(chunks_fts, 1.0, 0.6, 0.0) AS score
    FROM chunks_fts
    JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
    WHERE chunks_fts MATCH ?
    ORDER BY score ASC, c.chunk_id ASC LIMIT ?`;

  const rows = getDb().prepare(sql).all(match, limit) as unknown as (ChunkRow & { score: number })[];

  // SQLite's bm25() returns negative values, more negative being a better match.
  return rows.map((r) => ({ ...mapRow(r), score: -r.score }));
}

const CHUNK_COLUMNS = `chunk_id, course_id, document_type, doc_key, pdf_page, printed_page,
                       chapter, unit_code, nos_code, section, subsection, content`;

/**
 * Chunks within a scope, in document order, with no text query.
 *
 * Search can legitimately return nothing -- a query whose terms happen not to
 * appear in the scope -- and a task with no source text is one the client cannot
 * answer. This is the floor under that: the material a module is built from,
 * whether or not any particular phrasing matches it.
 */
export function listChunksInScope(options: {
  courseId: string;
  documentTypes?: readonly DocumentType[];
  chapter?: number;
  docKeys?: readonly string[];
  /** Restrict to one unit of the scope, e.g. "1.1". */
  unitCode?: string;
  limit?: number;
}): RetrievedChunk[] {
  getCourseConfig(options.courseId);
  const types = options.documentTypes ?? (['QP', 'PH', 'FG', 'REF'] as const);
  assertDocumentTypes(types);

  const params: (string | number)[] = [options.courseId];
  let sql = `SELECT ${CHUNK_COLUMNS} FROM chunks WHERE course_id = ?`;
  if (types.length > 0) {
    sql += ` AND document_type IN (${types.map(() => '?').join(', ')})`;
    params.push(...types);
  }
  if (options.chapter !== undefined) {
    sql += ' AND chapter = ?';
    params.push(options.chapter);
  }
  if (options.docKeys !== undefined) {
    if (options.docKeys.length === 0) return [];
    sql += ` AND doc_key IN (${options.docKeys.map(() => '?').join(', ')})`;
    params.push(...options.docKeys);
  }
  if (options.unitCode !== undefined) {
    sql += ' AND unit_code = ?';
    params.push(options.unitCode);
  }
  sql += ' ORDER BY ordinal ASC, chunk_id ASC LIMIT ?';
  // Bounded by maxScopeChunks, not by the search cap. This is a complete listing
  // of a module's own material rather than a ranked answer to a query, and the
  // search cap silently truncated it: a caller asking for a whole chapter got the
  // first fifty chunks, so the end of a long chapter -- the material its last
  // units are written from -- was simply absent.
  params.push(Math.min(options.limit ?? config.search.defaultLimit, config.search.maxScopeChunks));

  const rows = getDb().prepare(sql).all(...params) as unknown as ChunkRow[];
  return rows.map((r) => ({ ...mapRow(r), score: 0 }));
}

interface ChunkRow {
  chunk_id: string;
  course_id: string;
  document_type: DocumentType;
  doc_key: string | null;
  pdf_page: number;
  printed_page: number | null;
  chapter: number | null;
  unit_code: string | null;
  nos_code: string | null;
  section: string;
  subsection: string | null;
  content: string;
}

function mapRow(row: ChunkRow): RetrievedChunk {
  return {
    chunk_id: row.chunk_id,
    course_id: row.course_id,
    document_type: row.document_type,
    ...(row.doc_key ? { doc_key: row.doc_key } : {}),
    pdf_page: row.pdf_page,
    ...(row.printed_page !== null ? { printed_page: row.printed_page } : {}),
    ...(row.chapter !== null ? { chapter: row.chapter } : {}),
    ...(row.unit_code !== null ? { unit_code: row.unit_code } : {}),
    ...(row.nos_code !== null ? { nos_code: row.nos_code } : {}),
    section: row.section,
    ...(row.subsection !== null ? { subsection: row.subsection } : {}),
    content: row.content,
    score: 0,
  };
}

/** Fetches one chunk by id, scoped to a course so ids cannot be used to cross courses. */
export function getChunk(courseId: string, chunkId: string): RetrievedChunk | undefined {
  const row = getDb()
    .prepare(`SELECT ${CHUNK_COLUMNS} FROM chunks WHERE chunk_id = ? AND course_id = ?`)
    .get(chunkId, courseId) as unknown as ChunkRow | undefined;
  return row ? mapRow(row) : undefined;
}

/** All chunks on a page, in document order. Used to widen context around a hit. */
export function getPageChunks(
  courseId: string,
  documentType: DocumentType,
  pdfPage: number,
): RetrievedChunk[] {
  const rows = getDb()
    .prepare(
      `SELECT ${CHUNK_COLUMNS} FROM chunks
       WHERE course_id = ? AND document_type = ? AND pdf_page = ?
       ORDER BY ordinal ASC`,
    )
    .all(courseId, documentType, pdfPage) as unknown as ChunkRow[];
  return rows.map(mapRow);
}

/** Builds the citation the client should attach to content drawn from a chunk. */
export function toSourceRef(chunk: RetrievedChunk, quote?: string): SourceRef {
  return {
    document_type: chunk.document_type,
    pdf_page: chunk.pdf_page,
    ...(chunk.printed_page !== undefined ? { printed_page: chunk.printed_page } : {}),
    section: chunk.section,
    ...(chunk.subsection !== undefined ? { subsection: chunk.subsection } : {}),
    chunk_id: chunk.chunk_id,
    ...(quote !== undefined ? { quote } : {}),
  };
}
