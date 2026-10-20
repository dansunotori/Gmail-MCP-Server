import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { ciGate, COMMAND_TIMEOUT_SECONDS, hookMain, STOP_WAIT_SECONDS } from './ci-gate.mjs';
import { exited, fakeRun, ghUnauthenticated, REPO, SHA, successive } from './ci-test-support.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUN_LIST = `gh run list --repo ${REPO} --commit ${SHA} --branch main --json databaseId,workflowName,event,status,conclusion,url`;

type Run = { databaseId: number; workflowName: string; event: string; status: string; conclusion: string; url: string };

const passed = (id: number, extra: Partial<Run> = {}): Run => ({ databaseId: id, workflowName: 'CI', event: 'push', status: 'completed', conclusion: 'success', url: `https://ci/${id}`, ...extra });
const failed = (id: number, extra: Partial<Run> = {}): Run => passed(id, { conclusion: 'failure', ...extra });
const running = (id: number): Run => passed(id, { status: 'in_progress', conclusion: '' });

// A fake world: git and gh answer by command line. `runLists` are the successive answers of
// `gh run list`, the last one repeating; `jobs` is what `gh run view --json jobs` answers per run.
// The clock advances by each sleep and by `listSeconds` per `gh run list`.
function world(options: { branch?: string | null; originBranch?: boolean; ahead?: number; origin?: string; runLists?: Run[][]; jobs?: Record<string, unknown[]>; listSeconds?: number } = {}) {
  const { branch = 'main', originBranch = true, ahead = 0, origin = 'https://github.com/owner/repo.git', runLists = [[passed(7)]], jobs = {}, listSeconds = 0 } = options;
  const calls: string[] = [];
  let sleeps = 0;
  let clock = 0;
  const nextRunList = successive(runLists);
  const run = fakeRun(calls, branch, line => {
    if (line === `git rev-parse --verify --quiet refs/remotes/origin/${branch}`) {
      if (!originBranch) throw exited(1, 'git rev-parse exited 1');
      return 'abc\n';
    }
    if (line === `git rev-list --count refs/remotes/origin/${branch}..HEAD`) return `${ahead}\n`;
    if (line === 'git remote get-url origin') return `${origin}\n`;
    if (line === RUN_LIST) {
      clock += listSeconds * 1000;
      return JSON.stringify(nextRunList());
    }
    const view = line.match(/^gh run view (\d+) --repo owner\/repo --json jobs$/);
    if (view) return JSON.stringify({ jobs: jobs[view[1]] ?? [] });
    throw new Error(`unexpected command: ${line}`);
  });
  const sleep = (seconds: number) => {
    sleeps++;
    clock += seconds * 1000;
  };
  return { run, sleep, now: () => clock, calls, sleeps: () => sleeps };
}

