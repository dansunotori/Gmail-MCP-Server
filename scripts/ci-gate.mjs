#!/usr/bin/env node
// The CI gate the project's Claude Code hooks run (.claude/settings.json), so no agent ends its
// turn while CI is red. `--stop` is the Stop hook: it judges the CI of HEAD, waiting for runs
// still going, and exits 2 with the reason on stderr while anything is wrong, which keeps the
// agent working; there is no once-only pass, so the way out is to resolve what it names.
// `--session-start` is the SessionStart hook: it judges at once, without waiting, and puts
// anything wrong in the new session's context on stdout.
//
// Wrong means: commits on a branch origin has that are not pushed (judged before anything is
// asked of GitHub, whatever the host); no CI run for pushed HEAD; runs still going after the
// wait budget; the newest push or workflow_dispatch run of any workflow for HEAD not ending in
// success; or git or gh failing to answer, a hung command included. A detached HEAD, a branch
// origin does not have and a pushed HEAD on a non-GitHub origin are not judged.
//
// A hook that times out does not block, so the Stop wait plus the gh calls that end it stay
// under the hook's timeout in .claude/settings.json: the wait is measured in wall-clock time
// and every command is killed after COMMAND_TIMEOUT_SECONDS.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { failedSteps, parseRepo } from './ci-watch.mjs';

export const STOP_WAIT_SECONDS = 420;
export const COMMAND_TIMEOUT_SECONDS = 30;

const PASSED = new Set(['success', 'skipped', 'neutral']);
const ok = { block: false, message: null };
const blocked = message => ({ block: true, message: `CI gate: ${message}` });

// run(command, args) returns a command's stdout and throws when it fails; sleep(seconds)
// waits; now() is the time in milliseconds. waitSeconds bounds the whole wait, appearSeconds
// the wait for a first run; a waitSeconds of 0 judges at once.
export function ciGate(options) {
  try {
    return judge(options);
  } catch (error) {
    return unreadable(error);
  }
}

const unreadable = error => blocked(`could not read the CI state of HEAD: ${error.message.trim()}. Repair the access (gh auth status, gh auth login, the network, the origin remote), then stop again so the gate can read it.`);

