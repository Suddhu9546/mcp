/**
 * .pptx package integrity.
 *
 * The bug these tests exist for: the slide master and the notes master referenced
 * one shared theme part. The XML was well-formed, every relationship resolved, and
 * PowerPoint refused the file with "the file or directory is corrupted and
 * unreadable" -- no part named, no line number. It took bisecting the package to
 * find, so each check below is a rule that class of defect breaks.
 *
 * These run without PowerPoint. `npm run verify-pptx <file>` drives the real
 * application via COM on Windows, which is the only way to prove it opens; this
 * suite is what makes that check rarely necessary.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { renderPptx } from '../src/pptx/pptx-writer.js';
import { validatePptxPackage } from '../src/pptx/validate.js';

const DECK = {
  title: 'Integrity',
  slides: [
    {
      title: 'A slide with everything on it',
      bullets: ['First cue', 'Second cue', 'Third cue'],
      notes: 'What the presenter says while this slide is up.',
      takeaway: 'The one thing to remember.',
      eyebrow: 'Unit 1.1 - Something',
      visual: {
        type: 'process' as const,
        description: 'How the thing happens.',
        labels: ['Step one', 'Step two', 'Step three'],
      },
    },
    {
      title: 'A slide with a brief instead of a diagram',
      bullets: ['Only cue'],
      notes: 'Second slide notes.',
      visual: { type: 'scene' as const, description: 'A photograph of the yard at dawn.', labels: [] },
    },
  ],
};

/** Rebuilds a package with one part replaced or removed, to test the checks. */
async function tamper(
  bytes: Uint8Array,
  edit: (parts: Map<string, string | Uint8Array>) => void,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes, { createFolders: false });
  const parts = new Map<string, string | Uint8Array>();
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name]!.dir) continue;
    parts.set(
      name,
      name.endsWith('.xml') || name.endsWith('.rels')
        ? await zip.file(name)!.async('string')
        : await zip.file(name)!.async('uint8array'),
    );
  }
  edit(parts);

  const out = new JSZip();
  for (const [name, data] of parts) out.file(name, data, { createFolders: false });
  return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

describe('pptx package', () => {
  it('renders a package that passes its own integrity check', async () => {
    const bytes = await renderPptx(DECK);
    const findings = await validatePptxPackage(bytes);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('contains no directory entries', async () => {
    const zip = await JSZip.loadAsync(await renderPptx(DECK), { createFolders: false });
    const directories = Object.keys(zip.files).filter((n) => zip.files[n]!.dir);
    expect(directories).toEqual([]);
  });

  it('gives each master its own theme part', async () => {
    const zip = await JSZip.loadAsync(await renderPptx(DECK), { createFolders: false });
    const slideMasterRels = await zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels')!.async('string');
    const notesMasterRels = await zip.file('ppt/notesMasters/_rels/notesMaster1.xml.rels')!.async('string');

    expect(slideMasterRels).toContain('theme/theme1.xml');
    expect(notesMasterRels).toContain('theme/theme2.xml');
    expect(zip.file('ppt/theme/theme2.xml')).toBeTruthy();
    // Both themes must be declared, or the package has an undeclared part.
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    expect(contentTypes).toContain('/ppt/theme/theme1.xml');
    expect(contentTypes).toContain('/ppt/theme/theme2.xml');
  });

  /**
   * The exact defect, reintroduced. If this check ever regresses, PowerPoint stops
   * opening the deck and says nothing useful about why.
   */
  it('rejects a package whose masters share one theme', async () => {
    const shared = await tamper(await renderPptx(DECK), (parts) => {
      parts.set(
        'ppt/notesMasters/_rels/notesMaster1.xml.rels',
        (parts.get('ppt/notesMasters/_rels/notesMaster1.xml.rels') as string).replace(
          'theme2.xml',
          'theme1.xml',
        ),
      );
    });
    const findings = await validatePptxPackage(shared);
    expect(findings.map((f) => f.code)).toContain('shared_theme_part');
  });

  it('rejects a dangling relationship', async () => {
    const broken = await tamper(await renderPptx(DECK), (parts) => {
      parts.delete('ppt/slideLayouts/slideLayout1.xml');
    });
    const codes = (await validatePptxPackage(broken)).map((f) => f.code);
    expect(codes).toContain('dangling_relationship');
    expect(codes).toContain('content_type_without_part');
  });

  it('rejects a part with no declared content type', async () => {
    const broken = await tamper(await renderPptx(DECK), (parts) => {
      parts.set(
        '[Content_Types].xml',
        (parts.get('[Content_Types].xml') as string).replace(
          /<Override PartName="\/ppt\/slides\/slide1\.xml"[^>]*\/>/,
          '',
        ),
      );
    });
    expect((await validatePptxPackage(broken)).map((f) => f.code)).toContain('no_content_type');
  });

  it('rejects malformed XML and duplicate shape ids', async () => {
    const malformed = await tamper(await renderPptx(DECK), (parts) => {
      parts.set('ppt/slides/slide1.xml', '<p:sld><unclosed></p:sld>');
    });
    expect((await validatePptxPackage(malformed)).map((f) => f.code)).toContain('malformed_xml');

    const duplicated = await tamper(await renderPptx(DECK), (parts) => {
      parts.set(
        'ppt/slides/slide1.xml',
        (parts.get('ppt/slides/slide1.xml') as string).replace(/id="3"/, 'id="2"'),
      );
    });
    expect((await validatePptxPackage(duplicated)).map((f) => f.code)).toContain('duplicate_shape_id');
  });

  it('rejects a slide count that disagrees with the slide parts', async () => {
    const broken = await tamper(await renderPptx(DECK), (parts) => {
      parts.set(
        'ppt/presentation.xml',
        (parts.get('ppt/presentation.xml') as string).replace(/<p:sldId id="257"[^>]*\/>/, ''),
      );
    });
    expect((await validatePptxPackage(broken)).map((f) => f.code)).toContain('slide_count_mismatch');
  });

  it('refuses to return bytes for a package that would not open', async () => {
    // The writer validates its own output, so a regression in it throws here rather
    // than producing a file a user has to discover is broken.
    const bad = { title: 'Empty', slides: [] };
    await expect(renderPptx(bad)).rejects.toThrow(/at least one slide/);
  });

  it('orders the extended properties as the schema requires', async () => {
    const zip = await JSZip.loadAsync(await renderPptx(DECK), { createFolders: false });
    const app = await zip.file('docProps/app.xml')!.async('string');
    // PresentationFormat, then Slides, then Application: a sequence, not a set.
    const order = ['PresentationFormat', 'Slides', 'Paragraphs', 'Words', 'Application', 'AppVersion'];
    const positions = order.map((tag) => app.indexOf(`<${tag}>`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
