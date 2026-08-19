import { readMasterParagraphs } from '../../src/cdr/master-file.ts';
const lines = await readMasterParagraphs('courses/cdr-biochar/master.docx');
for (let i = 0; i < lines.length; i++) {
  console.log(i + ': ' + lines[i]);
}
