/**
 * The extraction worker, run as a separate process by extract.ts so that a hostile or huge
 * attachment can neither hang nor crash the server. It receives { type: 'init', format,
 * filename } over IPC and the file's bytes on stdin, and answers over IPC.
 */

import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AttachmentFileError, type FileFaultCause, type SheetSummary } from './formats.js';
import { extractSpreadsheet } from './spreadsheet.js';

export interface WorkerInit {
  type: 'init';
  format: string;
  filename: string;
}

export type WorkerResponse =
  | { type: 'result'; text: string; sheets?: SheetSummary[] }
  | { type: 'fault'; cause: FileFaultCause; message: string }
  | { type: 'error'; message: string };

async function extractPdf(buffer: Buffer): Promise<string> {
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  let document: Awaited<typeof loading.promise>;
  try {
    document = await loading.promise;
  } catch (error) {
    const name = (error as { name?: unknown }).name;
    if (name === 'PasswordException') {
      throw new AttachmentFileError('protected', 'the PDF needs a password to open');
    }
    throw new AttachmentFileError('corrupt', 'the PDF cannot be read');
  }
  const pages: string[] = [];
  try {
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) {
          text += item.str + (item.hasEOL ? '\n' : '');
        }
      }
      pages.push(text.trim());
    }
  } catch {
    // A PDF can open and still have a page that cannot be read: that is a damaged file too.
    throw new AttachmentFileError('corrupt', 'the PDF cannot be read');
  } finally {
    await loading.destroy();
  }
  return pages.join('\n\n');
}

async function extractDocx(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    throw new AttachmentFileError('corrupt', 'the Word document cannot be read');
  }
}

async function extract(format: string, filename: string, buffer: Buffer): Promise<{ text: string; sheets?: SheetSummary[] }> {
  switch (format) {
    case 'pdf':
      return { text: await extractPdf(buffer) };
    case 'docx':
      return { text: await extractDocx(buffer) };
    case 'xlsx':
    case 'xlsm':
    case 'xls':
    case 'csv':
      return extractSpreadsheet(buffer, format, filename);
    default:
      throw new AttachmentFileError('unsupported', `no parser for format ${format}`);
  }
}

// process.send is asynchronous: exiting straight after it can drop a large message still in
// the IPC pipe, so the process exits from the send callback.
function answer(response: WorkerResponse): void {
  try {
    process.send!(response, (error: Error | null) => process.exit(error ? 1 : 0));
  } catch {
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const init = new Promise<WorkerInit>(resolve => {
    process.on('message', (message: WorkerInit) => {
      if (message.type === 'init') resolve(message);
    });
  });
  const bytes = new Promise<Buffer>(resolve => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
  });
  try {
    const { format, filename } = await init;
    const result = await extract(format, filename, await bytes);
    answer({ type: 'result', ...result });
  } catch (error) {
    if (error instanceof AttachmentFileError) {
      answer({ type: 'fault', cause: error.cause, message: error.message });
      return;
    }
    // Parser messages are foreign text that can quote the file; only a fixed message leaves.
    answer({ type: 'error', message: 'text extraction failed' });
  }
}

void main();
