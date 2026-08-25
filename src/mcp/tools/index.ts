/**
 * The tool registry: one list per feature, assembled and dispatched here.
 *
 * Each feature owns its own module, and none of them imports another's tools:
 *
 *   flow.ts         the menu and the guided steps -- the entry point
 *   video-script.ts feature 2, the 1-1.5 minute AI info video for one module
 *   reading.ts      feature 3, exact handbook reading
 *   storyboard.ts   feature 1, course storyboard and assessment blueprint
 *   storyboard-build.ts  feature 1's build loop: one module out, one module back
 *   catalog.ts      handbook navigation, shared
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
import { READING_TOOLS } from './reading.js';
import { VIDEO_SCRIPT_TOOLS } from './video-script.js';
import { STORYBOARD_TOOLS, loadTemplate, loadTiming } from './storyboard.js';
import { STORYBOARD_BUILD_TOOLS } from './storyboard-build.js';

export const TOOLS: ToolDefinition[] = [
  ...FLOW_TOOLS,
  ...CATALOG_TOOLS,
  ...VIDEO_SCRIPT_TOOLS,
  ...READING_TOOLS,
  ...STORYBOARD_TOOLS,
  ...STORYBOARD_BUILD_TOOLS,
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