describe('ci-gate.mjs', () => {
  it('lets the agent stop when every run of HEAD passed', () => {
    const w = world();
    expect(ciGate(w)).toEqual({ block: false, message: null });
  });

  it('blocks on a failed run, naming it, its failed steps, and how to read and resolve it', () => {
    const w = world({
      runLists: [[failed(7)]],
      jobs: { 7: [{ name: 'Build & Test', conclusion: 'failure', steps: [{ name: 'Typecheck', conclusion: 'success' }, { name: 'Test', conclusion: 'failure' }] }] },
    });
    const result = ciGate(w);
    expect(result.block).toBe(true);
    expect(result.message).toContain('CI https://ci/7 ended failure for 90d1a52; failed: Build & Test / Test');
    expect(result.message).toContain('gh run view 7 --repo owner/repo --log-failed');
    expect(result.message).toContain('gh run rerun 7 --repo owner/repo --failed');
  });

  it('waits for running runs and judges them once they complete', () => {
    const w = world({ runLists: [[running(7)], [running(7)], [passed(7)]] });
    expect(ciGate({ ...w, pollSeconds: 10 })).toEqual({ block: false, message: null });
    expect(w.sleeps()).toBe(2);
  });

  it('blocks when runs are still going after the wait budget, pointing at ci:watch', () => {
    const w = world({ runLists: [[running(7)]] });
    const result = ciGate({ ...w, waitSeconds: 30, pollSeconds: 10 });
    expect(result.block).toBe(true);
    expect(w.sleeps()).toBe(3);
    expect(result.message).toContain('still running');
    expect(result.message).toContain('npm run ci:watch');
  });

  it('counts the time gh itself takes against the wait budget', () => {
    const w = world({ runLists: [[running(7)]], listSeconds: 10 });
    const result = ciGate({ ...w, waitSeconds: 30, pollSeconds: 10 });
    expect(result.block).toBe(true);
    expect(w.sleeps()).toBe(1);
    expect(result.message).toContain('still running');
  });

  it('with no wait budget, reports running runs at once without sleeping', () => {
    const w = world({ runLists: [[running(7)]] });
    const result = ciGate({ ...w, waitSeconds: 0 });
    expect(result.block).toBe(true);
    expect(w.sleeps()).toBe(0);
  });

  it('blocks when no run of HEAD appears, telling the agent to start CI itself and stop again for the gate to wait on it', () => {
    const w = world({ runLists: [[]] });
    const result = ciGate({ ...w, appearSeconds: 20, pollSeconds: 10 });
    expect(result.block).toBe(true);
    expect(w.sleeps()).toBe(2);
    expect(result.message).toContain('gh workflow run ci.yml --repo owner/repo --ref main');
    expect(result.message).toContain('stop again');
    expect(result.message).not.toContain('ci:watch');
  });

  it('with no wait budget, reports a run not listed yet without telling the agent to start one', () => {
    const w = world({ runLists: [[]] });
    const result = ciGate({ ...w, waitSeconds: 0 });
    expect(result.block).toBe(true);
    expect(w.sleeps()).toBe(0);
    expect(result.message).toContain('has not started');
    expect(result.message).not.toContain('gh workflow run');
  });

  it('blocks on commits not pushed to origin, without asking GitHub', () => {
    const w = world({ ahead: 2 });
    const result = ciGate(w);
    expect(result.block).toBe(true);
    expect(result.message).toContain('2 commits on main are not pushed to origin');
    expect(w.calls.some(call => call.startsWith('gh '))).toBe(false);
  });

  it('judges only the newest push or workflow_dispatch run of each workflow', () => {
    const w = world({ runLists: [[passed(9, { event: 'workflow_dispatch' }), failed(8, { event: 'pull_request' }), failed(7)]] });
    expect(ciGate(w)).toEqual({ block: false, message: null });
  });

  it('blocks when any workflow of HEAD fails, whichever passed', () => {
    const w = world({ runLists: [[passed(9), failed(8, { workflowName: 'Docs', conclusion: 'cancelled' })]] });
    const result = ciGate(w);
    expect(result.block).toBe(true);
    expect(result.message).toContain('Docs https://ci/8 ended cancelled for 90d1a52');
  });

  it('blocks when git or gh cannot answer, telling the agent to repair the access', () => {
    const w = world();
    const result = ciGate({ ...w, run: ghUnauthenticated(w.run) });
    expect(result.block).toBe(true);
    expect(result.message).toContain('gh: authentication required');
    expect(result.message).toContain('gh auth status');
  });

  it('blocks when the branch or origin-ref probe fails for any reason other than exit 1, a timeout included', () => {
    for (const probe of ['git symbolic-ref', 'git rev-parse --verify']) {
      for (const error of [exited(128, 'fatal: unable to read HEAD'), exited(null, 'spawnSync git ETIMEDOUT')]) {
        const w = world();
        const failing = (command: string, args: string[]) => {
          if ([command, ...args].join(' ').startsWith(probe)) throw error;
          return w.run(command, args);
        };
        const result = ciGate({ ...w, run: failing });
        expect(result.block, `${probe}: ${error.message}`).toBe(true);
        expect(result.message).toContain(error.message);
      }
    }
  });

  it('lets the agent stop on a detached HEAD, a branch origin does not have, or a non-GitHub origin, without asking GitHub', () => {
    for (const w of [world({ branch: null }), world({ originBranch: false }), world({ origin: 'https://gitlab.com/owner/repo.git' })]) {
      expect(ciGate(w)).toEqual({ block: false, message: null });
      expect(w.calls.some(call => call.startsWith('gh '))).toBe(false);
    }
  });

  describe('hookMain', () => {
    const failing = () => world({ runLists: [[failed(7)]] });

    it('as the Stop hook, blocks with exit 2 and the reason on stderr, whether or not a stop was blocked before', () => {
      for (const stopHookActive of [false, true]) {
        const w = failing();
        const result = hookMain('--stop', { cwd: '/work', stop_hook_active: stopHookActive }, { runIn: () => w.run, sleep: w.sleep });
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('CI https://ci/7 ended failure');
      }
    });

    it('as the Stop hook, exits 0 silently when CI passed', () => {
      const w = world();
      expect(hookMain('--stop', { cwd: '/work' }, { runIn: () => w.run, sleep: w.sleep })).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    });

    it('as the SessionStart hook, puts red CI in the session context on stdout without waiting', () => {
      const w = world({ runLists: [[running(7)]] });
      const result = hookMain('--session-start', { cwd: '/work' }, { runIn: () => w.run, sleep: w.sleep });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('still running');
      expect(w.sleeps()).toBe(0);
    });

    // git answers --git-common-dir per directory: the project and its worktree share one, the
    // other repository has its own, and a directory outside any repository fails.
    function dirs(commonDirs: Record<string, string | Error>) {
      const w = world();
      const judged: string[] = [];
      const runIn = (dir: string) => (command: string, args: string[]) => {
        if (args.join(' ') === 'rev-parse --git-common-dir') {
          const answer = commonDirs[dir];
          if (answer === undefined) throw exited(128, 'fatal: not a git repository');
          if (answer instanceof Error) throw answer;
          return `${answer}\n`;
        }
        if (!judged.includes(dir)) judged.push(dir);
        return w.run(command, args);
      };
      return { runIn, sleep: w.sleep, judged };
    }
    const repos = { '/work': '.git', '/work/.claude/worktrees/x': '/work/.git', '/other': '.git' };

    it("judges the hook input's cwd when it is the project or one of its worktrees", () => {
      for (const cwd of ['/work', '/work/.claude/worktrees/x']) {
        const d = dirs(repos);
        hookMain('--stop', { cwd }, { runIn: d.runIn, sleep: d.sleep, projectDir: '/work' });
        expect(d.judged).toEqual([cwd]);
      }
    });

    it('judges the project when the cwd is another repository or no repository', () => {
      for (const cwd of ['/other', '/tmp']) {
        const d = dirs(repos);
        hookMain('--stop', { cwd }, { runIn: d.runIn, sleep: d.sleep, projectDir: '/work' });
        expect(d.judged).toEqual(['/work']);
      }
    });

    it('blocks, as the Stop hook, when git cannot say which repository the cwd is in for a reason other than not being one', () => {
      const d = dirs({ ...repos, '/work/.claude/worktrees/x': exited(null, 'spawnSync git ETIMEDOUT') });
      const result = hookMain('--stop', { cwd: '/work/.claude/worktrees/x' }, { runIn: d.runIn, sleep: d.sleep, projectDir: '/work' });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('spawnSync git ETIMEDOUT');
      expect(d.judged).toEqual([]);
    });

    it('refuses an unknown mode with a usage message and exit 1', () => {
      const w = world();
      const result = hookMain('--bogus', { cwd: '/work' }, { runIn: () => w.run, sleep: w.sleep });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('usage: ci-gate.mjs --stop | --session-start');
      expect(w.calls).toEqual([]);
    });
  });

  // A hook that times out does not block, so the Stop hook's timeout must outlast the wait and
  // the gh calls that end it.
  it('is the Stop and SessionStart hook, with a Stop timeout that outlasts the wait', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
    const hook = (event: string) => settings.hooks[event].flatMap((entry: { hooks: { command: string; timeout: number }[] }) => entry.hooks).find((h: { command: string }) => h.command.includes('scripts/ci-gate.mjs'));
    expect(hook('Stop').command).toMatch(/ --stop$/);
    expect(hook('SessionStart').command).toMatch(/ --session-start$/);
    expect(hook('Stop').timeout).toBeGreaterThanOrEqual(STOP_WAIT_SECONDS + 3 * COMMAND_TIMEOUT_SECONDS);
  });
});
