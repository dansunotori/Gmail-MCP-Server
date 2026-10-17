/**
 * Spreadsheet (xlsx, xlsm, xls, csv) to text, inside the extraction worker. SheetJS reads
 * the data only: formulas are never evaluated (cached results are used) and VBA is never
 * loaded.
 */

import * as XLSX from 'xlsx';
import * as cpexcel from 'xlsx/dist/cpexcel.full.mjs';
import { AttachmentFileError, decodeTextBytes, type SheetSummary } from './formats.js';

// The ESM build of SheetJS starts without codepage tables, so a legacy workbook declaring a
// codepage such as Windows-1251 would decode as garbage; the bundled tables are registered once.
XLSX.set_cptable(cpexcel);

export interface SpreadsheetExtraction {
  text: string;
  sheets: SheetSummary[];
}

type DenseSheet = XLSX.WorkSheet & { '!data'?: Array<Array<XLSX.CellObject | undefined> | undefined> };

// Line breaks and tabs would break the one-row-per-line, tab-separated layout (and let a
// crafted sheet name forge rows), so they are flattened.
const flatten = (value: string) => value.replace(/[\r\n\t]+/g, ' ');

function readWorkbook(buffer: Buffer, csv: boolean): XLSX.WorkBook {
  const options: XLSX.ParsingOptions = {
    dense: true,
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    bookVBA: false,
  };
  try {
    // A CSV is decoded here (UTF-8 or Windows-1252) rather than by SheetJS's codepages.
    return csv ? XLSX.read(decodeTextBytes(buffer), { ...options, type: 'string' }) : XLSX.read(buffer, { ...options, type: 'buffer' });
  } catch (error) {
    // SheetJS reports an Office-encrypted workbook as "File is password-protected"; anything
    // else, a corrupt ZIP included, is unreadable.
    const message = error instanceof Error ? error.message : String(error);
    if (/password-protected/i.test(message)) {
      throw new AttachmentFileError('encrypted', 'the workbook is encrypted with a password');
    }
    throw new AttachmentFileError('corrupt', 'the workbook cannot be read');
  }
}

// The value as Excel shows it: the formatted text when the file stores one, else the raw value.
function renderCell(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) return '';
  return flatten(cell.w !== undefined ? cell.w : String(cell.v));
}

type Merge = { s: { r: number; c: number }; e: { r: number; c: number } };

// Whether a cell lies inside a merged range other than at its top-left, where the merged value
// is shown: Excel displays nothing there, whatever the file stores.
function coveredByMerge(merges: Merge[], r: number, c: number): boolean {
  return merges.some(m => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c && (r !== m.s.r || c !== m.s.c));
}

// Work is proportional to populated cells, never to the bounding box or a row's width: dense
// rows are sparse arrays and forEach visits only the cells present, so a lone value in column
// XFD costs one cell, not sixteen thousand.
function renderSheet(sheet: DenseSheet, name: string): { lines: string[]; summary: SheetSummary } {
  const merges = (sheet['!merges'] ?? []) as Merge[];
  const rows = new Map<number, Array<[number, string]>>();
  let minColumn = Infinity;
  let maxColumn = -1;
  (sheet['!data'] ?? []).forEach((row, r) => {
    const cells: Array<[number, string]> = [];
    row?.forEach((cell, c) => {
      const value = renderCell(cell);
      if (value === '' || (merges.length > 0 && coveredByMerge(merges, r, c))) return;
      cells.push([c, value]);
      if (c < minColumn) minColumn = c;
      if (c > maxColumn) maxColumn = c;
    });
    if (cells.length > 0) rows.set(r, cells);
  });

  const lines = [`## Sheet: ${name}`];
  if (rows.size === 0) {
    return { lines, summary: { name, rows: 0, columns: 0 } };
  }
  const rowNumbers = [...rows.keys()];
  const minRow = rowNumbers[0];
  const maxRow = rowNumbers[rowNumbers.length - 1];
  for (let r = minRow; r <= maxRow; r++) {
    // Each populated cell goes at its column offset; the gaps become tabs.
    let line = '';
    let cursor = minColumn;
    for (const [c, value] of rows.get(r) ?? []) {
      line += '\t'.repeat(c - cursor) + value;
      cursor = c;
    }
    lines.push(line);
  }
  return { lines, summary: { name, rows: maxRow - minRow + 1, columns: maxColumn - minColumn + 1 } };
}

export function extractSpreadsheet(buffer: Buffer, format: string, filename: string): SpreadsheetExtraction {
  const csv = format === 'csv';
  const workbook = readWorkbook(buffer, csv);
  const sheets: SheetSummary[] = [];
  const blocks: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    // A CSV has no sheet name of its own; it takes the file name without its extension.
    const name = flatten(csv ? filename.replace(/\.[^.]+$/, '') : sheetName);
    const sheet = workbook.Sheets[sheetName] as DenseSheet | undefined;
    // A workbook can list a sheet whose part is missing or unreadable; that is a damaged file.
    if (sheet === undefined) {
      throw new AttachmentFileError('corrupt', `the workbook lists sheet "${name}" but does not contain it`);
    }
    let rendered: ReturnType<typeof renderSheet>;
    try {
      rendered = renderSheet(sheet, name);
    } catch {
      throw new AttachmentFileError('corrupt', `sheet "${name}" cannot be read`);
    }
    sheets.push(rendered.summary);
    blocks.push(rendered.lines.join('\n'));
  }
  return { text: blocks.join('\n\n'), sheets };
}
