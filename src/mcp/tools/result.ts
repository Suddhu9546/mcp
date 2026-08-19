/**
 * The shape of a tool and of its result.
 *
 * Extracted so that tool modules for different flows share one definition without
 * importing each other: the storyboard tools and the video tools both depend on
 * this file and neither depends on the other.
 */

import type { z } from 'zod';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /** The MCP SDK's result type permits arbitrary extra keys. */
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

/** Serializes a result as JSON, which is what the client consumes. */
export function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function fail(message: string, detail?: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { status: 'error', message, ...(detail !== undefined ? { detail } : {}) },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/**
 * Returns text rather than JSON, for output a person will read or copy.
 *
 * The video flows deliberately produce no file, so their deliverable is the text in
 * the result itself; a second content block carries the machine-readable metadata
 * that would otherwise have to be wrapped around it.
 */
export function textResult(body: string, meta?: Record<string, unknown>): ToolResult {
  return {
    content: [
      { type: 'text', text: body },
      ...(meta ? [{ type: 'text' as const, text: JSON.stringify(meta, null, 2) }] : []),
    ],
  };
}
