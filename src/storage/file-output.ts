/**
 * Written deliverables.
 *
 * The video script and the subtitle track are text, and for a while that was the
 * whole story: the user copied them out of the reply. But a 3-minute script with
 * eighteen fully specified segments runs to tens of kilobytes, which is past the
 * point where copying out of a chat window is pleasant, and the deck was already a
 * file. So everything a generation produces is also written to disk under the
 * package's own directory, and the tools return the paths for the client to attach.
 *
 * The text is still returned inline as well. Both, not either: reading the script in
 * the reply and downloading it are different needs, and the file costs nothing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../util/config.js';

export interface WrittenFile {
  /** Absolute path, for the client to attach or open. */
  path: string;
  filename: string;
  bytes: number;
  /** What this file is, so a client can label it without parsing the name. */
  kind: 'video_script' | 'subtitles' | 'deck_text' | 'deck_pptx' | 'transcript';
}

/** One directory per artifact, so a package's files stay together. */
export function artifactDir(artifactId: string): string {
  const dir = path.join(config.paths.artifacts, artifactId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArtifactFile(
  artifactId: string,
  filename: string,
  contents: string | Uint8Array,
  kind: WrittenFile['kind'],
): WrittenFile {
  const file = path.join(artifactDir(artifactId), filename);
  const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
  writeFileSync(file, bytes);
  return { path: file, filename, bytes: bytes.length, kind };
}

/**
 * The name a file gets.
 *
 * Version is in the name rather than only in the directory, because a user who has
 * downloaded v3 and then v5 needs to be able to tell them apart in their downloads
 * folder without opening either.
 */
export function moduleFilename(
  moduleNumber: number,
  what: 'video-script' | 'subtitles' | 'deck',
  version: number,
  extension: string,
): string {
  return `module-${moduleNumber}-${what}-v${version}.${extension}`;
}
