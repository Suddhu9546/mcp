/**
 * Signed download links for generated files.
 *
 * A hosted server has a problem a local one does not: the .docx it just wrote
 * is on its own filesystem, and the person who asked for it is somewhere else.
 * A local path in the reply is useless to them. So the file needs a URL.
 *
 * The link is signed and carries an expiry rather than requiring the bearer
 * token, because the thing that finally opens it is a browser, and a browser
 * cannot be told to send an Authorization header by a link. The signature
 * covers the path and the expiry, so neither can be edited, and it is derived
 * from the auth token rather than being it -- a leaked link exposes one
 * document until it expires, not the tools.
 *
 * The trade is that the link is a bearer credential for that one file while it
 * lives: it will sit in browser history and in whatever chat it was pasted
 * into. That is why it expires, and why it grants exactly one path.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { config } from '../util/config.js';

/**
 * Key the signatures are derived from.
 *
 * The first configured auth token, so links survive a restart -- the same
 * deployment keeps issuing verifiable links. With no token configured (the
 * anonymous dev case) a random per-process key is used instead, which means
 * links stop verifying when the process restarts. That is the correct failure
 * for a mode that has no secret to bind them to.
 */
const signingKey =
  config.transport.authTokens[0] ?? randomBytes(32).toString('hex');

/** Signature over the file's path and its expiry. */
function sign(relPath: string, expires: number): string {
  return createHmac('sha256', signingKey).update(`${relPath}\n${expires}`).digest('hex');
}

/**
 * The artifacts directory, resolved once.
 *
 * Every servable file lives under it. Nothing outside is reachable, which is
 * what makes a path from a URL safe to act on.
 */
const artifactsRoot = path.resolve(config.paths.artifacts);

/**
 * Path of a file relative to the artifacts directory, in URL form.
 *
 * Returns undefined for anything outside that directory -- such a file is not
 * servable, and quietly building a URL for it would be how a path-traversal
 * hole gets introduced from the inside.
 */
export function artifactRelativePath(absolutePath: string): string | undefined {
  const resolved = path.resolve(absolutePath);
  const rel = path.relative(artifactsRoot, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

/**
 * Resolves a URL path back to a file, or undefined if it escapes the root.
 *
 * The containment check is done after resolution, so `..` segments and encoded
 * separators are already collapsed and cannot smuggle a path past it.
 */
export function resolveArtifactPath(relPath: string): string | undefined {
  const resolved = path.resolve(artifactsRoot, relPath);
  if (resolved !== artifactsRoot && !resolved.startsWith(artifactsRoot + path.sep)) return undefined;
  return resolved;
}

export type DownloadLink = {
  url: string;
  expires_at: string;
};

/**
 * A signed, expiring URL for a generated file.
 *
 * Undefined when no public URL is configured, which is the stdio case: the file
 * is already on the machine that asked for it and `docx_path` is the better
 * answer.
 */
export function downloadLinkFor(absolutePath: string, now = new Date()): DownloadLink | undefined {
  const { publicUrl, downloadPath, downloadTtlSeconds } = config.transport;
  if (publicUrl === '') return undefined;

  const rel = artifactRelativePath(absolutePath);
  if (rel === undefined) return undefined;

  const expires = Math.floor(now.getTime() / 1000) + downloadTtlSeconds;
  const signature = sign(rel, expires);
  // Each segment is encoded separately so the separators survive.
  const encoded = rel.split('/').map(encodeURIComponent).join('/');

  return {
    url: `${publicUrl}${downloadPath}/${encoded}?expires=${expires}&sig=${signature}`,
    expires_at: new Date(expires * 1000).toISOString(),
  };
}

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid' };

/** Verifies a link's expiry and signature. */
export function verifyDownloadSignature(
  relPath: string,
  expires: string | null,
  signature: string | null,
  now = new Date(),
): SignatureCheck {
  if (expires === null || signature === null) return { ok: false, reason: 'missing' };

  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'invalid' };

  // Expiry is checked before the signature so an old link is reported as old
  // rather than as forged, which is the difference between "ask for a fresh
  // link" and "something is wrong".
  if (expiresAt * 1000 < now.getTime()) return { ok: false, reason: 'expired' };

  const expected = Buffer.from(sign(relPath, expiresAt), 'utf8');
  const presented = Buffer.from(signature, 'utf8');
  if (expected.length !== presented.length) return { ok: false, reason: 'invalid' };
  if (!timingSafeEqual(expected, presented)) return { ok: false, reason: 'invalid' };

  return { ok: true };
}
