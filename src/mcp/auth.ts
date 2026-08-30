/**
 * Bearer-token authentication for the HTTP endpoint.
 *
 * The endpoint needs guarding because of what is behind it: every tool, and
 * through them the whole indexed course corpus. A URL is not a secret -- it
 * appears in logs, proxies and client configuration files -- so reaching the
 * tools requires presenting a token.
 *
 * A shared secret rather than OAuth, deliberately. OAuth would mean storing
 * dynamically-registered clients and issued tokens, and on a host with an
 * ephemeral filesystem that store is erased whenever the service restarts,
 * which would break every connected client roughly every time it idled. A token
 * in an environment variable survives exactly as long as the deployment does.
 *
 * Under stdio there is nothing to authenticate: the client already owns the
 * process it spawned.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../util/config.js';
import { logger } from '../util/logger.js';

/** Shortest token accepted, so a placeholder cannot pass for protection. */
const MIN_TOKEN_LENGTH = 16;

/**
 * Fixed-length digest of a token.
 *
 * Comparison is done over digests because `timingSafeEqual` requires equal
 * lengths and would otherwise throw -- and rejecting early on a length mismatch
 * would leak the token's length through timing.
 */
function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

const acceptedDigests = config.transport.authTokens.map(digest);

/** Reads a bearer token from the Authorization header. */
function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Whether a presented token is one of the accepted ones.
 *
 * Every candidate is compared even after a match, so the time taken does not
 * reveal which token matched or how far down the list it was.
 */
function tokenAccepted(presented: string): boolean {
  const presentedDigest = digest(presented);
  let matched = false;
  for (const accepted of acceptedDigests) {
    if (timingSafeEqual(presentedDigest, accepted)) matched = true;
  }
  return matched;
}

/**
 * Validates configuration before the listener opens.
 *
 * This throws rather than warning. A misconfigured deployment that starts
 * anyway is an open endpoint that looks healthy, and the only moment it can be
 * caught cheaply is startup.
 */
export function assertAuthConfigured(): void {
  const { authTokens, allowAnonymous } = config.transport;

  if (authTokens.length === 0) {
    if (!allowAnonymous) {
      throw new Error(
        'Refusing to serve HTTP with no authentication. Set MCP_AUTH_TOKEN to a long random ' +
          'secret, or set MCP_ALLOW_ANONYMOUS=true if this endpoint really should be open. ' +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    logger.warn(
      'serving MCP over HTTP with NO authentication -- every tool is open to anyone who can reach this port',
    );
    return;
  }

  const short = authTokens.filter((t) => t.length < MIN_TOKEN_LENGTH);
  if (short.length > 0) {
    throw new Error(
      `${short.length} configured auth token(s) are shorter than ${MIN_TOKEN_LENGTH} characters. ` +
        'A guessable token is not protection; use a long random secret.',
    );
  }

  logger.info({ tokens: authTokens.length }, 'bearer authentication enabled');
}

/**
 * Whether a request carries an accepted token.
 *
 * Answers the question without writing a response, for a caller that wants to
 * vary what it returns rather than reject outright.
 */
export function hasValidToken(req: IncomingMessage): boolean {
  const presented = bearerToken(req);
  return presented !== undefined && tokenAccepted(presented);
}

/**
 * Enforces authentication on a request.
 *
 * Returns true when the request may proceed. When it may not, the response has
 * already been completed and the caller must stop.
 */
export function authorize(req: IncomingMessage, res: ServerResponse): boolean {
  if (acceptedDigests.length === 0) return true; // Anonymous, warned about at startup.

  const presented = bearerToken(req);

  if (presented !== undefined && tokenAccepted(presented)) return true;

  // The client's address is logged, never the token or the header. A rejected
  // secret is still a secret, and it is frequently a valid one sent to the
  // wrong place.
  logger.warn(
    { remote: req.socket.remoteAddress, reason: presented === undefined ? 'no bearer token' : 'token rejected' },
    'unauthorized MCP request',
  );

  res.writeHead(401, {
    'Content-Type': 'application/json',
    // Names the scheme so a client knows what to send rather than guessing.
    'WWW-Authenticate': 'Bearer realm="cvc-storyboard-mcp"',
  });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized. Send Authorization: Bearer <token>.' },
      id: null,
    }),
  );
  return false;
}

/** Whether authentication is in force, for reporting. */
export function authEnabled(): boolean {
  return acceptedDigests.length > 0;
}