function judge({ run, sleep, now = Date.now, waitSeconds = STOP_WAIT_SECONDS, appearSeconds = 60, pollSeconds = 10 }) {
  const sha = run('git', ['rev-parse', 'HEAD']).trim();
  const short = sha.slice(0, 7);
  const branch = probe(run, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch === null) return ok;
  if (probe(run, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]) === null) return ok;
  const ahead = Number(run('git', ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`]).trim());
  if (ahead > 0) {
    return blocked(`${ahead} commit${ahead === 1 ? '' : 's'} on ${branch} ${ahead === 1 ? 'is' : 'are'} not pushed to origin, so CI has not checked ${ahead === 1 ? 'it' : 'them'}. Run npm run verify, push (pull --rebase first if origin moved), then run npm run ci:watch and resolve any failure.`);
  }
  const repo = parseRepo(run('git', ['remote', 'get-url', 'origin']).trim());
  if (repo === null) return ok;

  const start = now();
  let runs;
  for (;;) {
    runs = newestPerWorkflow(JSON.parse(run('gh', ['run', 'list', '--repo', repo, '--commit', sha, '--branch', branch, '--json', 'databaseId,workflowName,event,status,conclusion,url'])));
    const waited = (now() - start) / 1000;
    const appeared = runs.length > 0;
    if (appeared && runs.every(r => r.status === 'completed')) break;
    if (!appeared && waitSeconds === 0) {
      return blocked(`CI for pushed HEAD ${short} has not started on ${repo}. Run npm run ci:watch and resolve any failure; the Stop hook blocks until CI passes.`);
    }
    if (!appeared && waited >= Math.min(appearSeconds, waitSeconds)) {
      return blocked(`no CI run exists for pushed HEAD ${short} on ${repo}. Start one with gh workflow run ci.yml --repo ${repo} --ref ${branch}, then stop again: the gate waits for it and judges it.`);
    }
    if (appeared && waited >= waitSeconds) {
      const going = runs.filter(r => r.status !== 'completed').map(r => `${r.workflowName} ${r.url}`);
      return blocked(`CI for HEAD ${short} is still running (${going.join(', ')}). Run npm run ci:watch to wait for it, and resolve any failure it reports.`);
    }
    sleep(pollSeconds);
  }

  const red = runs.filter(r => !PASSED.has(r.conclusion));
  if (red.length === 0) return ok;
  const lines = red.map(r => {
    const steps = failedSteps(JSON.parse(run('gh', ['run', 'view', String(r.databaseId), '--repo', repo, '--json', 'jobs'])).jobs);
    return `${r.workflowName} ${r.url} ended ${r.conclusion} for ${short}${steps.length > 0 ? `; failed: ${steps.join(', ')}` : ''}. Read it with gh run view ${r.databaseId} --repo ${repo} --log-failed; if GitHub is at fault (runner, network, outage), rerun it with gh run rerun ${r.databaseId} --repo ${repo} --failed.`;
  });
  return blocked(`CI is red. ${lines.join(' ')} If the code, tests or config are at fault, fix them, run npm run verify, commit and push. Then run npm run ci:watch until it passes.`);
}

// A git query run with --quiet, which exits 1 for "no" (a detached HEAD, an absent ref): null
// then, the trimmed answer otherwise. Any other failure, a timeout included, is thrown, so it
// blocks rather than passes.
function probe(run, args) {
  try {
    return run('git', args).trim();
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

// gh lists the newest run first; a run of HEAD from a pull_request belongs to another ref.
function newestPerWorkflow(runs) {
  const newest = new Map();
  for (const r of runs) {
    if (r.event !== 'push' && r.event !== 'workflow_dispatch') continue;
    if (!newest.has(r.workflowName)) newest.set(r.workflowName, r);
  }
  return [...newest.values()];
}

// The directory to judge: the hook input's cwd when it is the project or one of its worktrees
// (they share one git common dir), otherwise the project, so an agent that changed directory
// to another repository or out of any is still judged on this one. git exits 128 outside a
// repository; any other failure, a timeout included, is thrown.
function judgedDir(cwd, projectDir, runIn) {
  if (!projectDir) return cwd ?? process.cwd();
  if (!cwd || cwd === projectDir) return projectDir;
  const commonDir = dir => path.resolve(dir, runIn(dir)('git', ['rev-parse', '--git-common-dir']).trim());
  let cwdCommonDir;
  try {
    cwdCommonDir = commonDir(cwd);
  } catch (error) {
    if (error.status === 128) return projectDir;
    throw error;
  }
  return cwdCommonDir === commonDir(projectDir) ? cwd : projectDir;
}

// mode is --stop or --session-start; input is the hook's stdin JSON; runIn(dir) gives the run
// function for that directory; projectDir is $CLAUDE_PROJECT_DIR.
export function hookMain(mode, input, { runIn, sleep, now, projectDir }) {
  if (mode !== '--stop' && mode !== '--session-start') {
    return { exitCode: 1, stdout: '', stderr: 'usage: ci-gate.mjs --stop | --session-start (hook input JSON on stdin)\n' };
  }
  const sessionStart = mode === '--session-start';
  let verdict;
  try {
    const run = runIn(judgedDir(input.cwd, projectDir, runIn));
    verdict = ciGate({ run, sleep, now, ...(sessionStart ? { waitSeconds: 0 } : {}) });
  } catch (error) {
    verdict = unreadable(error);
  }
  const { block, message } = verdict;
  if (sessionStart) return { exitCode: 0, stdout: block ? `${message} Resolve it before any other work.\n` : '', stderr: '' };
  return block ? { exitCode: 2, stdout: '', stderr: `${message}\n` } : { exitCode: 0, stdout: '', stderr: '' };
}

const runIn = cwd => (command, args) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: COMMAND_TIMEOUT_SECONDS * 1000 });

const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

// Run directly (not imported by the tests). Node reports the module by its real path, so the
// script path is resolved the same way.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    // Run by hand without hook input: judge the current directory.
  }
  const result = hookMain(process.argv[2], input, { runIn, sleep, projectDir: process.env.CLAUDE_PROJECT_DIR });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
