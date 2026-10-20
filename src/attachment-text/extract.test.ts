import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { EXTRACTION_TIMEOUT_MS, extractInWorker, sanitisedEnv } from './extract.js';
import { AttachmentFileError } from './formats.js';
import { committedFixture as fixture, cyrillicBiff5, pdfWithDanglingPage } from './test-fixtures.js';

// Each test forks a real extraction worker, which takes seconds on a slow CI runner, so the
// block gets the worker's own limit rather than vitest's five-second default.
describe('extractInWorker', { timeout: EXTRACTION_TIMEOUT_MS }, () => {
  it('extracts the text of every page of a PDF', async () => {
    const { text, sheets } = await extractInWorker('pdf', 'report.pdf', fixture('report.pdf'));
    expect(text).toContain('Quarterly report 2026');
    expect(text).toContain('Revenue rose by 12 percent');
    expect(text.indexOf('Quarterly')).toBeLessThan(text.indexOf('Revenue'));
    expect(sheets).toBeUndefined();
  });

  it('reports a password-protected PDF as protected', async () => {
    const failed = await extractInWorker('pdf', 'protected.pdf', fixture('protected.pdf')).catch(error => error);
    expect(failed).toBeInstanceOf(AttachmentFileError);
    expect(failed).toMatchObject({ cause: 'protected', message: 'protected file: the PDF needs a password to open' });
  });

  it('reports a damaged PDF as corrupt', async () => {
    const failed = await extractInWorker('pdf', 'broken.pdf', Buffer.from('%PDF-1.4\nthis is not a real PDF')).catch(error => error);
    expect(failed).toMatchObject({ cause: 'corrupt' });
  });

  it('extracts a Word document, headings, paragraphs and table cells', async () => {
    const { text } = await extractInWorker('docx', 'letter.docx', fixture('letter.docx'));
    expect(text).toContain('Bursary application');
    expect(text).toContain('Thank you for your application.');
    expect(text).toContain('30 November 2026');
    expect(text).toContain('7 December 2026');
  });

  it('extracts a two-sheet workbook with each sheet\'s span', async () => {
    const { text, sheets } = await extractInWorker('xlsx', 'two-sheets.xlsx', fixture('two-sheets.xlsx'));
    expect(text).toContain('## Sheet: Sales');
    expect(text).toContain('## Sheet: Notes');
    expect(sheets).toEqual([
      { name: 'Sales', rows: 4, columns: 4 },
      { name: 'Notes', rows: 2, columns: 3 },
    ]);
  });

  it('reports a PDF whose page cannot be read after loading as corrupt', async () => {
    await expect(extractInWorker('pdf', 'dangling.pdf', pdfWithDanglingPage())).rejects.toMatchObject({ cause: 'corrupt' });
  });

  it('reads a small workbook whose data sits in the last column within the worker\'s memory', async () => {
    const wb = XLSX.utils.book_new();
    const sheet: XLSX.WorkSheet = { '!ref': 'XFD1:XFD3000' };
    for (let row = 1; row <= 3000; row++) sheet[`XFD${row}`] = { t: 's', v: `v${row}` };
    XLSX.utils.book_append_sheet(wb, sheet, 'Far');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
    const { text, sheets } = await extractInWorker('xlsx', 'far.xlsx', buffer);
    expect(sheets).toEqual([{ name: 'Far', rows: 3000, columns: 1 }]);
    expect(text.split('\n').slice(1, 4)).toEqual(['v1', 'v2', 'v3']);
  });

  it('decodes a legacy workbook\'s declared codepage inside the worker', async () => {
    expect((await extractInWorker('xls', 'cyrillic.xls', cyrillicBiff5())).text).toBe('## Sheet: Sheet1\nПривет');
  });

  it('rejects, and never crashes the caller, when the worker\'s input pipe fails', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stderr: new PassThrough(),
      send: () => true,
      kill: () => true,
    });
    const pending = extractInWorker('pdf', 'x.pdf', Buffer.alloc(16), () => child as never);
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await expect(pending).rejects.toThrow('text extraction stopped unexpectedly');
    // A second pipe error after the call has settled is absorbed, not thrown.
    expect(() => child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
  });

  it('reports an encrypted workbook as encrypted and a broken ZIP as corrupt', async () => {
    await expect(extractInWorker('xlsx', 'encrypted.xlsx', fixture('encrypted.xlsx'))).rejects.toMatchObject({ cause: 'encrypted' });
    await expect(extractInWorker('xlsx', 'bad.xlsx', Buffer.from('PK\x03\x04not really a zip'))).rejects.toMatchObject({ cause: 'corrupt' });
    await expect(extractInWorker('docx', 'bad.docx', Buffer.from('PK\x03\x04not really a zip'))).rejects.toMatchObject({ cause: 'corrupt' });
  });
});

describe('sanitisedEnv', () => {
  it('passes only the variables a parser needs, never credentials or tokens', () => {
    const env = sanitisedEnv({ PATH: '/bin', HOME: '/home/me', LANG: 'en_GB.UTF-8', GMAIL_CREDENTIALS_PATH: '/secret', GOOGLE_TOKEN: 'ya29' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me', LANG: 'en_GB.UTF-8' });
  });
});
