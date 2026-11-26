import type { gmail_v1 } from 'googleapis';
import mammoth from 'mammoth';
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { getAttachmentText } from './attachment-text.js';
import { EXTRACTION_TIMEOUT_MS } from './extract.js';
import { AttachmentFileError, OffsetError } from './formats.js';
import { committedFixture as fixture, numberedLines, randomPng, wordDocumentWithPictures } from './test-fixtures.js';

type Part = { filename: string; mimeType: string; attachmentId: string; bytes: Buffer };

// Gmail hands out a different attachment id each time a message is fetched, so the message
// part never carries the id the caller holds unless a test says so.
function gmailWith(parts: Part[], requested: Buffer, options: { sameId?: boolean } = {}) {
  const attachmentsGet = vi.fn(async () => ({ data: { data: requested.toString('base64url'), size: requested.length } }));
  const messagesGet = vi.fn(async () => ({ data: { id: 'm1', payload: {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: Buffer.from('See attached').toString('base64url'), size: 12 } },
      ...parts.map(part => ({
        mimeType: part.mimeType,
        filename: part.filename,
        body: { attachmentId: options.sameId ? part.attachmentId : `${part.attachmentId}-refetched`, size: part.bytes.length },
      })),
    ],
  } } }));
  const gmail = { users: { messages: { get: messagesGet, attachments: { get: attachmentsGet } } } } as unknown as gmail_v1.Gmail;
  return { gmail, attachmentsGet, messagesGet };
}

