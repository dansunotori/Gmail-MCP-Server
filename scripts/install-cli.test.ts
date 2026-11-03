import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkBins } from './install-cli.mjs';
import { checkoutOfGitDirs } from './script-support.mjs';

describe('checkoutOfGitDirs', () => {
  it('names the main checkout from a linked worktree, and none from the main checkout itself', () => {
    expect(checkoutOfGitDirs('/repo/.git\n/repo/.git\n')).toBeNull();
    expect(checkoutOfGitDirs('/repo/.git/worktrees/side\n/repo/.git\n')).toBe('/repo');
  });
});

describe('linkBins', () => {
  let dir: string;
  let root: string;
  let binDir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-cli-')));
    root = path.join(dir, 'checkout');
    binDir = path.join(dir, 'bin');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'tool.js'), '');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (bin: Record<string, string>, mainRoot?: string) => {
    const error = vi.fn();
    const log = vi.fn();
    const ok = linkBins({ root, bin, binDir, mainRoot, log, error });
    return { ok, errors: error.mock.calls.map(call => String(call[0])), logged: log.mock.calls.map(call => String(call[0])) };
  };

  it('from a linked worktree, leaves the links to the main checkout alone and says so in one line', () => {
    const mainRoot = path.join(dir, 'main-checkout');
    fs.mkdirSync(binDir);
    const mainLink = path.join(mainRoot, 'dist', 'tool.js');
    fs.symlinkSync(mainLink, path.join(binDir, 'tool'));
    const { ok, errors, logged } = run({ tool: 'dist/tool.js', fresh: 'dist/tool.js' }, mainRoot);
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(mainRoot);
    expect(fs.readlinkSync(path.join(binDir, 'tool'))).toBe(mainLink);
    expect(fs.existsSync(path.join(binDir, 'fresh'))).toBe(false);
  });

  it('from a linked worktree, still fails a link pointing outside both checkouts', () => {
    fs.mkdirSync(binDir);
    const elsewhere = path.join(dir, 'elsewhere', 'tool.js');
    fs.symlinkSync(elsewhere, path.join(binDir, 'tool'));
    const { ok, errors, logged } = run({ tool: 'dist/tool.js' }, path.join(dir, 'main-checkout'));
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('tool');
    expect(logged).toEqual([]);
    expect(fs.readlinkSync(path.join(binDir, 'tool'))).toBe(elsewhere);
  });

  it('links a new command and replaces a link that already points into this checkout', () => {
    expect(run({ tool: 'dist/tool.js' }).ok).toBe(true);
    expect(fs.readlinkSync(path.join(binDir, 'tool'))).toBe(path.join(root, 'dist', 'tool.js'));

    fs.unlinkSync(path.join(binDir, 'tool'));
    fs.symlinkSync(path.join(root, 'dist', 'old.js'), path.join(binDir, 'tool'));
    expect(run({ tool: 'dist/tool.js' }).ok).toBe(true);
    expect(fs.readlinkSync(path.join(binDir, 'tool'))).toBe(path.join(root, 'dist', 'tool.js'));
  });

  it('leaves a link to another checkout alone and reports it', () => {
    fs.mkdirSync(binDir);
    const other = path.join(dir, 'other-checkout', 'dist', 'tool.js');
    fs.symlinkSync(other, path.join(binDir, 'tool'));
    const { ok, errors } = run({ tool: 'dist/tool.js' });
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('tool');
    expect(fs.readlinkSync(path.join(binDir, 'tool'))).toBe(other);
  });

  it('does not treat a sibling directory sharing the checkout prefix as this checkout', () => {
    fs.mkdirSync(binDir);
    const sibling = `${root}-copy/dist/tool.js`;
    fs.symlinkSync(sibling, path.join(binDir, 'tool'));
    expect(run({ tool: 'dist/tool.js' }).ok).toBe(false);
    expect(fs.readlinkSync(path.join(binDir, 'tool'))).toBe(sibling);
  });

  it.each([
    {
      name: 'a regular file in the bin dir',
      command: 'tool',
      target: 'dist/tool.js',
      setup: () => fs.writeFileSync(path.join(binDir, 'tool'), 'mine'),
      untouched: () => expect(fs.readFileSync(path.join(binDir, 'tool'), 'utf8')).toBe('mine'),
    },
    {
      name: 'a bin whose build is missing',
      command: 'absent',
      target: 'dist/absent.js',
      setup: () => undefined,
      untouched: () => expect(fs.existsSync(path.join(binDir, 'absent'))).toBe(false),
    },
  ])('fails for $name and leaves the bin dir as it was', ({ command, target, setup, untouched }) => {
    fs.mkdirSync(binDir);
    setup();
    const { ok, errors } = run({ [command]: target });
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(command);
    untouched();
  });
});
