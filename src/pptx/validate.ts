/**
 * Package integrity validation for generated .pptx files.
 *
 * PowerPoint's response to an invalid package is a single unhelpful sentence -- "the
 * file or directory is corrupted and unreadable" -- with no indication of which part
 * it objected to. The bug that produced it here was that the slide master and the
 * notes master referenced one shared theme part: valid XML, resolves cleanly,
 * rejected outright. Nothing short of bisecting the package found it.
 *
 * So the checks below are the ones that would have caught it, plus the rest of the
 * class it belongs to: structural rules a package must satisfy that no amount of
 * well-formed XML guarantees. They run on every render, and a render that fails them
 * throws instead of writing a file -- an error a caller can read beats a file
 * PowerPoint refuses.
 */

import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

export interface PackageFinding {
  severity: 'error' | 'warning';
  code: string;
  part?: string;
  message: string;
}

const REQUIRED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'ppt/presentation.xml',
  'ppt/_rels/presentation.xml.rels',
];

const RELATIONSHIP_RE = /<Relationship\b[^>]*>/g;

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

const PML = 'application/vnd.openxmlformats-officedocument.presentationml';

/**
 * The content type a part must declare, where the part's path fixes it.
 *
 * Returns undefined for parts whose type is genuinely open (media, custom XML),
 * which the extension Defaults cover.
 */
function expectedContentType(part: string): string | undefined {
  if (part === 'ppt/presentation.xml') return `${PML}.presentation.main+xml`;
  if (/^ppt\/slides\/slide\d+\.xml$/.test(part)) return `${PML}.slide+xml`;
  if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(part)) return `${PML}.slideLayout+xml`;
  if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(part)) return `${PML}.slideMaster+xml`;
  if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(part)) return `${PML}.notesSlide+xml`;
  if (/^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(part)) return `${PML}.notesMaster+xml`;
  if (/^ppt\/theme\/theme\d+\.xml$/.test(part)) {
    return 'application/vnd.openxmlformats-officedocument.theme+xml';
  }
  return undefined;
}

