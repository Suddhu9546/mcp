#!/usr/bin/env node
/**
 * Storyboard MCP server -- entrypoint.
 *
 * This file chooses a transport and nothing else. What the server *is* -- its
 * instructions and its tools -- lives in build-server.ts, so both transports
 * expose exactly the same thing.
 *
 *   stdio  the client spawns this process and speaks the protocol over its
 *          pipes. The local default, and what Antigravity, Gemini CLI and
 *          Claude Code use from .mcp.json.
 *   http   the process listens on a port and any number of clients connect to
 *          one URL. What a hosted deployment needs.
 *
 * Under stdio, stdout is the MCP wire protocol, so nothing may be written to
 * it. All logging goes to stderr via the shared logger.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStoryboardServer, TOOL_COUNT } from './build-server.js';
import { startHttpTransport } from './http.js';
import { ensureAllCoursesRegistered } from '../courses/course-manager.js';
import { closeDb } from '../storage/db.js';
import { config } from '../util/config.js';
import { logger } from '../util/logger.js';

/** Closes the listener, if one was started, before the database. */
let stopTransport: (() => Promise<void>) | undefined;

async function main(): Promise<void> {
  // Registering configured courses up front means list_courses works on a fresh
  // database, before anything has been ingested.
  ensureAllCoursesRegistered();

  // A --http flag overrides MCP_TRANSPORT, so http mode can be started from a
  // script on any shell without a platform-specific way to set a variable.
  const mode = process.argv.includes('--http') ? 'http' : config.transport.mode;

  if (mode === 'http') {
    stopTransport = await startHttpTransport();
    return;
  }

  if (mode !== 'stdio') {
    throw new Error(`MCP_TRANSPORT must be "stdio" or "http", got "${mode}".`);
  }

  const server = createStoryboardServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ tools: TOOL_COUNT }, 'storyboard MCP server ready on stdio');
}

let shuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // A platform sends SIGTERM on every deploy and restart, and sends it again
    // if the process is slow to go. Draining twice would double-close the
    // database, so the first signal wins.
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        await stopTransport?.();
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'transport shutdown failed');
      }
      closeDb();
      process.exit(0);
    })();
  });
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'server failed to start');
  process.exit(1);
});
