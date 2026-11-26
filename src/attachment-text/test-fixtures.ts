// Fixtures for the attachment-text tests: the committed files in __fixtures__, and those built
// in code, where a committed file would hide what the bytes are.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
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

// Lines from to to, inclusive, each its four-digit number, 47 two-byte characters and a newline:
// 99 UTF-8 bytes a line, every line telling which it is.
export function numberedLines(from: number, to: number): string {
  return Array.from({ length: to - from + 1 }, (_, index) => String(from + index).padStart(4, '0') + 'é'.repeat(47) + '\n').join('');
}

// A valid PNG of random RGB pixels: signature, IHDR, one zlib-compressed IDAT and IEND, each
// chunk with its CRC. Random pixels do not compress, so the file is about width × height × 3
// bytes.
export function randomPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // 8 bits a sample
  header.writeUInt8(2, 9); // RGB
  const rows = Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 3)]));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A Word document of the given paragraphs with a picture after each of the first pictures.length
// paragraphs, each picture embedded as word/media/imageN.png with the given bytes and drawn
// inline, as Word saves one. Zipped by SheetJS's CFB writer.
export function wordDocumentWithPictures(paragraphs: string[], pictures: Buffer[]): Buffer {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const picture = (index: number) => `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="${index + 1}" name="Picture ${index + 1}"/>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
    + `<pic:nvPicPr><pic:cNvPr id="${index + 1}" name="image${index + 1}.png"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="rIdImage${index + 1}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const body = paragraphs.map((text, index) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>${index < pictures.length ? picture(index) : ''}`).join('');
  const files: Record<string, string | Buffer> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Default Extension="png" ContentType="image/png"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + pictures.map((_, index) => `<Relationship Id="rIdImage${index + 1}" Type="${r}/image" Target="media/image${index + 1}.png"/>`).join('') + '</Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${w}" xmlns:r="${r}"`
      + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
      + ` xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`,
    ...Object.fromEntries(pictures.map((bytes, index) => [`word/media/image${index + 1}.png`, bytes])),
  };
  const zip = XLSX.CFB.utils.cfb_new();
  for (const [name, content] of Object.entries(files)) {
    XLSX.CFB.utils.cfb_add(zip, name, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
  return Buffer.from(XLSX.CFB.write(zip, { fileType: 'zip', type: 'buffer' }));
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