/** Resolves a relationship target against the part that declared it. */
function resolveTarget(relsPart: string, target: string): string {
  const dir = relsPart.replace(/_rels\/[^/]+$/, '');
  const out: string[] = [];
  for (const segment of `${dir}${target}`.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/**
 * Checks a rendered package.
 *
 * Deliberately independent of the code that wrote it: it reads the zip back and
 * reasons only about what is in the file, so a writer that forgets a part or points
 * a relationship at the wrong place is caught rather than trusted.
 */
export async function validatePptxPackage(bytes: Uint8Array): Promise<PackageFinding[]> {
  const findings: PackageFinding[] = [];
  let zip: JSZip;
  try {
    // createFolders:false, or JSZip synthesises the folder entries it is being
    // asked about and every package looks like it has them.
    zip = await JSZip.loadAsync(bytes, { createFolders: false });
  } catch (err) {
    return [
      {
        severity: 'error',
        code: 'unreadable_zip',
        message: `Not a readable zip: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
  const directories = Object.keys(zip.files).filter((n) => zip.files[n]!.dir);
  if (directories.length > 0) {
    findings.push({
      severity: 'error',
      code: 'directory_entries',
      message:
        `The package contains ${directories.length} directory entries (${directories[0]} ...). Every ` +
        'item in an OPC package must be a part or the content-types stream.',
    });
  }

  for (const required of REQUIRED_PARTS) {
    if (!names.includes(required)) {
      findings.push({
        severity: 'error',
        code: 'missing_part',
        part: required,
        message: 'Required part is missing.',
      });
    }
  }
  if (findings.some((f) => f.code === 'missing_part')) return findings;

  // --- every part well-formed, and free of characters XML forbids -------
  const text = new Map<string, string>();
  for (const name of names) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const xml = await zip.file(name)!.async('string');
    text.set(name, xml);

    const errors: string[] = [];
    let root: unknown;
    try {
      const doc = new DOMParser({
        onError: (level, message) => {
          if (level !== 'warning') errors.push(String(message));
        },
      }).parseFromString(xml, 'text/xml');
      root = doc?.documentElement;
    } catch (err) {
      // A parser that throws is reporting the same thing as one that reports: the
      // part is not usable. Either way it becomes a finding, not an exception.
      errors.push(err instanceof Error ? err.message : String(err));
    }
    if (errors.length > 0 || !root) {
      findings.push({
        severity: 'error',
        code: 'malformed_xml',
        part: name,
        message: `Not well-formed XML: ${errors.join('; ').slice(0, 200)}`,
      });
    }

    const control = [...xml].find((c) => {
      const code = c.charCodeAt(0);
      return code < 0x20 && c !== '\n' && c !== '\t' && c !== '\r';
    });
    if (control !== undefined) {
      findings.push({
        severity: 'error',
        code: 'control_character',
        part: name,
        message: `Contains control character 0x${control.charCodeAt(0).toString(16)}, which XML forbids.`,
      });
    }
  }

  // --- content types cover every part, and describe nothing absent ------
  const contentTypes = text.get('[Content_Types].xml') ?? '';
  const defaults = new Set(
    [...contentTypes.matchAll(/<Default\b[^>]*Extension="([^"]+)"/g)].map((m) => m[1]!.toLowerCase()),
  );
  const overrideTags = [...contentTypes.matchAll(/<Override\b[^>]*\/>/g)].map((m) => m[0]);
  const overrideTypes = new Map<string, string>(
    overrideTags.map((tag) => [
      (attr(tag, 'PartName') ?? '').replace(/^\//, ''),
      attr(tag, 'ContentType') ?? '',
    ]),
  );
  const overrides = new Set(overrideTypes.keys());
  for (const name of names) {
    if (name === '[Content_Types].xml') continue;
    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    const expected = expectedContentType(name);
    if (expected !== undefined) {
      // A PresentationML part needs its own Override. The `xml` Default satisfies
      // the OPC rules but tells PowerPoint the part is generic XML, and it then
      // rejects the package -- the same opaque failure as a missing part.
      if (!overrides.has(name)) {
        findings.push({
          severity: 'error',
          code: 'no_content_type',
          part: name,
          message: `Needs an explicit Override of type ${expected}; the xml Default is not enough.`,
        });
      }
      continue;
    }
    if (!overrides.has(name) && !defaults.has(extension)) {
      findings.push({
        severity: 'error',
        code: 'no_content_type',
        part: name,
        message: 'No content type: needs an Override, or a Default for its extension.',
      });
    }
  }
  for (const [part, declared] of overrideTypes) {
    const expected = expectedContentType(part);
    if (expected !== undefined && declared !== expected) {
      findings.push({
        severity: 'error',
        code: 'wrong_content_type',
        part,
        message: `Declared as "${declared}" but PowerPoint expects "${expected}".`,
      });
    }
  }
  for (const override of overrides) {
    if (!names.includes(override)) {
      findings.push({
        severity: 'error',
        code: 'content_type_without_part',
        part: override,
        message: 'Declared in [Content_Types].xml but not present in the package.',
      });
    }
  }

  // --- relationships resolve --------------------------------------------
  const relationships = new Map<string, Map<string, { target: string; type: string }>>();
  for (const [name, xml] of text) {
    if (!name.endsWith('.rels')) continue;
    const map = new Map<string, { target: string; type: string }>();
    for (const tag of xml.match(RELATIONSHIP_RE) ?? []) {
      const id = attr(tag, 'Id');
      const target = attr(tag, 'Target');
      const type = attr(tag, 'Type') ?? '';
      const mode = attr(tag, 'TargetMode');
      if (!id || !target) {
        findings.push({
          severity: 'error',
          code: 'malformed_relationship',
          part: name,
          message: `Relationship without Id or Target: ${tag.slice(0, 80)}`,
        });
        continue;
      }
      if (mode === 'External' || /^https?:/.test(target)) {
        map.set(id, { target, type });
        continue;
      }
      const resolved = resolveTarget(name, target);
      if (!names.includes(resolved)) {
        findings.push({
          severity: 'error',
          code: 'dangling_relationship',
          part: name,
          message: `${id} points at "${target}" (${resolved}), which is not in the package.`,
        });
      }
      map.set(id, { target: resolved, type });
    }
    relationships.set(name, map);
  }

  // --- presentation.xml references only ids its .rels declares ----------
  const presentation = text.get('ppt/presentation.xml') ?? '';
  const presentationRels = relationships.get('ppt/_rels/presentation.xml.rels') ?? new Map();
  for (const match of presentation.matchAll(/r:id="([^"]+)"/g)) {
    if (!presentationRels.has(match[1]!)) {
      findings.push({
        severity: 'error',
        code: 'unresolved_rid',
        part: 'ppt/presentation.xml',
        message: `References ${match[1]}, which its .rels does not declare.`,
      });
    }
  }

  const slideParts = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const slideIdCount = (presentation.match(/<p:sldId\b/g) ?? []).length;
  if (slideIdCount !== slideParts.length) {
    findings.push({
      severity: 'error',
      code: 'slide_count_mismatch',
      part: 'ppt/presentation.xml',
      message: `The slide id list has ${slideIdCount} entries but the package holds ${slideParts.length} slide parts.`,
    });
  }

  // --- one theme part per master ----------------------------------------
  // The defect this file exists for.
  const themeUsers = new Map<string, string[]>();
  for (const [relsPart, map] of relationships) {
    if (!/(slideMasters|notesMasters|handoutMasters)\/_rels\//.test(relsPart)) continue;
    for (const { target, type } of map.values()) {
      if (!type.endsWith('/theme')) continue;
      const users = themeUsers.get(target) ?? [];
      users.push(relsPart.replace('/_rels', '').replace(/\.rels$/, ''));
      themeUsers.set(target, users);
    }
  }
  for (const [theme, users] of themeUsers) {
    if (users.length > 1) {
      findings.push({
        severity: 'error',
        code: 'shared_theme_part',
        part: theme,
        message:
          `Referenced as the theme of ${users.length} masters (${users.join(', ')}). Each master ` +
          'needs its own theme part; PowerPoint rejects the package as corrupt otherwise.',
      });
    }
  }

  // --- each slide has a layout, each layout a master --------------------
  for (const slide of slideParts) {
    const rels = relationships.get(slide.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'));
    if (![...(rels?.values() ?? [])].some((r) => r.type.endsWith('/slideLayout'))) {
      findings.push({
        severity: 'error',
        code: 'slide_without_layout',
        part: slide,
        message: 'No slideLayout relationship.',
      });
    }
  }
  for (const layout of names.filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n))) {
    const rels = relationships.get(
      layout.replace(/slideLayouts\/(slideLayout\d+\.xml)$/, 'slideLayouts/_rels/$1.rels'),
    );
    if (![...(rels?.values() ?? [])].some((r) => r.type.endsWith('/slideMaster'))) {
      findings.push({
        severity: 'error',
        code: 'layout_without_master',
        part: layout,
        message: 'No slideMaster relationship.',
      });
    }
  }

  // --- shape ids unique within a slide ----------------------------------
  const shapeParts = [...slideParts, ...names.filter((n) => /notesSlide\d+\.xml$/.test(n))];
  for (const part of shapeParts) {
    const xml = text.get(part) ?? '';
    const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map((m) => Number(m[1]));
    const seen = new Set<number>();
    const duplicate = ids.find((id) => (seen.has(id) ? true : (seen.add(id), false)));
    if (duplicate !== undefined) {
      findings.push({
        severity: 'error',
        code: 'duplicate_shape_id',
        part,
        message: `Shape id ${duplicate} is used twice; PowerPoint requires them unique per slide.`,
      });
    }
    if (ids.includes(0)) {
      findings.push({ severity: 'error', code: 'zero_shape_id', part, message: 'Shape id 0 is reserved.' });
    }
  }

  return findings;
}

export class PptxPackageError extends Error {
  constructor(readonly findings: PackageFinding[]) {
    super(
      'The generated .pptx failed its integrity check and was not written:\n' +
        findings.map((f) => `  [${f.code}] ${f.part ?? '(package)'}: ${f.message}`).join('\n'),
    );
    this.name = 'PptxPackageError';
  }
}
