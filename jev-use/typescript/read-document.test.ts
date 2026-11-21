import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readDocument } from '../read-document.js';

async function sandbox(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-doc-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('nexus_read_document reads sheets, pages rows and rejects unknown sheets', async () => {
  await sandbox(async root => {
    const workbook = new ExcelJS.Workbook();
    const plan = workbook.addWorksheet('Plan');
    plan.addRow(['Heat', 'Grade', 'Tonnes']);
    for (let i = 1; i <= 5; i++) plan.addRow([`H${i}`, 'SAE1008', i * 10]);
    plan.getCell('D2').value = { formula: 'C2*2', result: 20 };
    workbook.addWorksheet('Notes').addRow(['hello']);
    const path = join(root, 'plan.xlsx');
    await workbook.xlsx.writeFile(path);
    const first = await readDocument({ path, length: 3, allowedRoots: [root] });
    assert.equal(first.format, 'xlsx');
    assert.deepEqual((first as { sheets?: { name: string }[] }).sheets?.map(s => s.name), ['Plan', 'Notes']);
    assert.equal(first.content, 'Heat\tGrade\tTonnes\t\nH1\tSAE1008\t10\t20\nH2\tSAE1008\t20\t');
    assert.equal(first.next_offset, 3);
    const rest = await readDocument({ path, offset: 3, allowedRoots: [root] });
    assert.equal(rest.next_offset, null);
    assert.match(rest.content, /H5\tSAE1008\t50/);
    assert.equal((await readDocument({ path, sheet: 'Notes', allowedRoots: [root] })).content, 'hello');
    await assert.rejects(readDocument({ path, sheet: 'Nope', allowedRoots: [root] }), /Sheet not found/);
  });
});

test('nexus_read_document extracts docx paragraphs', async () => {
  await sandbox(async root => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Rolling plan</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>');
    const path = join(root, 'plan.docx');
    await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
    const doc = await readDocument({ path, allowedRoots: [root] });
    assert.match(doc.content, /Rolling plan\n\nSecond paragraph/);
  });
});

test('nexus_read_document extracts pdf text by page and refuses other formats and outside paths', async () => {
  await sandbox(async root => {
    const stream = 'BT /F1 18 Tf 20 100 Td (Billet schedule page one) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const path = join(root, 'plan.pdf');
    await writeFile(path, pdf);
    const result = await readDocument({ path, allowedRoots: [root] });
    assert.equal((result as { total_pages?: number }).total_pages, 1);
    assert.match(result.content, /Billet schedule page one/);
    await writeFile(join(root, 'a.txt'), 'x');
    await assert.rejects(readDocument({ path: join(root, 'a.txt'), allowedRoots: [root] }), /Supported formats/);
    await assert.rejects(readDocument({ path, allowedRoots: [join(root, 'other')] }), /outside allowed roots|ENOENT|Invalid roots/);
  });
});
