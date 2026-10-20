// What the script tests share: throwaway git repositories, and running a script as a hook or a
// command line does. git runs in the repositories without any repository location the test run
// inherits (git sets GIT_DIR and others when it runs a hook), so a test never reaches the
// checkout it runs from.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

// git in repo, its output returned; a failed command throws.
export const gitIn = (repo: string) => (...args: string[]) => execFileSync('git', args, { cwd: repo, env: isolatedEnv, stdio: 'pipe' });

// A new empty repository in the temporary directory, by its real path, with an identity and
// unsigned commits so a test can commit in it.
export function fixtureRepo(prefix: string): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = gitIn(repo);
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return repo;
}

// The script run by node with args, input on stdin: its exit code, stdout and stderr.
export function runScript(script: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string }) {
  try {
    return { code: 0, stdout: execFileSync('node', [script, ...args], { ...options, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '' };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { code: failed.status, stdout: failed.stdout, stderr: failed.stderr };
  }
}
