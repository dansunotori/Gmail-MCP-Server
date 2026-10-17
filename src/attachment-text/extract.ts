/**
 * Runs the extraction worker (worker.ts) as a child process with a hard timeout, a memory
 * cap and an environment reduced to what a parser needs, so no credential path or token
 * reaches it. Ported from outlook-claude-mcp's src/workers/fork-extractor.ts.
 */

import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttachmentFileError, type SheetSummary } from './formats.js';
import type { WorkerInit, WorkerResponse } from './worker.js';

export const EXTRACTION_TIMEOUT_MS = 30_000;
const WORKER_MAX_OLD_SPACE_MB = 256;

const here = path.dirname(fileURLToPath(import.meta.url));
const compiledWorker = path.join(here, 'worker.js');
// The build runs the compiled worker; the test suite runs the TypeScript source through tsx.
const { workerPath, loader } = existsSync(compiledWorker)
  ? { workerPath: compiledWorker, loader: [] as string[] }
  : { workerPath: path.join(here, 'worker.ts'), loader: ['--import', 'tsx'] };

const ALLOWED_ENV = ['PATH', 'HOME', 'LANG', 'TERM', 'NODE_ENV'] as const;

export function sanitisedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

export interface ExtractedText {
  text: string;
  sheets?: SheetSummary[];
}

// The spawner is a parameter so tests can hand in a fake child; callers use fork.
export function extractInWorker(format: string, filename: string, buffer: Buffer, spawn: typeof fork = fork): Promise<ExtractedText> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(workerPath, [], {
      env: sanitisedEnv(),
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
      execArgv: [...loader, `--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`],
    });
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      finish();
    };
    const timer = setTimeout(() => settle(() => reject(new Error(`text extraction timed out after ${EXTRACTION_TIMEOUT_MS / 1000} seconds`))), EXTRACTION_TIMEOUT_MS);
    timer.unref();
    // Drained so a chatty parser never blocks on a full pipe; never logged.
    child.stderr?.resume();
    child.on('message', (message: WorkerResponse) => settle(() => {
      if (message.type === 'result') {
        resolve(message.sheets === undefined ? { text: message.text } : { text: message.text, sheets: message.sheets });
      } else if (message.type === 'fault') {
        reject(new AttachmentFileError(message.cause, message.message.replace(/^\w+ file: /, '')));
      } else {
        reject(new Error(message.message));
      }
    }));
    child.on('error', () => settle(() => reject(new Error('text extraction could not start'))));
    child.on('exit', (code, signal) => settle(() => reject(new Error(
      signal === 'SIGKILL' ? 'text extraction was stopped (memory limit reached?)' : `text extraction stopped unexpectedly (exit code ${code})`,
    ))));
    // A worker that dies before reading its input breaks the pipe (EPIPE); without a listener
    // that error would be thrown in the server process. Errors after settling are absorbed.
    child.stdin?.on('error', () => settle(() => reject(new Error('text extraction stopped unexpectedly'))));
    const init: WorkerInit = { type: 'init', format, filename };
    child.send(init);
    child.stdin!.end(buffer);
  });
}
