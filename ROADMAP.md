# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. graph:check prints the steps of each affected flow on a HIGH or CRITICAL rating

A HIGH or CRITICAL `detect-changes` rating has to be traced flow by flow before a commit: the process ids found by label, then each step from the `STEP_IN_PROCESS` edges, several hand-written cypher queries per rating. When the `Risk level:` line of `detect-changes` reads `high` or `critical`, have `scripts/graph-check.mjs` query each affected flow's steps (`MATCH (s)-[r:CodeRelation]->(p:Process) WHERE r.type = 'STEP_IN_PROCESS' AND p.label = '<label>' RETURN r.step, s.id ORDER BY r.step`) and print each flow as its ordered step ids with their files, keeping the exit code `detect-changes` gave. Test with the runner stubbed: a low or medium rating prints no steps, a high one prints each listed flow's steps in order, and a flow the query does not find is named as not found.

## 2. npm run verify runs the dependency audit CI runs

CI's `Audit dependencies` step runs `npm audit --audit-level=high`, but `npm run verify` does not, so an advisory published against an unchanged lockfile is found only after a push, and the push has to be followed by a second commit and push. Add an `audit` npm script running `npm audit --audit-level=high`, have `.github/workflows/ci.yml` run `npm run audit` in that step, and add `audit` to `STEPS` in `scripts/verify.mjs` after `lockfile:lint`, so `npm run land` and every pre-commit `verify` fail on it before anything is pushed. Describe the step in the `npm run verify` sentence of `AGENTS.md`. Test that `STEPS` holds `audit` after `lockfile:lint` and that the npm script and the CI step run the same command.

## 3. ci:watch prints the log of each failed step

When a run fails, `scripts/ci-watch.mjs` names the failed jobs and steps but not why they failed, so the cause is read by a separate `gh run view <id> --log-failed`, which needs `--repo` set to origin's repository or it reads the upstream fork's. After the verdict line of a failed run, have `ci:watch` run `gh run view <id> --repo <repo> --log-failed` through its `run` and print the last 60 lines, in `--quiet` mode too, still exiting 1; a failure of that command prints one line naming it and keeps the exit code 1. Test with `run` stubbed: a passing run prints no log, a failed run prints the tail of its log after the verdict line, and a log command that fails is named without changing the exit code.

## 4. Tool schemas use zod 4's string issue codes

`src/tools.ts` raises custom issues with `z.ZodIssueCode.custom` in three places (the history output check and the watermark checks), and zod 4 marks `ZodIssueCode` deprecated in favour of the string literal codes. Replace each with `code: 'custom'`. The existing tests of the history output check and of the watermark refusals cover the messages.

## 5. The hook and CLI scripts take their git runner and I/O as arguments

Tests of these scripts build scratch git repositories in the system temp folder and spawn `node`, because the logic under test runs git, reads stdin or writes files itself, and no exported function reaches it; each such case takes seconds and can time out `npm run verify`. Give each the seam `scripts/graph-check.mjs`, `land.mjs` and `push.mjs` already have (a `run` and `log` passed in), behaviour unchanged, and move the tests that reach them through a process or repository to in-process calls:
- `scripts/commit-hook.mjs`: export `commitTarget(command, cwd)`, so the refused and ignored commands in `check-roadmap.test.ts` and `check-duplicates.test.ts` are a table of literals.
- `scripts/check-duplicates.mjs`: export `main(args, io)` returning its exit code and `runCommitHook(payload, run)`, and split the jscpd run from the `git ls-files -s` parsing, so clone detection and the deny decision need no repository.
- `scripts/check-roadmap.mjs`: export `main(args, io)`, `runHook(payload, env)` and `runCommitHook(payload, run)`.
- `scripts/roadmap-close.mjs`: export `main(args, { read, write })`, so the usage and refusal cases need no `node` spawn.
- `scripts/install-cli.mjs`: export the parsing of `git rev-parse` output behind `mainCheckoutOf`.
- `scripts/import-prompts.mjs`: let `everInRoadmapHistory` take the `git log` runner.
Keep a real repository only for behaviour that is git's own: the hook reading the staged blobs and not the working copy, and `git log -S` finding a removed line.
