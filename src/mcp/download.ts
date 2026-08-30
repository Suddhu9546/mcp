/**
 * Serves generated files over HTTP.
 *
 * Only files under the artifacts directory, only by a signed link or with the
 * bearer token, and only as an attachment. Signing and containment live in
 * storage/download-url.ts; this is the HTTP end of it.
 */

import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  resolveArtifactPath,
  verifyDownloadSignature,
} from '../storage/download-url.js';
import { hasValidToken } from './auth.js';
import { config } from '../util/config.js';
import { logger } from '../util/logger.js';

/** Content types for what the server actually generates. */
const CONTENT_TYPES: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Handles a request under the download path.
 *
 * Returns true if it took the request. The caller does no further routing.
 */
export function handleDownload(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const prefix = config.transport.downloadPath;
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return true;
  }

  // decodeURIComponent per segment, matching how the link was built.
  let relPath: string;
  try {
    relPath = url.pathname
      .slice(prefix.length + 1)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
  } catch {
    deny(res, 400, 'Malformed path.');
    return true;
  }

  if (relPath === '') {
    deny(res, 404, 'No file named.');
    return true;
  }

  // Two ways in: a signed link, or the bearer token an MCP client already has.
  // The token is accepted so a programmatic caller does not have to mint a link
  // to fetch what it just generated.
  const signature = verifyDownloadSignature(relPath, url.searchParams.get('expires'), url.searchParams.get('sig'));
  if (!signature.ok && !hasValidToken(req)) {
    if (signature.reason === 'expired') {
      deny(res, 410, 'This download link has expired. Ask for a fresh one.');
      return true;
    }
    logger.warn({ remote: req.socket.remoteAddress, reason: signature.reason }, 'rejected download request');
    deny(res, 403, 'Invalid or missing download signature.');
    return true;
  }

  const absolute = resolveArtifactPath(relPath);
  if (absolute === undefined) {
    // Resolution escaped the artifacts directory. Logged, because a request
    // shaped like this is not a typo.
    logger.warn({ remote: req.socket.remoteAddress, path: relPath }, 'download path escaped the artifacts root');
    deny(res, 403, 'Path is outside the artifacts directory.');
    return true;
  }

  let size: number;
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) {
      deny(res, 404, 'Not a file.');
      return true;
    }
    size = stat.size;
  } catch {
    // On a host with an ephemeral filesystem this is the ordinary case for an
    // older file, so the message says so rather than leaving the caller to
    // wonder whether the link was wrong.
    deny(
      res,
      404,
      'No such file. Generated files do not survive a restart or redeploy of this service; ' +
        'regenerate it and download it while the service is up.',
    );
    return true;
  }

  const filename = path.basename(absolute);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(size),
    // Attachment, and the filename quoted: these are documents to save, and
    // nothing here should be rendered in place by a browser.
    'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    // A signed link is a credential; caches must not keep the response.
    'Cache-Control': 'private, no-store',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  logger.info({ file: filename, bytes: size }, 'served generated file');
  createReadStream(absolute)
    .on('error', (err) => {
      logger.error({ err: err.message, file: filename }, 'download stream failed');
      res.destroy();
    })
    .pipe(res);

  return true;
}