// These tests fork real extraction workers, which take seconds each on a slow CI runner, so they
// get the worker's own limit rather than vitest's five-second default.
describe('getAttachmentText', { timeout: EXTRACTION_TIMEOUT_MS }, () => {
  it('returns a PDF attachment\'s name, format and text, finding its part by size when Gmail renamed the id', async () => {
    const pdf = fixture('report.pdf');
    const { gmail, attachmentsGet } = gmailWith([{ filename: 'report.pdf', mimeType: 'application/pdf', attachmentId: 'a1', bytes: pdf }], pdf);
    const result = await getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'a1' });
    expect(attachmentsGet).toHaveBeenCalledWith({ userId: 'me', messageId: 'm1', id: 'a1' });
    expect(result).toMatchObject({ name: 'report.pdf', format: 'pdf', truncated: false, sheets: null });
    expect(result.text).toContain('Quarterly report 2026');
  });

  it('returns a workbook\'s sheets and spans, and picks the part with the matching id first', async () => {
    const workbook = fixture('two-sheets.xlsx');
    const other = Buffer.alloc(workbook.length, 1);
    const { gmail } = gmailWith([
      { filename: 'decoy.xlsx', mimeType: 'application/octet-stream', attachmentId: 'decoy', bytes: other },
      { filename: 'sales.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', attachmentId: 'a2', bytes: workbook },
    ], workbook, { sameId: true });
    const result = await getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'a2' });
    expect(result.name).toBe('sales.xlsx');
    expect(result.format).toBe('xlsx');
    expect(result.sheets).toEqual([{ name: 'Sales', rows: 4, columns: 4 }, { name: 'Notes', rows: 2, columns: 3 }]);
    expect(result.text.startsWith('## Sheet: Sales\n')).toBe(true);
  });

  it('returns a Word document\'s text', async () => {
    const docx = fixture('letter.docx');
    const { gmail } = gmailWith([{ filename: 'letter.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', attachmentId: 'a3', bytes: docx }], docx);
    expect((await getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'a3' })).text).toContain('30 November 2026');
  });

  it('returns all the text of a Word document of 2 KB of text and twenty 500 KB pictures, the pictures counting for nothing', async () => {
    const paragraphs = Array.from({ length: 20 }, (_, index) => `Paragraph ${String(index + 1).padStart(2, '0')}: ${'words '.repeat(15).trim()}`);
    // 410 × 416 random RGB pixels: about 500 KB of PNG each, since random pixels do not compress.
    const pictures = Array.from({ length: 20 }, () => randomPng(410, 416));
    const docx = wordDocumentWithPictures(paragraphs, pictures);
    const { gmail } = gmailWith([{ filename: 'album.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', attachmentId: 'p1', bytes: docx }], docx);

    expect(docx.length).toBeGreaterThan(10 * 1000 * 1000);
    // The document really draws its pictures: a Word reader renders each one as an image.
    expect((await mammoth.convertToHtml({ buffer: docx })).value.match(/<img /g)).toHaveLength(20);
    expect(await getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'p1' }))
      .toEqual({ name: 'album.docx', format: 'docx', text: paragraphs.join('\n\n'), truncated: false, sheets: null });
  });

  it('returns a text part verbatim, decoding Windows-1252 when it is not UTF-8', async () => {
    const bytes = Buffer.concat([Buffer.from('Price: ', 'latin1'), Buffer.from([0x80]), Buffer.from('10\n', 'latin1')]);
    const { gmail } = gmailWith([{ filename: 'notes', mimeType: 'text/x-log', attachmentId: 'a4', bytes }], bytes);
    expect(await getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'a4' }))
      .toEqual({ name: 'notes', format: 'text', text: 'Price: €10\n', truncated: false, sheets: null });
  });

  it('names a part from its own Content-Disposition when Gmail gives it no filename', async () => {
    const bytes = Buffer.from('a,b\n1,2\n');
    const gmail = { users: { messages: {
      attachments: { get: async () => ({ data: { data: bytes.toString('base64url') } }) },
      get: async () => ({ data: { payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Content-Disposition', value: 'inline; filename="wrong.txt"' }], parts: [
        { mimeType: 'application/octet-stream', filename: '', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="figures.csv"' }], body: { attachmentId: 'other', size: bytes.length } },
      ] } } }),
    } } } as unknown as gmail_v1.Gmail;
    expect(await getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'c1' })).toMatchObject({ name: 'figures.csv', format: 'csv' });
  });

  // 5200 numbered lines of 99 UTF-8 bytes, 514800 in all. Lines 0000 to 5170, 511929 bytes, fit
  // the 512000-byte ceiling.
  const overCeiling = () => {
    const bytes = Buffer.from(numberedLines(0, 5199));
    return gmailWith([{ filename: 'big.txt', mimeType: 'text/plain', attachmentId: 'a5', bytes }], bytes).gmail;
  };

  it('cuts text over 500 KB of UTF-8 after a whole line, stating the bytes kept, the bytes in all and where the rest starts', async () => {
    expect(await getAttachmentText(overCeiling(), { messageId: 'm1', attachmentId: 'a5' })).toEqual({
      name: 'big.txt', format: 'txt', text: numberedLines(0, 5170), truncated: true, sheets: null,
      offset: 0, keptBytes: 511929, totalBytes: 514800, nextOffset: 511929,
    });
  });

  it('returns the rest of a cut text from the offset given, the last page saying there is no more', async () => {
    expect(await getAttachmentText(overCeiling(), { messageId: 'm1', attachmentId: 'a5', offset: 511929 })).toEqual({
      name: 'big.txt', format: 'txt', text: numberedLines(5171, 5199), truncated: false, sheets: null,
      offset: 511929, keptBytes: 2871, totalBytes: 514800, nextOffset: null,
    });
  });

  it('gives where the page lies for an offset of 0 given on a text that fits whole', async () => {
    const bytes = Buffer.from('one\ntwo\n');
    const { gmail } = gmailWith([{ filename: 'short.txt', mimeType: 'text/plain', attachmentId: 's1', bytes }], bytes);
    expect(await getAttachmentText(gmail, { messageId: 'm1', attachmentId: 's1', offset: 0 })).toEqual({
      name: 'short.txt', format: 'txt', text: 'one\ntwo\n', truncated: false, sheets: null,
      offset: 0, keptBytes: 8, totalBytes: 8, nextOffset: null,
    });
  });

  it('ends a page with no line break that fits on the last whole character', async () => {
    // 200000 three-byte characters on one line: 600000 bytes, of which 170666 whole characters,
    // 511998 bytes, fit the 512000-byte ceiling.
    const bytes = Buffer.from('€'.repeat(200000));
    const { gmail } = gmailWith([{ filename: 'line.txt', mimeType: 'text/plain', attachmentId: 'l1', bytes }], bytes);
    expect(await getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'l1' })).toEqual({
      name: 'line.txt', format: 'txt', text: '€'.repeat(170666), truncated: true, sheets: null,
      offset: 0, keptBytes: 511998, totalBytes: 600000, nextOffset: 511998,
    });
  });

  it('refuses an offset past the end of the text or inside a character', async () => {
    // Bytes 4 and 5 are the first line's first é, so byte 5 is inside it.
    for (const offset of [514801, 5]) {
      await expect(getAttachmentText(overCeiling(), { messageId: 'm1', attachmentId: 'a5', offset }), String(offset)).rejects.toThrow(RangeError);
    }
  });

  it('refuses an offset that is not a whole number of bytes', async () => {
    for (const offset of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(getAttachmentText(overCeiling(), { messageId: 'm1', attachmentId: 'a5', offset }), String(offset)).rejects.toThrow(OffsetError);
    }
  });

  it('reports an unsupported file by name and type, and a mislabelled one as corrupt', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const unsupported = gmailWith([{ filename: 'logo.png', mimeType: 'image/png', attachmentId: 'a6', bytes: png }], png);
    const failed = await getAttachmentText(unsupported.gmail, { messageId: 'm1', attachmentId: 'a6' }).catch(error => error);
    expect(failed).toBeInstanceOf(AttachmentFileError);
    expect(failed.cause).toBe('unsupported');
    expect(failed.message).toMatch(/^unsupported file: logo\.png \(image\/png\); supported: PDF, DOCX, XLSX, XLSM, XLS, CSV/);

    const fake = Buffer.from('not a pdf at all');
    const mislabelled = gmailWith([{ filename: 'invoice.pdf', mimeType: 'application/pdf', attachmentId: 'a7', bytes: fake }], fake);
    await expect(getAttachmentText(mislabelled.gmail, { messageId: 'm1', attachmentId: 'a7' })).rejects.toMatchObject({ cause: 'corrupt' });
  });

  it('returns a page as the very characters of the text, an unpaired UTF-16 code unit from an .xls cell included', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a\uD800b']]), 'Sheet1');
    const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }) as Buffer;
    const { gmail } = gmailWith([{ filename: 'lone.xls', mimeType: 'application/vnd.ms-excel', attachmentId: 'u1', bytes }], bytes);
    expect((await getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'u1', offset: 0 })).text).toContain('a\uD800b');
  });

  it('reads a standalone BIFF2, BIFF3 or BIFF4 .xls, which has no compound-document wrapper', async () => {
    for (const bookType of ['biff2', 'biff3', 'biff4'] as const) {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Part', 'Qty'], ['Bolt', 12]]), 'Sheet1');
      // xlsx's BookType names biff2 but not biff3 or biff4, which XLSX.write writes all the same.
      const bytes = XLSX.write(wb, { type: 'buffer', bookType: bookType as XLSX.BookType }) as Buffer;
      const { gmail } = gmailWith([{ filename: `${bookType}.xls`, mimeType: 'application/vnd.ms-excel', attachmentId: bookType, bytes }], bytes);
      const result = await getAttachmentText(gmail, { messageId: 'm1', attachmentId: bookType });
      expect(result.text, bookType).toContain('Part\tQty\nBolt\t12');
    }
  });

  it('reports an .xls that is neither a compound document nor a BIFF stream as corrupt', async () => {
    const bytes = Buffer.from('this is not a spreadsheet');
    const { gmail } = gmailWith([{ filename: 'fake.xls', mimeType: 'application/vnd.ms-excel', attachmentId: 'f', bytes }], bytes);
    await expect(getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'f' })).rejects.toMatchObject({ cause: 'corrupt' });
  });

  it('reports a protected PDF and an encrypted workbook by cause', async () => {
    const protectedPdf = fixture('protected.pdf');
    const pdf = gmailWith([{ filename: 'secret.pdf', mimeType: 'application/pdf', attachmentId: 'p', bytes: protectedPdf }], protectedPdf);
    await expect(getAttachmentText(pdf.gmail, { messageId: 'm1', attachmentId: 'p' })).rejects.toMatchObject({ cause: 'protected' });
    const encrypted = fixture('encrypted.xlsx');
    const xlsx = gmailWith([{ filename: 'locked.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', attachmentId: 'e', bytes: encrypted }], encrypted);
    await expect(getAttachmentText(xlsx.gmail, { messageId: 'm1', attachmentId: 'e' })).rejects.toMatchObject({ cause: 'encrypted' });
  });

  it('refuses to guess between attachments it cannot tell apart', async () => {
    const bytes = Buffer.from('same size');
    const { gmail } = gmailWith([
      { filename: 'one.txt', mimeType: 'text/plain', attachmentId: 'x', bytes },
      { filename: 'two.csv', mimeType: 'text/csv', attachmentId: 'y', bytes: Buffer.from('size same') },
    ], bytes);
    await expect(getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'x' }))
      .rejects.toThrow('cannot tell which attachment of message m1 this is: one.txt, two.csv have its size');
  });

  it('lets a Gmail failure through unchanged, for its own exit code', async () => {
    const missing = Object.assign(new Error('Requested entity was not found.'), { response: { status: 404, data: {} } });
    const gmail = { users: { messages: { attachments: { get: async () => { throw missing; } } } } } as unknown as gmail_v1.Gmail;
    await expect(getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'gone' })).rejects.toBe(missing);
  });
});
