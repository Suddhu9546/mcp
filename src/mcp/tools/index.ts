/**
 * The tool registry: one list per feature, assembled and dispatched here.
 *
 * Each feature owns its own module, and none of them imports another's tools:
 *
 *   flow.ts         the menu and the guided steps -- the entry point
 *   module.ts       feature 1, module content: video script, subtitles, deck
 *   reading.ts      feature 3, exact handbook reading
 *   storyboard.ts   feature 2, course storyboard and assessment blueprint
 *   storyboard-tasks.ts  feature 2's build loop: one task out, one task back
 *   catalog.ts      handbook navigation shared by the reading and content flows
 *   transcript.ts   the narrower single-unit script, outside the guided flow
 *   result.ts       the tool shape and the result helpers everything shares
 *
 * The ordering below is the order the client sees, so the flow tools come first
 * and each feature's tools stay contiguous.
 *
 * Division of responsibility, unchanged across every feature:
 *
 *   Client (Antigravity / Gemini / Claude)   This server
 *   --------------------------------------   ------------------------------
 *   decides which tools to call              executes the requested operation
 *   decides the order                        returns structured results
 *   writes the content                       supplies scoped source material
 *   interprets validation findings           reports findings mechanically
 *   decides how to fix problems              never edits content on its own
 *
 * Every handler is a pure function of its arguments plus the indexed corpus. None
 * calls a model, and none writes content the client did not supply.
 */

export type { ToolDefinition, ToolResult } from './result.js';
import type { ToolDefinition, ToolResult } from './result.js';
import { fail, ok } from './result.js';
import { FLOW_TOOLS } from './flow.js';
import { CATALOG_TOOLS } from './catalog.js';
import { MODULE_TOOLS } from './module.js';
import { READING_TOOLS } from './reading.js';
import { STORYBOARD_TOOLS, loadTemplate, loadTiming } from './storyboard.js';
import { STORYBOARD_TASK_TOOLS } from './storyboard-tasks.js';
import { TRANSCRIPT_TOOLS } from './transcript.js';

export const TOOLS: ToolDefinition[] = [
  ...FLOW_TOOLS,
  ...CATALOG_TOOLS,
  ...MODULE_TOOLS,
  ...READING_TOOLS,
  ...STORYBOARD_TOOLS,
  ...STORYBOARD_TASK_TOOLS,
  ...TRANSCRIPT_TOOLS,
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/**
 * Invokes a tool, converting any thrown error into an error *result*.
 *
 * Error handling belongs here rather than in the transport: a thrown exception
 * would surface to the client as a protocol failure with no actionable detail,
 * whereas a result carries the explanation the client needs to correct its next
 * call. Keeping it in the tool layer also means every caller -- the MCP server,
 * tests, scripts -- gets the same behaviour.
 */
export async function runTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) {
    return fail(`No tool named "${name}". Available: ${TOOLS.map((t) => t.name).join(', ')}.`);
  }
  try {
    return await tool.handler(args);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), { tool: name });
  }
}

export { fail, ok, loadTiming, loadTemplate };
