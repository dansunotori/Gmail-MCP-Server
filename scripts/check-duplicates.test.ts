import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG, REPORT, checkDuplicates, clonesOf, main, runCommitHook, scopeRule, stagedEntries } from './check-duplicates.mjs';
import { answeringRun, exitError, fixtureRepo, gitIn, isolatedEnv, runMain, runScript, withoutInheritedGitEnv } from './git-fixture.js';
import { runCaptured } from './script-support.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(scripts, 'check-duplicates.mjs');
const projectConfig = JSON.parse(fs.readFileSync(path.join(scripts, '..', CONFIG), 'utf8'));

// Eight lines, well over the configured 50 tokens, so the same block in two files is a clone.
const BLOCK = Array.from({ length: 8 }, (_, i) => `export function f${i}(a: number, b: number): number { return a * ${i} + b - ${i}; }`).join('\n') + '\n';

describe('scopeRule', () => {
  const inScope = scopeRule(projectConfig);

  it.each(['src/a.ts', 'scripts/b.mjs', 'gen.py', '.github/workflows/ci.yml', 'package.json', 'run.sh', 'deploy/Dockerfile'])(
    'takes %s, code, tests, scripts, configuration or shell',
    file => {
      expect(inScope(file)).toBe(true);
    },
  );

  it.each(['README.md', 'LICENSE', 'package-lock.json', 'sub/package-lock.json'])('leaves out %s, a document or the lockfile', file => {
    expect(inScope(file)).toBe(false);
  });

  it.each([
    { name: 'drops a format its maps name', format: ['typescript'], mentions: /javascript/ },
    { name: 'lists a format its maps do not name', format: [...projectConfig.format, 'markdown'], mentions: /markdown/ },
  ])('refuses a config whose format list differs from the formats its maps name: it $name', ({ format, mentions }) => {
    expect(() => scopeRule({ ...projectConfig, format })).toThrow(mentions);
  });
});

describe('stagedEntries', () => {
  const blob = 'a'.repeat(40);

  it('keeps a path holding tabs whole, splitting each entry at its first tab only', () => {
    expect(stagedEntries(`100644 ${blob} 0\tsrc/a\tb\tc.ts\0`, () => true)).toEqual([{ mode: '100644', blob, stage: '0', file: 'src/a\tb\tc.ts' }]);
  });

  it('takes only regular files at stage 0 that the rule takes', () => {
    const listed = [
      `100644 ${blob} 0\tsrc/a.ts`,
      `100755 ${blob} 0\trun.sh`,
      `120000 ${blob} 0\tlink.ts`,
      `100644 ${blob} 2\tconflict.ts`,
      `100644 ${blob} 0\tREADME.md`,
    ].map(entry => `${entry}\0`).join('');
    expect(stagedEntries(listed, (file: string) => !file.endsWith('.md')).map((entry: { file: string }) => entry.file)).toEqual(['src/a.ts', 'run.sh']);
  });
});

describe('clonesOf', () => {
  const side = (name: string, start: number, end: number) => ({ name, start, end });

  it('reads each clone as two path-ordered ranges, without the format jscpd appends to a name, sorted', () => {
    const report = { duplicates: [
      { format: 'typescript', lines: 7, tokens: 60, firstFile: side('src/z.ts', 4, 10), secondFile: side('src/b.ts', 1, 7) },
      { format: 'markdown', lines: 5, tokens: 55, firstFile: side('a.md:markdown', 2, 6), secondFile: side('a.md:markdown', 20, 24) },
      { format: 'typescript', lines: 7, tokens: 58, firstFile: side('src/m.ts', 3, 9), secondFile: side('src/b.ts', 1, 7) },
    ] };
    expect(clonesOf(report)).toEqual([
      { first: { file: 'a.md', start: 2, end: 6 }, second: { file: 'a.md', start: 20, end: 24 }, lines: 5, tokens: 55 },
      { first: { file: 'src/b.ts', start: 1, end: 7 }, second: { file: 'src/m.ts', start: 3, end: 9 }, lines: 7, tokens: 58 },
      { first: { file: 'src/b.ts', start: 1, end: 7 }, second: { file: 'src/z.ts', start: 4, end: 10 }, lines: 7, tokens: 60 },
    ]);
  });

  it('reads a report without duplicates as no clones', () => {
    expect(clonesOf({})).toEqual([]);
  });
});

const OTHER = 'export const other = 2;\n';

