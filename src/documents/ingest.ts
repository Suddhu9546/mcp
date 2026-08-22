/**
 * Ingestion: PDF -> pages -> chunks -> SQLite + FTS index.
 *
 * Ingestion is idempotent per document. A document whose checksum is unchanged is
 * skipped unless `force` is set, so re-running the tool after adding one course
 * does not re-index the rest.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DocumentType } from '../types/source.js';
import { courseDir, getCourseConfig } from '../courses/course-config.js';
import { ensureCourseRegistered } from '../courses/course-manager.js';
import { chunkDocument, type Chunk } from './chunker.js';
import { extractPdf } from './pdf-extractor.js';
import { chunkScopeText } from './scope-tokens.js';
import { getDb, nowIso, transaction, type Db } from '../storage/db.js';
import { logger } from '../util/logger.js';

export interface IngestedDocument {
  document_type: DocumentType;
  file: string;
  page_count: number;
  chunk_count: number;
  skipped: boolean;
  reason?: string;
}

export interface IngestResult {
  course_id: string;
  documents: IngestedDocument[];
  total_chunks: number;
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function insertChunks(db: Db, docId: string, docKey: string, chunks: readonly Chunk[]): void {
  const insertChunk = db.prepare(
    `INSERT INTO chunks (chunk_id, course_id, document_type, doc_id, doc_key, pdf_page, printed_page,
                         chapter, unit_code, nos_code, section, subsection, content, char_count, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    'INSERT INTO chunks_fts (content, section, scope, chunk_id) VALUES (?, ?, ?, ?)',
  );

  for (const c of chunks) {
    insertChunk.run(
      c.chunk_id,
      c.course_id,
      c.document_type,
      docId,
      docKey,
      c.pdf_page,
      c.printed_page ?? null,
      c.chapter ?? null,
      c.unit_code ?? null,
      c.nos_code ?? null,
      c.section,
      c.subsection ?? null,
      c.content,
      c.char_count,
      c.ordinal,
    );
    // The scope text is derived from the chunk itself, so it can never disagree
    // with the columns a citation check reads back.
    insertFts.run(c.content, c.section, chunkScopeText({ ...c, doc_key: docKey }), c.chunk_id);
  }
}

function purgeDocument(db: Db, docId: string): void {
  // FTS5 has no foreign keys, so its rows must be removed explicitly or they
  // would keep matching queries for content no longer in `chunks`.
  db.prepare(
    'DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)',
  ).run(docId);
  db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM course_documents WHERE doc_id = ?').run(docId);
}

export interface IngestOptions {
  force?: boolean;
  /** Restrict to these document types. Defaults to all four. */
  documentTypes?: readonly DocumentType[];
}

