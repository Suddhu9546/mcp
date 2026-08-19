import pino from 'pino';
import { config } from './config.js';

/**
 * Structured logger.
 *
 * Two constraints from the spec:
 *  - Never log complete source documents or long proprietary spans (SECURITY,
 *    OBSERVABILITY). Use `redactContent` for anything derived from a course
 *    document.
 *  - Under stdio transport, stdout is the MCP wire protocol. All logging must go
 *    to stderr or it will corrupt the session.
 */
export const logger = pino(
  {
    level: config.logLevel,
    base: undefined,
    formatters: {
      level: (label) => ({ level: label }),
    },
  },
  pino.destination(2),
);

/** Truncate proprietary text to a length that is useful for debugging only. */
export function redactContent(text: string, keep = 120): string {
  if (text.length <= keep) return text;
  return `${text.slice(0, keep)}... [+${text.length - keep} chars]`;
}

export type ToolLogContext = {
  tool_name: string;
  course_id?: string;
  artifact_id?: string;
  version?: number;
  document_type?: string;
};

export function toolLogger(ctx: ToolLogContext) {
  return logger.child(ctx);
}
