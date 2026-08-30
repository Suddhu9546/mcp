/**
 * Streamable HTTP transport.
 *
 * The hosted counterpart to stdio: one long-lived process listening on a port,
 * which any number of clients connect to over one URL. This is what makes the
 * server usable as a remote connector -- a platform such as Render routes HTTP
 * to a container and cannot speak to a process over its pipes at all.
 *
 * Sessions are per-client and hold only protocol state. Every tool reads and
 * writes the shared database, so a client that reconnects with a new session
 * finds its flow, its draft and its artifacts exactly where it left them, and a
 * restart loses nothing but the connections themselves.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createStoryboardServer, TOOL_COUNT } from './build-server.js';
import { assertAuthConfigured, authorize, authEnabled, hasValidToken } from './auth.js';
import { handleDownload } from './download.js';
import { config } from '../util/config.js';
import { logger } from '../util/logger.js';

/** Largest request body accepted, guarding against an unbounded read. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, Session>();

/** Writes a JSON-RPC error, for failures that occur before a transport exists. */
function writeJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * Reads and parses a JSON request body.
 *
 * The body is parsed here rather than left to the transport because routing
 * needs it: a POST with no session header starts a session only if it carries an
 * initialize request, and the stream can be consumed only once.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** DNS-rebinding protection, on only when hosts or origins have been configured. */
function rebindingOptions() {
  const { allowedHosts, allowedOrigins } = config.transport;
  if (allowedHosts.length === 0 && allowedOrigins.length === 0) return {};
  return {
    enableDnsRebindingProtection: true,
    ...(allowedHosts.length > 0 ? { allowedHosts: [...allowedHosts] } : {}),
    ...(allowedOrigins.length > 0 ? { allowedOrigins: [...allowedOrigins] } : {}),
  };
}

/** Builds a new session and connects a freshly-registered server to it. */
async function openSession(): Promise<Session> {
  const server = createStoryboardServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, session);
      logger.info({ session_id: sessionId, sessions: sessions.size }, 'mcp session opened');
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
      logger.info({ session_id: sessionId, sessions: sessions.size }, 'mcp session closed');
    },
    ...rebindingOptions(),
  });

  const session: Session = { server, transport };

  // A transport that closes for any other reason -- a dropped connection, a
  // client that vanished -- must not leave its server registered, or the map
  // grows for the lifetime of the process.
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
    void server.close();
  };

  await server.connect(transport);
  return session;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionHeader = req.headers['mcp-session-id'];
  const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
  const existing = sessionId === undefined ? undefined : sessions.get(sessionId);

  if (req.method === 'POST') {
    const body = await readJsonBody(req);

    if (existing) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    if (sessionId !== undefined) {
      // A named session this process does not have. Saying so is more useful
      // than silently starting a new one, which would strand the client's
      // protocol state without telling it.
      writeJsonRpcError(res, 404, -32001, 'Unknown or expired MCP session. Re-initialize to continue.');
      return;
    }

    if (!isInitializeRequest(body)) {
      writeJsonRpcError(res, 400, -32000, 'No mcp-session-id header, and the request is not initialize.');
      return;
    }

    const session = await openSession();
    await session.transport.handleRequest(req, res, body);
    return;
  }

  // GET opens the server-to-client notification stream and DELETE ends the
  // session. Both act on a session that already exists.
  if (req.method === 'GET' || req.method === 'DELETE') {
    if (!existing) {
      writeJsonRpcError(res, 404, -32001, 'Unknown or expired MCP session.');
      return;
    }
    await existing.transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405, { Allow: 'POST, GET, DELETE' });
  res.end();
}

/**
 * Starts the HTTP listener and resolves once it is accepting connections.
 *
 * Returns a shutdown function that closes every session before the listener, so
 * clients are told the server is going away rather than finding a dead socket.
 */
export async function startHttpTransport(): Promise<() => Promise<void>> {
  const { port, host, path: mcpPath } = config.transport;

  // Before the socket opens, so a deployment that would have been open to the
  // world fails to start instead of appearing healthy.
  assertAuthConfigured();

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // A health endpoint that touches neither the database nor a session, so a
    // platform's check reports on the listener and nothing else.
    if (url.pathname === '/healthz') {
      // Deliberately unauthenticated: a platform's health check cannot carry a
      // token. It therefore reports only that the process is up, with the
      // session count -- which is operational detail about who is connected --
      // added only for a caller that has authenticated.
      const authorized = !authEnabled() || hasValidToken(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          tools: TOOL_COUNT,
          ...(authorized ? { sessions: sessions.size } : {}),
        }),
      );
      return;
    }

    // Generated files, before the bearer gate: a signed link carries its own
    // proof and is opened by a browser, which cannot send an Authorization
    // header. handleDownload does its own authorisation.
    if (handleDownload(req, res, url)) return;

    if (url.pathname !== mcpPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${mcpPath}.` }));
      return;
    }

    // Everything past this point reaches the tools, so it is authenticated
    // first -- before the body is read and before a session is created.
    if (!authorize(req, res)) return;

    handleMcp(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'request failed');
      writeJsonRpcError(res, 500, -32603, 'Internal server error.');
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  logger.info(
    { tools: TOOL_COUNT, host, port, path: mcpPath },
    'storyboard MCP server ready on streamable http',
  );

  return async () => {
    for (const session of [...sessions.values()]) {
      await session.transport.close().catch(() => undefined);
    }
    sessions.clear();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
}
