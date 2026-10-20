// Fixtures for the attachment-text tests: the committed files in __fixtures__, and those built
// in code, where a committed file would hide what the bytes are.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import './spreadsheet.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

// The bytes of a committed fixture file, by its name in __fixtures__.
export const committedFixture = (name: string): Buffer => readFileSync(path.join(FIXTURES, name));

// A BIFF5 workbook whose text is Windows-1251, as an old Russian Excel saves it. SheetJS cannot
// write one (its BIFF5 writer replaces Cyrillic with "_"), so it writes a Latin placeholder of
// the same length, then the CODEPAGE record is set to 1251 and the placeholder's bytes replaced
// by "Привет" in Windows-1251.
export function cyrillicBiff5(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Privet']]), 'Sheet1');
  const buffer = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'biff5' }) as Buffer);
  const codepage = buffer.indexOf(Buffer.from([0x42, 0x00, 0x02, 0x00]));
  if (codepage < 0) throw new Error('the BIFF5 writer wrote no CODEPAGE record');
  buffer.writeUInt16LE(1251, codepage + 4);
  const text = buffer.indexOf(Buffer.from('Privet', 'latin1'));
  if (text < 0) throw new Error('the placeholder text is not stored as single bytes');
  Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]).copy(buffer, text);
  return buffer;
}

// A PDF with a valid header, catalogue and xref whose only page is a dangling reference, so
// loading succeeds and reading the page fails.
export function pdfWithDanglingPage(): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [9 0 R] /Count 1 >>'];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