const dirs: string[] = [];
const writeIn = (dir: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};
const cli = (args: string[], run: typeof runCaptured, cwd: string) => runMain(main, args, run, cwd);
// The project's PreToolUse hook on Bash for a command run in cwd: its deny reason, or undefined.
const hookFor = (command: string, run: typeof runCaptured, cwd: string): string | undefined =>
  runCommitHook({ cwd, tool_name: 'Bash', tool_input: { command } }, run);

// A repository built once, its files staged, and only read by the tests.
function repository(files: Record<string, string>) {
  const repo = fixtureRepo('check-duplicates-repo-');
  dirs.push(repo);
  const write = (file: string, content: string) => writeIn(repo, file, content);
  for (const [file, content] of Object.entries(files)) write(file, content);
  gitIn(repo)('add', '.');
  return { repo, write, run: (args: string[]) => cli(args, runCaptured, repo), hook: (command: string) => hookFor(command, runCaptured, repo) };
}

// A directory that is no repository, holding the working files and the config, with git
// answered as if its index listed them and staged the blobs of staged and, unless configStaged
// is false, the config, all in scope.
function stubbed(workingFiles: Record<string, string>, stagedFiles: Record<string, string> = workingFiles, { configStaged = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-duplicates-stub-')));
  dirs.push(dir);
  const config = { [CONFIG]: JSON.stringify(projectConfig) };
  const working = { ...config, ...workingFiles };
  for (const [file, content] of Object.entries(working)) writeIn(dir, file, content);
  const blobs = Object.entries({ ...(configStaged ? config : {}), ...stagedFiles }).map(([file, content], index) => ({ file, content, blob: String(index + 1).padStart(40, '0') }));
  const git = answeringRun({
    'git rev-parse --show-toplevel': `${dir}\n`,
    'git ls-files -z --cached': Object.keys(working).map(file => `${file}\0`).join(''),
    'git ls-files -s -z': blobs.map(({ file, blob }) => `100644 ${blob} 0\t${file}\0`).join(''),
    'git cat-file --batch': Buffer.from(blobs.map(({ content, blob }) => `${blob} blob ${Buffer.byteLength(content)}\n${content}\n`).join('')),
  });
  return { dir, git, run: (args: string[]) => cli(args, git.run, dir), hook: (command: string) => hookFor(command, git.run, dir) };
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('check-duplicates.mjs on a repository holding a clone in the index and another in the working copy', () => {
  // The index holds the clone a.ts/b.ts, the working copy the clone a.ts/c.ts. The hook reads what
  // a commit records (the staged blobs, or the working copy with -a); the check reads the working copy.
  const A = repository({
    [CONFIG]: JSON.stringify(projectConfig),
    'src/unique.ts': 'export const unique = 1;\n',
    'src/a.ts': BLOCK,
    'src/b.ts': BLOCK,
    'src/c.ts': OTHER,
    'README.md': BLOCK,
    'docs/copy.md': BLOCK,
  });
  // checkDuplicates runs in this process, so inherited GIT_* variables must not redirect its git.
  withoutInheritedGitEnv();
  beforeAll(() => {
    A.write('src/untracked.ts', BLOCK);
    A.write('src/b.ts', OTHER);
    A.write('src/c.ts', BLOCK);
  });

  it('checks the staged files, naming the clone between a.ts and b.ts', () => {
    expect(checkDuplicates(A.repo, { staged: true })).toEqual([
      expect.objectContaining({ first: { file: 'src/a.ts', start: 1, end: 8 }, second: { file: 'src/b.ts', start: 1, end: 8 } }),
    ]);
  });

  it('checks the working copy of tracked files, not an untracked twin or documents', () => {
    expect(checkDuplicates(A.repo)).toEqual([
      expect.objectContaining({ first: { file: 'src/a.ts', start: 1, end: 8 }, second: { file: 'src/c.ts', start: 1, end: 8 } }),
    ]);
  });

  it('fails the command line check, naming the working copy clone and the report it leaves', () => {
    const failed = A.run([]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('src/a.ts');
    expect(failed.stderr).toContain('src/c.ts');
    expect(failed.stderr).not.toContain('src/b.ts');
    expect(failed.stderr).toContain(path.join(A.repo, REPORT));
    expect(JSON.parse(fs.readFileSync(path.join(A.repo, REPORT), 'utf8')).duplicates).toHaveLength(1);
  });

  it('as a commit hook, denies a commit on the staged clone, naming it and the report', () => {
    const reason = A.hook('git commit -m x');
    expect(reason).toContain('src/a.ts');
    expect(reason).toContain('src/b.ts');
    expect(reason).toContain(path.join(A.repo, REPORT));
    expect(reason).not.toContain('src/c.ts');
  });

  it('as a commit hook, denies commit -a on the working copy clone', () => {
    const reason = A.hook('git commit -a -m x');
    expect(reason).toContain('src/a.ts');
    expect(reason).toContain('src/c.ts');
    expect(reason).not.toContain('src/b.ts');
  });
});

describe('check-duplicates.mjs with git answered by a stub', () => {
  it('passes the command line check and allows a commit without duplicated code', () => {
    const B = stubbed({ 'src/unique.ts': 'export const unique = 1;\n' });
    expect(B.run([])).toEqual({ code: 0, stderr: '' });
    expect(B.hook('git commit -m x')).toBeUndefined();
  });

  it('as a commit hook, denies a commit on the clone the index stages, whatever the working copy holds', () => {
    const C = stubbed({ 'src/a.ts': BLOCK, 'src/b.ts': OTHER }, { 'src/a.ts': BLOCK, 'src/b.ts': BLOCK });
    const reason = C.hook('git commit -m x');
    expect(reason).toContain('Duplicate code: 1 clone');
    expect(reason).toContain('src/a.ts:1-8 duplicates src/b.ts:1-8');
    expect(C.hook('git commit -a -m x')).toBeUndefined();
  });

  it('as a commit hook, names a clone by its repository paths when every staged file shares a directory', () => {
    const C = stubbed({ 'src/a.ts': BLOCK, 'src/b.ts': BLOCK }, { 'src/a.ts': BLOCK, 'src/b.ts': BLOCK }, { configStaged: false });
    expect(C.hook('git commit -m x')).toContain('\nsrc/a.ts:1-8 duplicates src/b.ts:1-8 (');
  });

  it('as a commit hook, refuses a commit naming paths, asking for staging instead, without reading the files', () => {
    const C = stubbed({ 'src/a.ts': BLOCK });
    expect(C.hook('git commit -m x src/a.ts')).toContain('git add');
    expect(C.git.calls.map(call => call.line)).toEqual(['git rev-parse --show-toplevel']);
  });

  it('does not check a repository without the config', () => {
    const C = stubbed({ 'src/a.ts': BLOCK, 'src/b.ts': BLOCK });
    fs.rmSync(path.join(C.dir, CONFIG));
    expect(C.hook('git commit -m x')).toBeUndefined();
  });

  it('refuses a commit while the config is inconsistent', () => {
    const C = stubbed({ 'src/a.ts': BLOCK });
    writeIn(C.dir, CONFIG, JSON.stringify({ ...projectConfig, format: ['typescript'] }));
    expect(C.hook('git commit -m x')).toContain('could not run');
  });

  it('exits 2 naming the failure when git cannot answer', () => {
    const git = answeringRun({ 'git rev-parse --show-toplevel': exitError(128, 'not a git repository') });
    expect(cli([], git.run, os.tmpdir())).toEqual({ code: 2, stderr: 'check-duplicates: not a git repository\n' });
  });
});

// The script as Claude Code runs it, a node process reading the payload on stdin.
describe('check-duplicates.mjs commit hook wiring without a repository', () => {
  const D = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-duplicates-nogit-')));
  afterAll(() => {
    fs.rmSync(D, { recursive: true, force: true });
  });
  const hook = (command: string) =>
    runScript(script, ['--commit-hook'], { cwd: D, env: isolatedEnv, input: JSON.stringify({ cwd: D, tool_name: 'Bash', tool_input: { command } }) });

  it('ignores a command that is not a commit', () => {
    expect(hook('git status').stdout).toBe('');
  });

  it('refuses a commit it cannot read', () => {
    const denied = JSON.parse(hook('git status && git commit -m x').stdout).hookSpecificOutput;
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toContain('duplicate code');
  });
});

describe('the duplicate-code check in the project', () => {
  it('package.json runs the check as duplicates:check with a pinned jscpd, and CI runs it', () => {
    const root = path.join(scripts, '..');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['duplicates:check']).toBe('node scripts/check-duplicates.mjs');
    expect(packageJson.devDependencies.jscpd).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain('run: npm run duplicates:check');
  });
});
