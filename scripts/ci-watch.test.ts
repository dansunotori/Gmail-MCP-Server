import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { ciWatch, parseRepo, watcherFor } from './ci-watch.mjs';
import { fakeRun, ghUnauthenticated, REPO, SHA, successive } from './ci-test-support.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fake world: git and gh answer by command line. `runLists` are the successive answers of
// `gh run list` and each entry of `views` the successive answers of `gh run view` for that
// run, the last one repeating; `watchStatus` is what `gh run watch` exits with.
function world(options: { pushed?: boolean; branch?: string | null; runLists?: unknown[][]; views?: Record<string, unknown[]>; watchStatus?: number } = {}) {
  const { pushed = true, branch = 'main', runLists = [[{ databaseId: 7, name: 'CI', url: 'https://ci/7', status: 'queued' }]], views = {}, watchStatus = 0 } = options;
  const calls: string[] = [];
  const logged: string[] = [];
  const watched: string[] = [];
  const viewOf: Record<string, () => unknown> = {};
  let sleeps = 0;
  const nextRunList = successive(runLists);
  const run = fakeRun(calls, branch, line => {
    if (line === `git branch -r --contains ${SHA} --list origin/${branch}`) return pushed ? `  origin/${branch}\n` : '';
    if (line === 'git remote get-url origin') return 'https://github.com/owner/repo.git\n';
    if (line.startsWith(`gh run list --repo ${REPO} --commit ${SHA} --branch ${branch} --event push `)) return JSON.stringify(nextRunList());
    const view = line.match(/^gh run view (\d+) --repo owner\/repo/);
    if (view) {
      const id = view[1];
      viewOf[id] ??= successive(views[id] ?? [{ status: 'completed', conclusion: 'success', name: 'CI', url: `https://ci/${id}`, jobs: [] }]);
      return JSON.stringify(viewOf[id]());
    }
    throw new Error(`unexpected command: ${line}`);
  });
  const watch = (id: string, repo: string) => {
    watched.push(`${id} ${repo}`);
    return watchStatus;
  };
  const sleep = () => {
    sleeps++;
  };
  return { run, watch, sleep, log: (line: string) => logged.push(line), calls, logged, watched, sleeps: () => sleeps };
}

