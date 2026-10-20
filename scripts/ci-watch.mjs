#!/usr/bin/env node
// Watches the CI runs of the commit just pushed (npm run ci:watch): the runs the push of the
// current branch started for HEAD, found by its full SHA rather than by being the latest run
// listed, waited for until GitHub lists them, watched to the end, their progress shown unless
// --quiet is given (npm run ci:watch -- --quiet), which prints only each run's verdict line.
// Exits 0 when every run
// passes, 1 when one does not (naming the run and its failed jobs and steps), 2 when HEAD is
// detached or not pushed to origin, no run appears in time, or git or gh fails.
import { execFileSync, spawnSync } from 'child_process';
import { runDirectly, sleep } from './script-support.mjs';

// owner/name of a GitHub remote URL (https, ssh or scp-like), or null for any other host.
export function parseRepo(url) {
  const match = url.match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

// "job / step" for each failed step of a `gh run view --json jobs` result; a failed job whose
// steps report no failure is named alone.
export function failedSteps(jobs) {
  const failed = [];
  for (const job of jobs ?? []) {
    if (job.conclusion !== 'failure') continue;
    const steps = (job.steps ?? []).filter(step => step.conclusion === 'failure');
    if (steps.length === 0) failed.push(job.name);
    for (const step of steps) failed.push(`${job.name} / ${step.name}`);
  }
  return failed;
}

// run(command, args) returns a command's stdout and throws when it fails; watch(id, repo)
// shows a run's progress, its result unused; sleep(seconds) waits; log(line) reports. A git or
// gh failure exits 2, so exit 1 always means a run that did not pass.
export function ciWatch(options) {
  let commit = 'HEAD';
  try {
    const sha = options.run('git', ['rev-parse', 'HEAD']).trim();
    commit = sha.slice(0, 7);
    return watchRuns(options, sha, commit);
  } catch (error) {
    options.log(`ci:watch: could not read the CI runs of ${commit}: ${error.message.trim()}`);
    return 2;
  }
}

function watchRuns({ run, watch, sleep, log, waitSeconds = 180, pollSeconds = 5 }, sha, short) {
  let branch;
  try {
    branch = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  } catch {
    log(`ci:watch: HEAD ${short} is not on a branch; check out the branch that was pushed`);
    return 2;
  }
  if (run('git', ['branch', '-r', '--contains', sha, '--list', `origin/${branch}`]).trim() === '') {
    log(`ci:watch: HEAD ${short} is not pushed to origin/${branch}; push it, then run ci:watch again`);
    return 2;
  }
  const origin = run('git', ['remote', 'get-url', 'origin']).trim();
  const repo = parseRepo(origin);
  if (repo === null) {
    log(`ci:watch: origin ${origin} is not a GitHub repository`);
    return 2;
  }
  // Only the runs the push of this branch started: a run of the same commit from another
  // branch or trigger (workflow_dispatch, pull_request) would otherwise stand in for them.
  let runs = [];
  for (let waited = 0; ; waited += pollSeconds) {
    runs = JSON.parse(run('gh', ['run', 'list', '--repo', repo, '--commit', sha, '--branch', branch, '--event', 'push', '--json', 'databaseId,name,url,status']));
    if (runs.length > 0) break;
    if (waited >= waitSeconds) {
      log(`ci:watch: no CI run for ${short} appeared on ${repo} within ${waitSeconds}s`);
      return 2;
    }
    sleep(pollSeconds);
  }
  let failed = false;
  for (const { databaseId } of runs) {
    const id = String(databaseId);
    watch(id, repo);
    // The watcher only shows progress: it can end before the run does (an auth method gh run
    // watch does not support, a dropped connection), so the run is read once GitHub reports it
    // completed, polled until then.
    let view;
    for (;;) {
      view = JSON.parse(run('gh', ['run', 'view', id, '--repo', repo, '--json', 'status,conclusion,name,url,jobs']));
      if (view.status === 'completed') break;
      sleep(pollSeconds);
    }
    if (view.conclusion === 'success') {
      log(`ci:watch: ${view.name} ${view.url} passed for ${short}`);
      continue;
    }
    failed = true;
    const steps = failedSteps(view.jobs);
    log(`ci:watch: ${view.name} ${view.url} ended ${view.conclusion} for ${short}${steps.length > 0 ? `; failed: ${steps.join(', ')}` : ''}`);
  }
  return failed ? 1 : 0;
}

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

// The watch for the command-line arguments, or null for arguments not read here. gh run watch
// shows the run's progress; how it exits is not the run's result, which ciWatch reads from gh run
// view once the run is completed. --quiet shows no progress, so only the verdict lines print.
/**
 * @param {string[]} argv
 * @param {(command: string, args: string[], options: { stdio: 'inherit' }) => { error?: Error }} [spawn]
 */
export function watcherFor(argv, spawn = spawnSync) {
  if (argv.length === 1 && argv[0] === '--quiet') return () => {};
  if (argv.length > 0) return null;
  return (id, repo) => {
    const result = spawn('gh', ['run', 'watch', id, '--repo', repo, '--interval', '10'], { stdio: 'inherit' });
    if (result.error) throw result.error;
  };
}

if (runDirectly(import.meta.url)) {
  const watch = watcherFor(process.argv.slice(2));
  if (watch === null) {
    process.stderr.write('usage: npm run ci:watch [-- --quiet]\n');
    process.exitCode = 2;
  } else {
    process.exitCode = ciWatch({ run, watch, sleep, log: line => process.stderr.write(`${line}\n`) });
  }
}
