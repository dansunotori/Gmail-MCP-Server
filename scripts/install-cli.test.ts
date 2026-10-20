import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureRepo, gitIn, isolatedEnv } from './git-fixture.js';
// @ts-expect-error -- plain ESM script without type declarations; linkBins is typed by its use here.
import { linkBins } from './install-cli.mjs';
import { mainCheckoutOf } from './script-support.mjs';

describe('mainCheckoutOf', () => {
  it('names the main checkout from a linked worktree, and none from the main checkout itself', () => {
    const main = fixtureRepo('main-checkout-');
    const git = gitIn(main);
    git('commit', '-q', '--allow-empty', '-m', 'start');
    const worktree = path.join(fs.realpathSync(os.tmpdir()), `linked-${path.basename(main)}`);
    git('worktree', 'add', '-q', worktree, '-b', 'side');
    try {
      expect(mainCheckoutOf(main, isolatedEnv)).toBeNull();
      expect(mainCheckoutOf(worktree, isolatedEnv)).toBe(main);
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(main, { recursive: true, force: true });
    }
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
    expect(logged).toEqual([`the CLIs stay linked from the main checkout ${mainRoot}`]);
    expect(fs.readlinkSync(path.join(binDir, 'tool'))).toBe(mainLink);
    expect(fs.existsSync(path.join(binDir, 'fresh'))).toBe(false);
  });

  it('from a linked worktree, still fails a link pointing outside both checkouts and a missing build', () => {
    fs.mkdirSync(binDir);
    fs.symlinkSync(path.join(dir, 'elsewhere', 'tool.js'), path.join(binDir, 'tool'));
    const { ok, errors, logged } = run({ tool: 'dist/tool.js', absent: 'dist/absent.js' }, path.join(dir, 'main-checkout'));
    expect(ok).toBe(false);
    expect(errors).toEqual([expect.stringContaining('outside this checkout'), expect.stringContaining('missing (run npm run build)')]);
    expect(logged).toEqual([]);
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
    expect(errors).toEqual([expect.stringContaining('outside this checkout')]);
    expect(fs.readlinkSync(path.join(binDir, 'tool'))).toBe(other);
  });

  it('does not treat a sibling directory sharing the checkout prefix as this checkout', () => {
    fs.mkdirSync(binDir);
    const sibling = `${root}-copy/dist/tool.js`;
    fs.symlinkSync(sibling, path.join(binDir, 'tool'));
    expect(run({ tool: 'dist/tool.js' }).ok).toBe(false);
    expect(fs.readlinkSync(path.join(binDir, 'tool'))).toBe(sibling);
  });

  it('leaves a regular file alone and reports a missing build', () => {
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'tool'), 'mine');
    const { ok, errors } = run({ tool: 'dist/tool.js', absent: 'dist/absent.js' });
    expect(ok).toBe(false);
    expect(errors).toEqual([
      expect.stringContaining('is not a symlink'),
      expect.stringContaining('missing (run npm run build)'),
    ]);
    expect(fs.readFileSync(path.join(binDir, 'tool'), 'utf8')).toBe('mine');
    expect(fs.existsSync(path.join(binDir, 'absent'))).toBe(false);
  });
});
