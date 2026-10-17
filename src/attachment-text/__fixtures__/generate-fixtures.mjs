// Regenerates the spreadsheet fixtures used by spreadsheet.test.ts.
// Run from the project root: node src/attachment-text/__fixtures__/generate-fixtures.mjs
//
// encrypted.xlsx is NOT produced here — SheetJS cannot write Office-encrypted
// workbooks. It was saved from Microsoft Excel for Mac (workbook password
// "secret", single cell A1 = "hidden") and is committed as-is.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const here = dirname(fileURLToPath(import.meta.url));

function twoSheetWorkbook() {
  const wb = XLSX.utils.book_new();

  // Sheet 1: formatted date, percentage, currency, formula with cached
  // result, and a merged cell (A4:B4) whose value lives in A4 only.
  const sales = XLSX.utils.aoa_to_sheet([
    ['Item', 'Date', 'Share', 'Total'],
    ['Widget', null, null, null],
    ['Gadget', null, null, null],
    ['Merged note', null, null, null],
  ]);
  sales['B2'] = { t: 'n', v: 46096, z: 'dd/mm/yyyy' }; // 2026-03-15
  sales['C2'] = { t: 'n', v: 0.125, z: '0.0%' };
  sales['D2'] = { t: 'n', v: 20, f: '10*2' };
  sales['B3'] = { t: 'n', v: 46097, z: 'dd/mm/yyyy' }; // 2026-03-16
  sales['C3'] = { t: 'n', v: 0.5, z: '0.0%' };
  sales['D3'] = { t: 'n', v: 1234.5, z: '"£"#,##0.00' };
  sales['!merges'] = [{ s: { r: 3, c: 0 }, e: { r: 3, c: 1 } }];
  sales['!ref'] = 'A1:D4';
  XLSX.utils.book_append_sheet(wb, sales, 'Sales');

  // Sheet 2: data starts at C3 (leading empty rows/columns must be trimmed)
  // and has an empty cell between populated ones (must be kept).
  const notes = XLSX.utils.aoa_to_sheet([
    [],
    [],
    [null, null, 'Left', null, 'Right'],
    [null, null, 'Bottom'],
  ]);
  XLSX.utils.book_append_sheet(wb, notes, 'Notes');

  return wb;
}

function oneSheetWorkbook() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Name', 'Qty'],
    ['Bolt', 12],
    ['Nut', 7],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Parts');
  return wb;
}

function emptyWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Sheet1');
  return wb;
}

function write(name, buf) {
  writeFileSync(join(here, name), buf);
  console.log(`wrote ${name} (${buf.length} bytes)`);
}

function workbookBuffer(wb, bookType) {
  return XLSX.write(wb, { type: 'buffer', bookType, compression: true });
}

write('two-sheets.xlsx', workbookBuffer(twoSheetWorkbook(), 'xlsx'));
write('one-sheet.xls', workbookBuffer(oneSheetWorkbook(), 'biff8'));
write('empty.xlsx', workbookBuffer(emptyWorkbook(), 'xlsx'));
