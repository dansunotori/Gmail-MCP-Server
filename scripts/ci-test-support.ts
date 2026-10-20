// What the fake worlds of the ci-gate and ci-watch tests share: the commit at HEAD, git's
// answers about it, and a gh that cannot authenticate.

export const SHA = '90d1a527230920b4a366bd91a00cacb33ed831eb';
export const REPO = 'owner/repo';

type Run = (command: string, args: string[]) => string;

// A failed command as execFileSync reports it: `status` is the exit code, null when killed.
export const exited = (status: number | null, message: string) => Object.assign(new Error(message), { status });

// git's answer to a query about HEAD and the branch it is on (null for a detached HEAD), or
// undefined for any other command line.
function headAnswer(line: string, branch: string | null): string | undefined {
  if (line === 'git rev-parse HEAD') return `${SHA}\n`;
  if (line !== 'git symbolic-ref --quiet --short HEAD') return undefined;
  if (branch === null) throw exited(1, 'git symbolic-ref exited 1');
  return `${branch}\n`;
}

// A fake run that records each command line in calls and answers it by the line: a query about
// HEAD on the given branch itself, any other line through answer.
export const fakeRun = (calls: string[], branch: string | null, answer: (line: string) => string): Run => (command, args) => {
  const line = [command, ...args].join(' ');
  calls.push(line);
  return headAnswer(line, branch) ?? answer(line);
};

// The given answers one per call, the last one repeating.
export function successive<T>(answers: T[]): () => T {
  let index = 0;
  return () => answers[Math.min(index++, answers.length - 1)];
}

// run, except that every gh command fails as gh does when it is not logged in.
export const ghUnauthenticated = (run: Run): Run => (command, args) => {
  if (command === 'gh') throw new Error('gh: authentication required');
  return run(command, args);
};
