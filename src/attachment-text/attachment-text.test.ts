import type { gmail_v1 } from 'googleapis';
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { getAttachmentText } from './attachment-text.js';
import { EXTRACTION_TIMEOUT_MS } from './extract.js';
import { AttachmentFileError, MAX_TEXT_LENGTH } from './formats.js';
import { committedFixture as fixture } from './test-fixtures.js';

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

  it('cuts text beyond the ceiling on a line boundary and says so', async () => {
    const line = 'x'.repeat(99) + '\n';
    const bytes = Buffer.from(line.repeat(Math.ceil(MAX_TEXT_LENGTH / line.length) + 10));
    const { gmail } = gmailWith([{ filename: 'big.txt', mimeType: 'text/plain', attachmentId: 'a5', bytes }], bytes);
    const result = await getAttachmentText(gmail, { messageId: 'm1', attachmentId: 'a5' });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(result.text.endsWith('x')).toBe(true);
    expect(result.text.split('\n').every(row => row.length === 99)).toBe(true);
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

  it('reads a standalone BIFF2, BIFF3 or BIFF4 .xls, which has no compound-document wrapper', async () => {
    for (const bookType of ['biff2', 'biff3', 'biff4'] as const) {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Part', 'Qty'], ['Bolt', 12]]), 'Sheet1');
      const bytes = XLSX.write(wb, { type: 'buffer', bookType }) as Buffer;
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