describe('ci-watch.mjs', () => {
  it('is npm run ci:watch', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['ci:watch']).toBe('node scripts/ci-watch.mjs');
  });

  it('reads the GitHub repository from an https or ssh origin URL', () => {
    expect(parseRepo('https://github.com/owner/repo.git')).toBe('owner/repo');
    expect(parseRepo('https://github.com/owner/repo')).toBe('owner/repo');
    expect(parseRepo('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(parseRepo('ssh://git@github.com/owner/repo.git')).toBe('owner/repo');
    expect(parseRepo('https://gitlab.com/owner/repo.git')).toBeNull();
  });

  it("refuses, without asking GitHub, when the branch's origin copy does not contain HEAD", () => {
    const w = world({ pushed: false });
    expect(ciWatch(w)).toBe(2);
    expect(w.logged).toEqual(['ci:watch: HEAD 90d1a52 is not pushed to origin/main; push it, then run ci:watch again']);
    expect(w.calls.some(call => call.startsWith('gh '))).toBe(false);
  });

  it('refuses on a detached HEAD, which no push run belongs to', () => {
    const w = world({ branch: null });
    expect(ciWatch(w)).toBe(2);
    expect(w.logged).toEqual(['ci:watch: HEAD 90d1a52 is not on a branch; check out the branch that was pushed']);
    expect(w.calls.some(call => call.startsWith('gh '))).toBe(false);
  });

  it("looks only for the runs the push of HEAD's branch started, so a run of the same commit from another trigger cannot stand in", () => {
    const w = world({ branch: 'feature' });
    expect(ciWatch(w)).toBe(0);
    expect(w.calls.filter(call => call.startsWith('gh run list'))).toEqual([
      `gh run list --repo ${REPO} --commit ${SHA} --branch feature --event push --json databaseId,name,url,status`,
    ]);
  });

  it("watches the run of HEAD's own commit, waiting for it to appear, and exits 0 when it passes", () => {
    const w = world({ runLists: [[], [], [{ databaseId: 7, name: 'CI', url: 'https://ci/7', status: 'queued' }]] });
    expect(ciWatch(w)).toBe(0);
    expect(w.sleeps()).toBe(2);
    expect(w.watched).toEqual(['7 owner/repo']);
    expect(w.logged).toEqual(['ci:watch: CI https://ci/7 passed for 90d1a52']);
  });

  it('gives up with a clear message when no run appears in time', () => {
    const w = world({ runLists: [[]] });
    expect(ciWatch({ ...w, waitSeconds: 20, pollSeconds: 5 })).toBe(2);
    expect(w.sleeps()).toBe(4);
    expect(w.watched).toEqual([]);
    expect(w.logged).toEqual(['ci:watch: no CI run for 90d1a52 appeared on owner/repo within 20s']);
  });

  it('exits 1 when a run fails, naming the run and each failed job and step', () => {
    const w = world({
      views: {
        7: [{
          status: 'completed',
          conclusion: 'failure',
          name: 'CI',
          url: 'https://ci/7',
          jobs: [
            { name: 'Build & Test', conclusion: 'failure', steps: [{ name: 'Typecheck', conclusion: 'success' }, { name: 'Test', conclusion: 'failure' }] },
            { name: 'Lint', conclusion: 'success', steps: [{ name: 'Lint', conclusion: 'success' }] },
          ],
        }],
      },
    });
    expect(ciWatch(w)).toBe(1);
    expect(w.logged).toEqual(['ci:watch: CI https://ci/7 ended failure for 90d1a52; failed: Build & Test / Test']);
  });

  it('reads a run only once GitHub reports it completed, however gh run watch ended', () => {
    const running = { status: 'in_progress', conclusion: '', name: 'CI', url: 'https://ci/7', jobs: [] };
    for (const watchStatus of [0, 1]) {
      const w = world({
        watchStatus,
        views: { 7: [running, running, { status: 'completed', conclusion: 'success', name: 'CI', url: 'https://ci/7', jobs: [] }] },
      });
      expect(ciWatch(w), `watch exit ${watchStatus}`).toBe(0);
      expect(w.sleeps()).toBe(2);
      expect(w.logged).toEqual(['ci:watch: CI https://ci/7 passed for 90d1a52']);
    }
  });

  it('exits 2, not the CI failure code, when git or gh cannot answer', () => {
    const w = world();
    expect(ciWatch({ ...w, run: ghUnauthenticated(w.run) })).toBe(2);
    expect(w.logged).toEqual(['ci:watch: could not read the CI runs of 90d1a52: gh: authentication required']);
  });

  it('watches every run of the commit and fails when any of them fails', () => {
    const w = world({
      runLists: [[
        { databaseId: 7, name: 'CI', url: 'https://ci/7', status: 'queued' },
        { databaseId: 8, name: 'Docs', url: 'https://ci/8', status: 'queued' },
      ]],
      views: { 8: [{ status: 'completed', conclusion: 'cancelled', name: 'Docs', url: 'https://ci/8', jobs: [] }] },
    });
    expect(ciWatch(w)).toBe(1);
    expect(w.watched).toEqual(['7 owner/repo', '8 owner/repo']);
    expect(w.logged).toEqual([
      'ci:watch: CI https://ci/7 passed for 90d1a52',
      'ci:watch: Docs https://ci/8 ended cancelled for 90d1a52',
    ]);
  });
});

describe('ci-watch.mjs --quiet', () => {
  const spawned: unknown[][] = [];
  const spawn = (...args: unknown[]) => {
    spawned.push(args);
    return {};
  };

  it('streams gh run watch without --quiet', () => {
    spawned.length = 0;
    watcherFor([], spawn)!('7', 'owner/repo');
    expect(spawned).toEqual([['gh', ['run', 'watch', '7', '--repo', 'owner/repo', '--interval', '10'], { stdio: 'inherit' }]]);
  });

  it('prints only the verdict line for a pass, without gh run watch', () => {
    spawned.length = 0;
    const w = world();
    expect(ciWatch({ ...w, watch: watcherFor(['--quiet'], spawn)! })).toBe(0);
    expect(spawned).toEqual([]);
    expect(w.logged).toEqual(['ci:watch: CI https://ci/7 passed for 90d1a52']);
  });

  it('prints the failed steps for a failure, without gh run watch', () => {
    spawned.length = 0;
    const w = world({
      views: { 7: [{ status: 'completed', conclusion: 'failure', name: 'CI', url: 'https://ci/7', jobs: [{ name: 'Build', conclusion: 'failure', steps: [{ name: 'Test', conclusion: 'failure' }] }] }] },
    });
    expect(ciWatch({ ...w, watch: watcherFor(['--quiet'], spawn)! })).toBe(1);
    expect(spawned).toEqual([]);
    expect(w.logged).toEqual(['ci:watch: CI https://ci/7 ended failure for 90d1a52; failed: Build / Test']);
  });

  it('refuses any other argument', () => {
    expect(watcherFor(['--quite'], spawn)).toBeNull();
  });
});
