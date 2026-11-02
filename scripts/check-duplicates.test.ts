import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG, REPORT, checkDuplicates, clonesOf, scopeRule } from './check-duplicates.mjs';
import { fixtureRepo, gitIn, isolatedEnv, runScript, withoutInheritedGitEnv } from './git-fixture.js';

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

// Repositories are built once and only read by the tests, except that C's tests each set the
// config they need.
const repos: string[] = [];
function repository(files: Record<string, string>) {
  const repo = fixtureRepo('check-duplicates-repo-');
  repos.push(repo);
  const git = gitIn(repo);
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  const run = (args: string[], input?: string) => runScript(script, args, { cwd: repo, env: isolatedEnv, input });
  // The project's PreToolUse hook on Bash, as Claude Code runs it for a command.
  const commitHook = (command: string) => run(['--commit-hook'], JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command } }));
  const denial = (command: string) => JSON.parse(commitHook(command).stdout).hookSpecificOutput;
  for (const [file, content] of Object.entries(files)) write(file, content);
  git('add', '.');
  return { repo, git, write, run, commitHook, denial };
}

afterAll(() => {
  for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true });
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
    const denied = A.denial('git commit -m x');
    expect(denied).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(denied.permissionDecisionReason).toContain('src/a.ts');
    expect(denied.permissionDecisionReason).toContain('src/b.ts');
    expect(denied.permissionDecisionReason).toContain(path.join(A.repo, REPORT));
    expect(denied.permissionDecisionReason).not.toContain('src/c.ts');
  });

  it('as a commit hook, denies commit -a on the working copy clone', () => {
    const denied = A.denial('git commit -a -m x');
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toContain('src/a.ts');
    expect(denied.permissionDecisionReason).toContain('src/c.ts');
    expect(denied.permissionDecisionReason).not.toContain('src/b.ts');
  });

  it('as a commit hook, refuses a commit naming paths, asking for staging instead', () => {
    const denied = A.denial('git commit -m x src/b.ts');
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toContain('git add');
  });
});

describe('check-duplicates.mjs on a repository without duplicated code', () => {
  const B = repository({ [CONFIG]: JSON.stringify(projectConfig), 'src/unique.ts': 'export const unique = 1;\n' });

  it('passes the command line check without output', () => {
    expect(B.run([])).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('as a commit hook, allows a commit', () => {
    expect(B.commitHook('git commit -m x').stdout).toBe('');
  });
});

describe('check-duplicates.mjs commit hook on a repository holding a staged clone', () => {
  const C = repository({ [CONFIG]: JSON.stringify(projectConfig), 'src/a.ts': BLOCK, 'src/b.ts': BLOCK });

  it('does not check a repository without the config', () => {
    C.git('rm', '-q', '--cached', '--ignore-unmatch', CONFIG);
    fs.rmSync(path.join(C.repo, CONFIG), { force: true });
    expect(C.commitHook('git commit -m x').stdout).toBe('');
  });

  it('refuses a commit while the config is inconsistent', () => {
    C.write(CONFIG, JSON.stringify({ ...projectConfig, format: ['typescript'] }));
    C.git('add', CONFIG);
    expect(C.denial('git commit -m x')).toMatchObject({ permissionDecision: 'deny' });
  });
});

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
