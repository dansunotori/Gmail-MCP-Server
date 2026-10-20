import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations; its exports are typed by their use here.
import { CONFIG, REPORT, clonesOf, formatClone, scopeRule } from './check-duplicates.mjs';
import { fixtureRepo, gitIn, isolatedEnv, runScript } from './git-fixture.js';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(scripts, 'check-duplicates.mjs');
const projectConfig = JSON.parse(fs.readFileSync(path.join(scripts, '..', CONFIG), 'utf8'));

// Eight lines, well over the configured 50 tokens, so the same block in two files is a clone.
const BLOCK = Array.from({ length: 8 }, (_, i) => `export function f${i}(a: number, b: number): number { return a * ${i} + b - ${i}; }`).join('\n') + '\n';

describe('scopeRule', () => {
  const inScope = scopeRule(projectConfig);

  it('takes code, tests, scripts, configuration and shell, and leaves out documents and the lockfile', () => {
    for (const file of ['src/a.ts', 'scripts/b.mjs', 'c.cjs', 'd.mts', 'gen.py', '.github/workflows/ci.yml', 'docker-compose.yaml', 'package.json', 'run.sh', 'Dockerfile', 'deploy/Dockerfile']) {
      expect(inScope(file), file).toBe(true);
    }
    for (const file of ['README.md', 'docs/spec.md', 'LICENSE', 'notes.txt', 'package-lock.json', 'sub/package-lock.json', 'image.png', '.gitignore']) {
      expect(inScope(file), file).toBe(false);
    }
  });

  it('refuses a config whose format list is not exactly the formats its maps name', () => {
    expect(() => scopeRule({ ...projectConfig, format: ['typescript'] })).toThrow(/lists the formats typescript but maps files to/);
    expect(() => scopeRule({ ...projectConfig, format: [...projectConfig.format, 'markdown'] })).toThrow(/make "format" name exactly/);
  });
});

describe('clonesOf', () => {
  const side = (name: string, start: number, end: number) => ({ name, start, end });

  it('reads each clone as two path-ordered ranges, without the format jscpd appends to a name, sorted', () => {
    const report = { duplicates: [
      { format: 'typescript', lines: 7, tokens: 60, firstFile: side('src/z.ts', 4, 10), secondFile: side('src/b.ts', 1, 7) },
      { format: 'markdown', lines: 5, tokens: 55, firstFile: side('a.md:markdown', 2, 6), secondFile: side('a.md:markdown', 20, 24) },
    ] };
    const clones = clonesOf(report);
    expect(clones.map(formatClone)).toEqual([
      'a.md:2-6 duplicates a.md:20-24 (5 lines, 55 tokens)',
      'src/b.ts:1-7 duplicates src/z.ts:4-10 (7 lines, 60 tokens)',
    ]);
    expect(clonesOf({})).toEqual([]);
  });
});

