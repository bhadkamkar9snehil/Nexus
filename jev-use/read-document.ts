import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { guardPath } from './read-text-file.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 48 * 1024;
const MAX_COLUMNS = 50;

type Options = { path: string; offset?: number; length?: number; sheet?: string; allowedRoots?: string[] };

// Pages a list of text units (lines, rows, pages) into one bounded response. Always returns at least one unit.
function page(units: string[], offset: number, length: number, joiner: string) {
  const first = Math.min(offset, units.length);
  const out: string[] = [];
  let chars = 0, index = first, cut = false;
  while (index < units.length && out.length < length) {
    const unit = units[index];
    const room = MAX_OUTPUT_CHARS - chars - (out.length ? joiner.length : 0);
    if (unit.length > room) {
      if (!out.length) { out.push(unit.slice(0, room)); cut = true; index++; }
      break;
    }
    out.push(unit);
    chars += unit.length + (out.length > 1 ? joiner.length : 0);
    index++;
  }
  return { content: out.join(joiner), start: first, units_read: out.length, total: units.length,
    next_offset: index < units.length ? index : null, truncated: index < units.length || cut, unit_truncated: cut };
}

/** Reads text from .docx, .xlsx and .pdf files with established parsers (mammoth, exceljs, unpdf). Read-only, bounded, paged. */
export async function readDocument(options: Options) {
  const { path } = options;
  const offset = options.offset ?? 0;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('path must be absolute');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000) throw new Error('Invalid offset');
  const resolved = await guardPath(path, options.allowedRoots, 'NEXUS_READ_ROOTS');
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('Path is not a regular file');
  if (info.size > MAX_FILE_BYTES) throw new Error('File exceeds 25 MiB');
  const format = extname(resolved).toLowerCase().slice(1);
  if (!['docx', 'xlsx', 'pdf'].includes(format)) throw new Error('Supported formats: .docx, .xlsx, .pdf (use nexus_read_file for text)');
  const buffer = await readFile(resolved);

  if (format === 'docx') {
    const length = options.length ?? 200;
    if (!Number.isSafeInteger(length) || length < 1 || length > 1000) throw new Error('Invalid length');
    const mammoth = await import('mammoth');
    const { value, messages } = await mammoth.extractRawText({ buffer });
    const lines = value.split(/\r?\n/);
    return { status: 'done', path: resolved, format, unit: 'line', ...page(lines, offset, length, '\n'),
      warnings: messages.slice(0, 5).map(m => m.message), decisions: 0 };
  }

  if (format === 'pdf') {
    const length = options.length ?? 5;
    if (!Number.isSafeInteger(length) || length < 1 || length > 50) throw new Error('Invalid length');
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = (text as string[]).map((t, i) => `--- page ${i + 1} ---\n${t.trim()}`);
    const result = page(pages, offset, length, '\n\n');
    return { status: 'done', path: resolved, format, unit: 'page', ...result, total_pages: totalPages,
      scanned_hint: pages.every(p => p.length < 40) ? 'No text layer found; the PDF may be scanned images.' : undefined, decisions: 0 };
  }

  const length = options.length ?? 100;
  if (!Number.isSafeInteger(length) || length < 1 || length > 1000) throw new Error('Invalid length');
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheets = workbook.worksheets.map(s => ({ name: s.name, rows: s.rowCount, columns: s.columnCount }));
  const sheet = options.sheet === undefined ? workbook.worksheets[0] : workbook.getWorksheet(options.sheet);
  if (!sheet) throw new Error('Sheet not found; available: ' + sheets.map(s => s.name).join(', '));
  const columns = Math.min(sheet.columnCount, MAX_COLUMNS);
  const rows: string[] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= columns; c++) cells.push(row.getCell(c).text.replace(/[\t\r\n]+/g, ' '));
    rows.push(cells.join('\t'));
  }
  return { status: 'done', path: resolved, format, unit: 'row', sheet: sheet.name, sheets, columns_shown: columns,
    columns_truncated: sheet.columnCount > columns, ...page(rows, offset, length, '\n'), decisions: 0 };
}
