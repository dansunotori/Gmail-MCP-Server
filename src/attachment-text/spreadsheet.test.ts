import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { extractSpreadsheet } from './spreadsheet.js';
import { committedFixture as fixture, cyrillicBiff5 } from './test-fixtures.js';

describe('extractSpreadsheet', () => {
  describe('two-sheet .xlsx', () => {
    const result = () => extractSpreadsheet(fixture('two-sheets.xlsx'), 'xlsx', 'two-sheets.xlsx');

    it('renders each sheet under a heading with tab-separated rows in sheet order', () => {
      const { text } = result();
      expect(text.indexOf('## Sheet: Sales')).toBe(0);
      expect(text.indexOf('## Sheet: Notes')).toBeGreaterThan(0);
      expect(text).toContain('Item\tDate\tShare\tTotal');
    });

    it('uses formatted display values for dates, percentages and currency', () => {
      const { text } = result();
      expect(text).toContain('Widget\t15/03/2026\t12.5%\t20');
      expect(text).toContain('Gadget\t16/03/2026\t50.0%\t£1,234.50');
    });

    it('renders a formula by its cached result, never the formula text', () => {
      const { text } = result();
      expect(text).not.toContain('10*2');
      expect(text).toMatch(/\t20$/m);
    });

    it('renders a merged cell once, in its top-left position', () => {
      const { text } = result();
      expect(text.match(/Merged note/g)).toHaveLength(1);
      expect(text).toContain('\nMerged note\n');
    });

    it('trims leading empty rows and columns but keeps empty cells between populated ones', () => {
      const { text } = result();
      expect(text.slice(text.indexOf('## Sheet: Notes'))).toBe('## Sheet: Notes\nLeft\t\tRight\nBottom');
    });

    it('gives each sheet\'s populated span', () => {
      expect(result().sheets).toEqual([
        { name: 'Sales', rows: 4, columns: 4 },
        { name: 'Notes', rows: 2, columns: 3 },
      ]);
    });
  });

  it('extracts a legacy BIFF .xls workbook', () => {
    const { text, sheets } = extractSpreadsheet(fixture('one-sheet.xls'), 'xls', 'one-sheet.xls');
    expect(text).toBe('## Sheet: Parts\nName\tQty\nBolt\t12\nNut\t7');
    expect(sheets).toEqual([{ name: 'Parts', rows: 3, columns: 2 }]);
  });

  it('names a .csv\'s single sheet after the file, honours quoted commas and keeps a blank middle row', () => {
    const { text, sheets } = extractSpreadsheet(fixture('contacts.csv'), 'csv', 'contacts.csv');
    expect(text).toBe(
      '## Sheet: contacts\n'
      + 'Name\tAddress\tNotes\n'
      + 'Smith, John\t1 High Street, London\tRegular\n'
      + '\n'
      + 'Doe, Jane\t2 Low Road, Leeds\tSays "hi"',
    );
    expect(sheets).toEqual([{ name: 'contacts', rows: 4, columns: 3 }]);
  });

  it('returns a heading with zero counts for an empty workbook', () => {
    const { text, sheets } = extractSpreadsheet(fixture('empty.xlsx'), 'xlsx', 'empty.xlsx');
    expect(text).toBe('## Sheet: Sheet1');
    expect(sheets).toEqual([{ name: 'Sheet1', rows: 0, columns: 0 }]);
  });

  it('reports an Office-encrypted workbook as encrypted and a broken one as corrupt', () => {
    expect(() => extractSpreadsheet(fixture('encrypted.xlsx'), 'xlsx', 'encrypted.xlsx'))
      .toThrow(expect.objectContaining({ cause: 'encrypted' }));
    expect(() => extractSpreadsheet(Buffer.from('PK\x03\x04not really a zip'), 'xlsx', 'bad.xlsx'))
      .toThrow(expect.objectContaining({ cause: 'corrupt' }));
  });

  it('renders a merged range once at its top-left, dropping values in the cells it covers', () => {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([['merged', 'hidden', ''], ['a', 'b', 'c']]);
    sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    XLSX.utils.book_append_sheet(wb, sheet, 'Merges');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const { text, sheets } = extractSpreadsheet(buffer, 'xlsx', 'merges.xlsx');
    expect(text).toBe('## Sheet: Merges\nmerged\na\tb\tc');
    expect(text).not.toContain('hidden');
    expect(sheets).toEqual([{ name: 'Merges', rows: 2, columns: 3 }]);
  });

  it('reports a workbook whose worksheet part is missing as corrupt', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Only');
    const zip = XLSX.CFB.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
    XLSX.CFB.utils.cfb_del(zip, '/xl/worksheets/sheet1.xml');
    const broken = Buffer.from(XLSX.CFB.write(zip, { fileType: 'zip', type: 'buffer' }));
    expect(() => extractSpreadsheet(broken, 'xlsx', 'broken.xlsx')).toThrow(expect.objectContaining({ cause: 'corrupt' }));
  });

  it('decodes a legacy workbook in the codepage it declares', () => {
    expect(extractSpreadsheet(cyrillicBiff5(), 'xls', 'cyrillic.xls').text).toBe('## Sheet: Sheet1\nПривет');
  });

  it('decodes a Windows-1252 csv instead of emitting replacement characters', () => {
    const bytes = Buffer.concat([
      Buffer.from('Item,Price\nTea,', 'latin1'),
      Buffer.from([0x80]),
      Buffer.from('10 ', 'latin1'),
      Buffer.from([0x93]),
      Buffer.from('nice', 'latin1'),
      Buffer.from([0x94]),
    ]);
    expect(extractSpreadsheet(bytes, 'csv', 'prices.csv').text).toBe('## Sheet: prices\nItem\tPrice\nTea\t€10 “nice”');
  });

  it('strips a UTF-8 byte order mark from a csv', () => {
    const csv = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Item,Qty\nBolt,1', 'utf-8')]);
    expect(extractSpreadsheet(csv, 'csv', 'bom.csv').text).toBe('## Sheet: bom\nItem\tQty\nBolt\t1');
  });

  it('flattens line breaks and tabs in sheet names so a crafted name cannot forge rows', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Bad\nName\tHere');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const { text, sheets } = extractSpreadsheet(buf, 'xlsx', 'crafted.xlsx');
    expect(text).toBe('## Sheet: Bad Name Here\nx');
    expect(sheets[0].name).toBe('Bad Name Here');
  });

  it('renders a sheet with one far-away stray cell in time proportional to populated cells', () => {
    const csv = 'x\n' + '\n'.repeat(99998) + ','.repeat(16383) + 'far\n';
    const started = performance.now();
    const { text, sheets } = extractSpreadsheet(Buffer.from(csv), 'csv', 'sparse.csv');
    expect(performance.now() - started).toBeLessThan(2000);
    expect(sheets).toEqual([{ name: 'sparse', rows: 100000, columns: 16384 }]);
    const lines = text.split('\n');
    expect(lines[1]).toBe('x');
    expect(lines[100000]).toBe('\t'.repeat(16383) + 'far');
  });
});