describe('check-duplicates.mjs on a repository', () => {
  let repo: string;
  const git = (...args: string[]) => gitIn(repo)(...args);
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  const run = (args: string[], input?: string) => runScript(script, args, { cwd: repo, env: isolatedEnv, input });
  // The project's PreToolUse hook on Bash, as Claude Code runs it for a command.
  const commitHook = (command: string) => run(['--commit-hook'], JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command } }));
  const denial = (command: string) => JSON.parse(commitHook(command).stdout).hookSpecificOutput;

  beforeEach(() => {
    repo = fixtureRepo('check-duplicates-repo-');
    write(CONFIG, JSON.stringify(projectConfig));
    write('src/unique.ts', 'export const unique = 1;\n');
    git('add', '.');
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('passes a repository without duplicated code', () => {
    expect(run([])).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('fails on a block repeated in two files, naming both ranges and the report it leaves', () => {
    write('src/a.ts', BLOCK);
    write('scripts/b.mjs', BLOCK.replace(/: number/g, ''));
    write('src/c.ts', BLOCK);
    git('add', '.');
    const failed = run([]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('src/a.ts:1-8 duplicates src/c.ts:1-8 (8 lines,');
    expect(failed.stderr).toContain(`1 clone; full report: ${path.join(repo, REPORT)}`);
    expect(JSON.parse(fs.readFileSync(path.join(repo, REPORT), 'utf8')).duplicates).toHaveLength(1);
  });

  it('reads only the files git tracks, by the config: an untracked copy, a document and the lockfile are not checked', () => {
    write('src/a.ts', BLOCK);
    write('src/untracked.ts', BLOCK);
    write('README.md', BLOCK);
    write('docs/copy.md', BLOCK);
    git('add', 'src/a.ts', 'README.md', 'docs/copy.md');
    expect(run([]).code).toBe(0);
  });

  it('gives the same report for the same tree, whatever order the files were added in', () => {
    write('src/a.ts', BLOCK);
    write('src/b.ts', BLOCK);
    write('src/c.ts', BLOCK);
    git('add', 'src/c.ts', 'src/a.ts', 'src/b.ts');
    const first = run([]).stderr;
    expect(run([]).stderr).toBe(first);
    expect(first.split('\n').filter(line => line.includes(' duplicates '))).toEqual([...first.split('\n').filter(line => line.includes(' duplicates '))].sort());
  });

  it('as a commit hook, denies a commit while the repository holds a clone, listing it and the report', () => {
    write('src/a.ts', BLOCK);
    write('src/b.ts', BLOCK);
    git('add', '.');
    for (const command of ['git commit -m x', 'git -C src commit -m x']) {
      const denied = denial(command);
      expect(denied, command).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
      expect(denied.permissionDecisionReason).toContain('Duplicate code: 1 clone in the files this commit records.');
      expect(denied.permissionDecisionReason).toContain('src/a.ts:1-8 duplicates src/b.ts:1-8');
      expect(denied.permissionDecisionReason).toContain(path.join(repo, REPORT));
    }
  });

  it('as a commit hook, allows a clean commit and ignores other commands and repositories without the config', () => {
    expect(commitHook('git commit -m x').stdout).toBe('');
    expect(commitHook('git status').stdout).toBe('');
    write('src/a.ts', BLOCK);
    write('src/b.ts', BLOCK);
    git('add', '.');
    expect(commitHook('git log --grep commit').stdout).toBe('');
    git('rm', '-q', '--cached', CONFIG);
    fs.rmSync(path.join(repo, CONFIG));
    expect(commitHook('git commit -m x').stdout).toBe('');
  });

  // The hook reads what the commit records, the staged blobs; npm run duplicates:check reads the
  // working copy. A file staged in part tells the two apart.
  it.each([
    { staged: 'a clone', working: 'none', hookDenies: true, checkFails: false },
    { staged: 'none', working: 'a clone', hookDenies: false, checkFails: true },
  ])('as a commit hook reads the staged copy ($staged staged, $working in the working copy), while the check reads the working copy', ({ hookDenies, checkFails }) => {
    write('src/a.ts', BLOCK);
    write('src/b.ts', hookDenies ? BLOCK : 'export const other = 2;\n');
    git('add', '.');
    write('src/b.ts', hookDenies ? 'export const other = 2;\n' : BLOCK);
    const hook = commitHook('git commit -m x').stdout;
    if (hookDenies) {
      const reason = JSON.parse(hook).hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain('src/a.ts:1-8 duplicates src/b.ts:1-8');
      expect(reason).toContain(path.join(repo, REPORT));
    } else {
      expect(hook).toBe('');
    }
    expect(run([]).code).toBe(checkFails ? 1 : 0);
    expect(fs.readFileSync(path.join(repo, 'src/b.ts'), 'utf8')).toBe(hookDenies ? 'export const other = 2;\n' : BLOCK);
  });

  // commit -a records the working copy of every tracked file, so the hook checks that copy then.
  it.each([
    { command: 'git commit -a -m x', stagedClone: false, denies: true },
    { command: 'git commit -am x', stagedClone: false, denies: true },
    { command: 'git commit --all -m "a -- b"', stagedClone: false, denies: true },
    { command: 'git commit -a -m x', stagedClone: true, denies: false },
    // An optional value attached to -u or -S is that option's, not more flags: these commit the index.
    { command: 'git commit -uall -m x', stagedClone: true, denies: true },
    { command: 'git commit -Salice@example.com -m x', stagedClone: true, denies: true },
    { command: 'git commit -uall -m x', stagedClone: false, denies: false },
    // --no-all undoes an earlier -a, so the index is committed.
    { command: 'git commit -a --no-all -m x', stagedClone: true, denies: true },
  ])('as a commit hook, checks what $command records (a clone staged: $stagedClone)',({ command, stagedClone, denies }) => {
    write('src/a.ts', BLOCK);
    write('src/b.ts', stagedClone ? BLOCK : 'export const other = 2;\n');
    git('add', '.');
    write('src/b.ts', stagedClone ? 'export const other = 2;\n' : BLOCK);
    const hook = commitHook(command).stdout;
    expect(hook === '' ? '' : JSON.parse(hook).hookSpecificOutput.permissionDecisionReason).toEqual(
      denies ? expect.stringContaining('src/a.ts:1-8 duplicates src/b.ts:1-8') : '',
    );
  });

  // A commit naming paths or picking hunks records a mix the hook cannot read, so it is refused.
  it.each([
    'git commit -m x -- src/b.ts',
    'git commit -m x src/b.ts',
    'git commit -o -m x src/b.ts',
    'git commit --only -m x src/b.ts',
    'git commit -i -m x src/b.ts',
    'git commit --include -m x src/b.ts',
    'git commit -p -m x',
    'git commit --interactive',
    'git commit --pathspec-from-file=list -m x',
    // An abbreviation git expands, a reword fixup (an implicit --only) and an option the hook
    // does not know are refused rather than guessed at.
    'git commit --pathspec-from-fil=list -m x',
    'git commit --fixup=reword:HEAD',
    'git commit --fixup reword:HEAD',
    'git commit --frobnicate -m x',
  ])('as a commit hook, refuses %s, which selects what it records or is not read, asking for staging instead',command => {
    expect(denial(command).permissionDecisionReason).toContain('stage the change with git add, then run git commit without paths');
  });

  it('as a commit hook, reads a value that looks like a path or option as the value it is', () => {
    for (const command of ['git commit -m src/b.ts', 'git commit -m -- ', 'git commit --author "A <a@b>" -m x', 'git commit -F msg.txt', 'git commit --amend --no-edit']) {
      expect(commitHook(command).stdout, command).toBe('');
    }
  });

  it('as a commit hook, refuses a commit whose target it cannot read, and one it cannot check', () => {
    expect(denial('git status && git commit -m x').permissionDecisionReason).toContain('single plain git command');
    write(CONFIG, JSON.stringify({ ...projectConfig, format: ['typescript'] }));
    const denied = denial('git commit -m x');
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toContain('The duplicate-code check could not run, so the commit is refused');
  });
});

describe('the duplicate-code check in the project', () => {
  it('is npm run duplicates:check, a step of npm run verify and of CI', () => {
    const root = path.join(scripts, '..');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['duplicates:check']).toBe('node scripts/check-duplicates.mjs');
    expect(packageJson.devDependencies.jscpd).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain('run: npm run duplicates:check');
  });
});
