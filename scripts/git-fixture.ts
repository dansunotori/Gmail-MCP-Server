// What the script tests share: throwaway git repositories, running a script as a hook or a
// command line does, and a scripted command runner for the scripts that take one. git runs in the
// repositories without any repository location the test run inherits (git sets GIT_DIR and others
// when it runs a hook), so a test never reaches the checkout it runs from.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach } from 'vitest';

export const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

// For the tests of the enclosing describe, or of the file at top level: removes every GIT_*
// variable from process.env before each test and puts the removed ones back after it, so a
// script called in-process runs git in the repository it is given.
export function withoutInheritedGitEnv() {
  let removed: [string, string | undefined][] = [];
  beforeEach(() => {
    removed = Object.entries(process.env).filter(([key]) => key.startsWith('GIT_'));
    for (const [key] of removed) delete process.env[key];
  });
  afterEach(() => {
    for (const [key, value] of removed) process.env[key] = value;
  });
}

// git in repo, its output returned; a failed command throws.
export const gitIn = (repo: string) => (...args: string[]) => execFileSync('git', args, { cwd: repo, env: isolatedEnv, stdio: 'pipe' });

// A new empty repository in the temporary directory, by its real path, with an identity and
// unsigned commits so a test can commit in it.
export function fixtureRepo(prefix: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = gitIn(repo);
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return repo;
}

// A command runner for the scripts that take one (land, push), running nothing. answers maps a
// full command line ("git status --porcelain") to its status and stdout, each defaulting to
// 0 and ''; a command line without an answer succeeds with no output. calls lists every command
// run, as [command, ...args].
export function scriptedRun(answers: Record<string, { status?: number; stdout?: string }> = {}) {
  const calls: string[][] = [];
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const answer = answers[[command, ...args].join(' ')];
    return { status: answer?.status ?? 0, stdout: answer?.stdout ?? '' };
  };
  return { run, calls };
}

// A runner in the shape of runCaptured (script-support.mjs) for the scripts that read a command's
// output, running nothing. answers maps a full command line ("git show :ROADMAP.md") to the
// stdout it returns, or to the error it throws; a command line without an answer throws, naming
// it. calls lists every command run, as its command line and the directory it ran in.
export function answeringRun(answers: Record<string, string | Buffer | Error> = {}) {
  const calls: { line: string; cwd?: string }[] = [];
  const run = (command: string, args: string[], options: { cwd?: string } = {}) => {
    const line = [command, ...args].join(' ');
    calls.push({ line, cwd: options.cwd });
    const answer = answers[line];
    if (answer === undefined) throw new Error(`unexpected command: ${line}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { run, calls };
}

type Io = { stdin: () => string; stdout: (text: string) => void; stderr: (text: string) => void; run: unknown; env: NodeJS.ProcessEnv; cwd: string };

// A script's main(args, io) run in-process with run as its runner, from cwd, with an empty
// environment and stdin: its exit code and what it wrote to stderr.
export function runMain(main: (args: string[], io: Io) => number, args: string[], run: unknown, cwd: string) {
  const stderr: string[] = [];
  const code = main(args, { stdin: () => '', stdout: () => {}, stderr: text => stderr.push(text), run, env: {}, cwd });
  return { code, stderr: stderr.join('') };
}

// An error as execFileSync throws it for a command that exits with status.
export const exitError = (status: number, message = `exited ${status}`) => Object.assign(new Error(message), { status });

// The answers of a clean main checkout: on main, nothing uncommitted.
export const cleanMain: Record<string, { status?: number; stdout?: string }> = {
  'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
  'git status --porcelain': { stdout: '' },
};

// The script run by node with args, input on stdin: its exit code, stdout and stderr.
export function runScript(script: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string }) {
  try {
    return { code: 0, stdout: execFileSync('node', [script, ...args], { ...options, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '' };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { code: failed.status, stdout: failed.stdout, stderr: failed.stderr };
  }
}