export async function ingestCourse(courseId: string, options: IngestOptions = {}): Promise<IngestResult> {
  const course = getCourseConfig(courseId);
  const db = getDb();
  const log = logger.child({ course_id: courseId, tool_name: 'ingest_course_documents' });

  ensureCourseRegistered(courseId);

  const wanted = options.documentTypes;
  const results: IngestedDocument[] = [];

  for (const docConfig of course.documents) {
    if (wanted && !wanted.includes(docConfig.document_type)) continue;

    // The master file states structure and duration, not teachable content, and
    // it is a .docx rather than a PDF. It is read by the master-file parser when
    // timing is needed; chunking it would put routing instructions into the
    // retrievable corpus, where they could be cited as though they were content.
    if (docConfig.document_type === 'MASTER') continue;

    // A handbook course has one document per type, so the type is its key. A CDR
    // course has nine REF documents and declares a key for each.
    const docKey = docConfig.doc_key ?? docConfig.document_type;
    const file = path.join(courseDir(courseId), docConfig.file);
    const docId = `${courseId}:${docKey}`;

    if (!existsSync(file)) {
      // Per ERROR HANDLING, a missing approved document is reported, not
      // worked around. Generation tools check for this before running.
      results.push({
        document_type: docConfig.document_type,
        file,
        page_count: 0,
        chunk_count: 0,
        skipped: true,
        reason: `File not found: ${file}`,
      });
      log.warn({ document_type: docConfig.document_type, file }, 'approved source document is missing');
      continue;
    }

    const bytes = new Uint8Array(await readFile(file));
    const sum = checksum(bytes);

    const existing = db
      .prepare('SELECT checksum, page_count, chunk_count FROM course_documents WHERE doc_id = ?')
      .get(docId) as { checksum: string; page_count: number; chunk_count: number } | undefined;

    if (existing && existing.checksum === sum && !options.force) {
      results.push({
        document_type: docConfig.document_type,
        file,
        page_count: existing.page_count,
        chunk_count: existing.chunk_count,
        skipped: true,
        reason: 'Unchanged since last ingestion (checksum match).',
      });
      continue;
    }

    const extracted = await extractPdf(file);
    const chunks = chunkDocument({
      courseId,
      documentType: docConfig.document_type,
      docKey,
      pages: extracted.pages,
      noisePatterns: course.chunk_noise_patterns,
      chapterTitles: course.chapter_titles,
      ...(docConfig.printed_page_offset !== undefined
        ? { printedPageOffset: docConfig.printed_page_offset }
        : {}),
    });

    transaction(db, () => {
      purgeDocument(db, docId);
      db.prepare(
        `INSERT INTO course_documents (doc_id, course_id, document_type, doc_key, file_path,
                                       checksum, page_count, printed_page_offset, chunk_count,
                                       ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        docId,
        courseId,
        docConfig.document_type,
        docKey,
        file,
        sum,
        extracted.page_count,
        docConfig.printed_page_offset ?? null,
        chunks.length,
        nowIso(),
      );
      insertChunks(db, docId, docKey, chunks);
    });

    log.info(
      { document_type: docConfig.document_type, pages: extracted.page_count, chunks: chunks.length },
      'ingested approved source document',
    );

    results.push({
      document_type: docConfig.document_type,
      file,
      page_count: extracted.page_count,
      chunk_count: chunks.length,
      skipped: false,
    });
  }

  return {
    course_id: courseId,
    documents: results,
    total_chunks: results.reduce((a, d) => a + d.chunk_count, 0),
  };
}

/** Which approved documents are present and indexed, for the manifest tool. */
export interface DocumentStatus {
  document_type: DocumentType;
  /** Identifies the document within its course; the type for a handbook course. */
  doc_key: string;
  /** Title, for the reference documents of a CDR course. */
  title?: string;
  present: boolean;
  indexed: boolean;
  file_path: string;
  page_count: number;
  chunk_count: number;
  ingested_at?: string;
}

export function getCourseDocumentStatus(courseId: string): DocumentStatus[] {
  const course = getCourseConfig(courseId);
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT document_type, doc_key, file_path, page_count, chunk_count, ingested_at ' +
        'FROM course_documents WHERE course_id = ?',
    )
    .all(courseId) as {
    document_type: DocumentType;
    doc_key: string;
    file_path: string;
    page_count: number;
    chunk_count: number;
    ingested_at: string;
  }[];
  // Keyed on doc_key rather than on document_type: a CDR course holds nine
  // documents of type REF, so the type alone identifies nothing.
  const byKey = new Map(rows.map((r) => [r.doc_key, r]));

  return course.documents.map((d) => {
    const file = path.join(courseDir(courseId), d.file);
    const row = byKey.get(d.doc_key ?? d.document_type);
    return {
      document_type: d.document_type,
      doc_key: d.doc_key ?? d.document_type,
      ...(d.title ? { title: d.title } : {}),
      present: existsSync(file),
      indexed: row !== undefined && row.chunk_count > 0,
      file_path: file,
      page_count: row?.page_count ?? 0,
      chunk_count: row?.chunk_count ?? 0,
      ...(row?.ingested_at ? { ingested_at: row.ingested_at } : {}),
    };
  });
}
