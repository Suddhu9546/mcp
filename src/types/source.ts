/**
 * Source traceability primitives.
 *
 * INVARIANT 5 / 6: every generated content element and every timing value must
 * carry a reference back to the approved document it came from. These types are
 * the mechanism, so they are deliberately non-optional wherever a value is
 * generated rather than copied.
 */

/**
 * The approved document types. Nothing outside this set is a valid source.
 *
 * QP/PH/FG/TIMING describe an SCGJ qualification course, where one Participant
 * Handbook carries every module. REF/MASTER describe a CDR course, which has no
 * handbook: it draws each module from a different reference document (REF), and a
 * master file (MASTER) states which document that is and how long the module runs.
 * A REF chunk therefore carries a doc_key, because "which document" is a real
 * question for those courses in a way it is not for a handbook course.
 */
export type DocumentType = 'QP' | 'PH' | 'FG' | 'TIMING' | 'REF' | 'MASTER';

export const DOCUMENT_TYPES: readonly DocumentType[] = [
  'QP',
  'PH',
  'FG',
  'TIMING',
  'REF',
  'MASTER',
] as const;

/**
 * A pointer into an approved source document.
 *
 * Both page numbers are recorded because they disagree in the SCGJ documents:
 * the Participant Handbook's printed page numbers run ~10 behind the PDF page
 * index, and the tables of contents cite the printed number. Citations that
 * record only one of the two cannot be checked by a human holding the PDF.
 */
export interface SourceRef {
  document_type: DocumentType;
  /** Which reference document, for a course whose modules each have their own. */
  doc_key?: string;
  /** 1-based index of the page within the PDF file. Always present. */
  pdf_page: number;
  /** Page number printed on the page itself, when one was detected. */
  printed_page?: number;
  /** Nearest enclosing heading, e.g. "UNIT 1.1: Fundamentals of Biofuels and Biomass Energy". */
  section: string;
  subsection?: string;
  /** Chunk this reference resolves to, for exact re-retrieval during audit. */
  chunk_id: string;
  /**
   * Verbatim span from the source that supports the generated content. Kept so
   * validation and audit never have to re-fetch the chunk to check a claim.
   */
  quote?: string;
}

/** Where a duration came from. Timing may never originate in model judgement. */
export type TimingProvenance =
  /** Read verbatim from the Timing Allocation Document. */
  | { kind: 'timing_document'; ref: SourceRef; raw: string }
  /** Computed by a named, deterministic rule from timing-document values. */
  | { kind: 'derived'; rule: string; inputs: string[]; ref: SourceRef }
  /**
   * Fixed by the storyboard template's own structure (e.g. Part B is always a
   * 15-minute video in five 3-minute segments). Not curriculum time.
   */
  | { kind: 'template_constant'; template_version: string; note: string };

/** Attached to any field whose content was supplied by the client. */
export interface Traced<T> {
  value: T;
  sources: SourceRef[];
}

/**
 * Returned instead of content when the approved documents cannot support a
 * request. Never substitute model knowledge for this.
 */
export interface InsufficientSource {
  status: 'INSUFFICIENT_SOURCE_CONTENT';
  /** What was asked for. */
  requested: string;
  /** Which documents were searched, so the gap is auditable. */
  searched: readonly DocumentType[];
  /** Human-readable explanation surfaced to the user verbatim. */
  message: string;
}

export function isInsufficientSource(x: unknown): x is InsufficientSource {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as InsufficientSource).status === 'INSUFFICIENT_SOURCE_CONTENT'
  );
}
