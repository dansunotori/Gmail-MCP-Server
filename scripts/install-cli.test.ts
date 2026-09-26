import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations; linkBins is typed by its use here.
import { linkBins } from './install-cli.mjs';

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

  const run = (bin: Record<string, string>) => {
    const error = vi.fn();
    const ok = linkBins({ root, bin, binDir, log: vi.fn(), error });
    return { ok, errors: error.mock.calls.map(call => String(call[0])) };
  };

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
