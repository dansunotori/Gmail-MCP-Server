/**
 * What get_attachment_text can read, how text bytes are decoded, the size ceiling, and the
 * error a file fault raises. Shared by the server-side tool and the extraction worker.
 * The design follows outlook-claude-mcp's src/workers/extract-text-constants.ts.
 */

// Why a file cannot be read, as the contract names it: a caller tells a file fault from a
// sign-in, network or service fault by this error.
export type FileFaultCause = 'protected' | 'encrypted' | 'corrupt' | 'unsupported';

export class AttachmentFileError extends Error {
  readonly cause: FileFaultCause;

  constructor(cause: FileFaultCause, detail: string) {
    super(`${cause} file: ${detail}`);
    this.name = 'AttachmentFileError';
    this.cause = cause;
  }
}

// The format reported in the result, by file extension first and MIME type second.
export type AttachmentFormat = 'pdf' | 'docx' | 'xlsx' | 'xlsm' | 'xls' | 'csv' | 'txt' | 'md' | 'text';

const BY_EXTENSION: Record<string, AttachmentFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsm',
  '.xls': 'xls',
  '.csv': 'csv',
  '.txt': 'txt',
  '.md': 'md',
};

const BY_MIME_TYPE: Record<string, AttachmentFormat> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsm',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

export const SUPPORTED_FORMATS_TEXT = 'PDF, DOCX, XLSX, XLSM, XLS, CSV, TXT, MD and other text/* parts';

export const SPREADSHEET_FORMATS: ReadonlySet<AttachmentFormat> = new Set(['xlsx', 'xlsm', 'xls', 'csv']);

// Returned as they are, decoded, with no parser and no worker.
export const PLAIN_TEXT_FORMATS: ReadonlySet<AttachmentFormat> = new Set(['txt', 'md', 'text']);

export function detectFormat(filename: string, mimeType: string): AttachmentFormat | undefined {
  const extension = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (extension !== undefined && BY_EXTENSION[extension]) {
    return BY_EXTENSION[extension];
  }
  const type = mimeType.toLowerCase().split(';')[0].trim();
  if (BY_MIME_TYPE[type]) {
    return BY_MIME_TYPE[type];
  }
  return type.startsWith('text/') ? 'text' : undefined;
}

// UTF-8 when the bytes are valid UTF-8 (a byte order mark is dropped), otherwise
// Windows-1252, which Excel and Notepad save on Windows. The Windows-1252 decode is latin1
// plus the 32 code points that differ, so it is exact on every Node build.
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const WINDOWS_1252_HIGH: readonly string[] = [
  '€', '\u0081', '‚', 'ƒ', '„', '…', '†', '‡',
  'ˆ', '‰', 'Š', '‹', 'Œ', '\u008d', 'Ž', '\u008f',
  '\u0090', '‘', '’', '“', '”', '•', '–', '—',
  '˜', '™', 'š', '›', 'œ', '\u009d', 'ž', 'Ÿ',
];

export function decodeTextBytes(buffer: Buffer): string {
  try {
    return utf8Strict.decode(buffer);
  } catch {
    return buffer
      .toString('latin1')
      .replace(/[\u0080-\u009f]/g, character => WINDOWS_1252_HIGH[character.charCodeAt(0) - 0x80]);
  }
}

// The ceiling on returned text, in characters.
export const MAX_TEXT_LENGTH = 500 * 1024;

// Cuts at the last line break at or before the ceiling, so a spreadsheet row or a line of
// text is never split; text with no line break before the ceiling is cut at the ceiling.
export function truncateAtLine(text: string, limit = MAX_TEXT_LENGTH): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  const lastNewline = text.lastIndexOf('\n', limit);
  return { text: text.slice(0, lastNewline > 0 ? lastNewline : limit), truncated: true };
}

const ZIP_HEADER = [0x50, 0x4b, 0x03, 0x04];
// OLE2 compound file: legacy .xls, and also an Office-encrypted .docx/.xlsx, whose encrypted
// package is wrapped in this container instead of a ZIP.
const CFB_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const hasHeader = (buffer: Buffer, header: number[]) =>
  buffer.length >= header.length && header.every((byte, index) => buffer[index] === byte);

// Excel 2 to 4 saved a workbook as a bare BIFF stream, with no compound-document wrapper; it
// opens with a BOF record, opcode 0x0009, 0x0209, 0x0409 or 0x0809 (little-endian).
const BIFF_BOF_SECOND_BYTES = [0x00, 0x02, 0x04, 0x08];
const hasBiffHeader = (buffer: Buffer) =>
  buffer.length >= 4 && buffer[0] === 0x09 && BIFF_BOF_SECOND_BYTES.includes(buffer[1]);

// Refuses a file whose first bytes do not fit its format before any parser sees it.
export function checkMagicBytes(buffer: Buffer, format: AttachmentFormat): void {
  if (format === 'pdf' && buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new AttachmentFileError('corrupt', 'not a PDF (the file does not start with a PDF header)');
  }
  if (format === 'docx') {
    if (hasHeader(buffer, CFB_HEADER)) {
      throw new AttachmentFileError('encrypted', 'the Word document is encrypted with a password');
    }
    if (!hasHeader(buffer, ZIP_HEADER)) {
      throw new AttachmentFileError('corrupt', 'not a DOCX (the file is not a ZIP package)');
    }
  }
  if ((format === 'xlsx' || format === 'xlsm') && !hasHeader(buffer, ZIP_HEADER) && !hasHeader(buffer, CFB_HEADER)) {
    throw new AttachmentFileError('corrupt', `not an ${format.toUpperCase()} (the file is not a ZIP package)`);
  }
  if (format === 'xls' && !hasHeader(buffer, CFB_HEADER) && !hasBiffHeader(buffer)) {
    throw new AttachmentFileError('corrupt', 'not an XLS (the file is neither a compound document nor a BIFF workbook)');
  }
}

export interface SheetSummary {
  name: string;
  rows: number;
  columns: number;
}
