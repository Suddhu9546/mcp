/**
 * Resolves a rendered document's fields in place, so its page numbers are real.
 *
 * The table of contents is a Word `TOC` field and each entry's page number is a
 * `PAGEREF`. Both are computed from where the text actually falls on the page,
 * which needs a layout engine -- and this server has none. What the renderer can
 * emit is the field with an empty cached result, which Word fills the moment the
 * document is opened.
 *
 * That is not good enough on its own: a viewer that renders cached field results
 * rather than resolving them -- most previewers, and anything that is not Word --
 * shows the entries with their dot leaders and no numbers, which is not what the
 * reference document looks like. So after rendering, the document is handed to Word
 * once to update its fields and save. The numbers are then in the file and every
 * viewer shows them.
 *
 * This is the one place the pipeline reaches outside itself, and it is deliberately
 * the last step and a soft one. It runs after the byte-faithful document has
 * already been written, so a machine with no Word still produces a correct
 * storyboard -- one whose page numbers appear the first time it is opened in Word
 * instead of immediately. Failure is reported, never thrown: a missing Word is a
 * degraded page-number cache, not a failed render.
 *
 * Word rewrites the package when it saves, so the output is no longer
 * byte-identical to the template's parts. That check belongs to the renderer's own
 * output and is asserted there, before this runs.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../util/logger.js';

const run = promisify(execFile);

export interface FieldRefreshResult {
  refreshed: boolean;
  /** Why not, when it did not happen. Surfaced to the client, never thrown. */
  reason?: string;
}

/**
 * Word's automation entry point, driven through PowerShell.
 *
 * `Fields.Update()` alone does not always settle a table of contents whose entries
 * moved, so the TOC is updated explicitly first and the whole field set after it.
 * Repagination is forced before saving, because Word computes page numbers lazily
 * and would otherwise write the numbers it had before the update.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = $env:SB_REFRESH_DOCX
$word = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($path, $false, $false)
  try {
    foreach ($toc in $doc.TablesOfContents) { $toc.Update() | Out-Null }
    $doc.Fields.Update() | Out-Null
    $doc.Repaginate()
    $doc.Save()
  } finally {
    $doc.Close(0)
  }
  Write-Output 'refreshed'
} finally {
  if ($word -ne $null) {
    $word.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
  }
}
`.trim();

/**
 * Asks Word to resolve the document's fields and save it.
 *
 * Returns whether it happened. The caller reports that to the client so a reader
 * knows whether the page numbers in the file are final or are waiting on a first
 * open in Word.
 */
export async function refreshDocxFields(file: string, timeoutMs = 120_000): Promise<FieldRefreshResult> {
  if (process.platform !== 'win32') {
    return { refreshed: false, reason: 'Field refresh needs Word, which is Windows-only.' };
  }

  try {
    // The path travels in the environment rather than on the command line: a
    // `param()` block is not valid with -Command, and interpolating a Windows path
    // into a script string invites a quoting bug the first time a folder has a
    // space or an apostrophe in it.
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, SB_REFRESH_DOCX: file },
      },
    );
    if (stdout.includes('refreshed')) return { refreshed: true };
    return { refreshed: false, reason: 'Word did not report a successful update.' };
  } catch (err) {
    // A machine without Word, a COM permission problem, or a timeout. None of
    // them makes the document wrong, so none of them fails the render.
    const reason = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    logger.warn({ file, reason }, 'could not refresh document fields');
    return {
      refreshed: false,
      reason: `Word could not be used to resolve page numbers (${reason}). The document is ` +
        'correct; its table of contents will fill in its page numbers the first time it is ' +
        'opened in Word.',
    };
  }
}
