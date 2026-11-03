# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. npm run verify runs the dependency audit CI runs

CI's `Audit dependencies` step runs `npm audit --audit-level=high`, but `npm run verify` does not, so an advisory published against an unchanged lockfile is found only after a push, and the push has to be followed by a second commit and push. Add an `audit` npm script running `npm audit --audit-level=high`, have `.github/workflows/ci.yml` run `npm run audit` in that step, and add `audit` to `STEPS` in `scripts/verify.mjs` after `lockfile:lint`, so `npm run land` and every pre-commit `verify` fail on it before anything is pushed. Describe the step in the `npm run verify` sentence of `AGENTS.md`. Test that `STEPS` holds `audit` after `lockfile:lint` and that the npm script and the CI step run the same command.

## 2. ci:watch prints the log of each failed step

When a run fails, `scripts/ci-watch.mjs` names the failed jobs and steps but not why they failed, so the cause is read by a separate `gh run view <id> --log-failed`, which needs `--repo` set to origin's repository or it reads the upstream fork's. After the verdict line of a failed run, have `ci:watch` run `gh run view <id> --repo <repo> --log-failed` through its `run` and print the last 60 lines, in `--quiet` mode too, still exiting 1; a failure of that command prints one line naming it and keeps the exit code 1. Test with `run` stubbed: a passing run prints no log, a failed run prints the tail of its log after the verdict line, and a log command that fails is named without changing the exit code.

## 3. Tool schemas use zod 4's string issue codes

`src/tools.ts` raises custom issues with `z.ZodIssueCode.custom` in three places (the history output check and the watermark checks), and zod 4 marks `ZodIssueCode` deprecated in favour of the string literal codes. Replace each with `code: 'custom'`. The existing tests of the history output check and of the watermark refusals cover the messages.

## 4. The hook and CLI scripts take their git runner and I/O as arguments

Tests of these scripts build scratch git repositories in the system temp folder and spawn `node`, because the logic under test runs git, reads stdin or writes files itself, and no exported function reaches it; each such case takes seconds and can time out `npm run verify`. Give each the seam `scripts/graph-check.mjs`, `land.mjs` and `push.mjs` already have (a `run` and `log` passed in), behaviour unchanged, and move the tests that reach them through a process or repository to in-process calls:
- `scripts/commit-hook.mjs`: export `commitTarget(command, cwd)`, so the refused and ignored commands in `check-roadmap.test.ts` and `check-duplicates.test.ts` are a table of literals.
- `scripts/check-duplicates.mjs`: export `main(args, io)` returning its exit code and `runCommitHook(payload, run)`, and split the jscpd run from the `git ls-files -s` parsing, so clone detection and the deny decision need no repository.
- `scripts/check-roadmap.mjs`: export `main(args, io)`, `runHook(payload, env)` and `runCommitHook(payload, run)`.
- `scripts/roadmap-close.mjs`: export `main(args, { read, write })`, so the usage and refusal cases need no `node` spawn.
- `scripts/script-support.mjs`: export the parsing of `git rev-parse` output behind `mainCheckoutOf`.
- `scripts/import-prompts.mjs`: let `everInRoadmapHistory` take the `git log` runner.
Keep a real repository only for behaviour that is git's own: the hook reading the staged blobs and not the working copy, and `git log -S` finding a removed line.

## 5. npm run land refuses a branch name that git would read as an option

`scripts/land.mjs` passes the branch argument straight into `git merge-base --is-ancestor origin/main <branch>` and `git merge --ff-only --quiet <branch>`, so a name starting with `-` is parsed by git as an option. Refuse such a name with the usage line and exit code 2 before any git command runs, and test it with `scriptedRun` from `scripts/git-fixture.ts`: the runner receives no call.

## 6. The staged duplicate-code check keeps paths that contain a tab

`writeStagedFiles` in `scripts/check-duplicates.mjs` reads each `git ls-files -s -z` entry with `line.split('\t')`, so a path holding a tab is cut at its second tab and the staged copy is written under the wrong name. Split each entry at its first tab only, so the path is everything after it.

## 7. import-prompts keeps a second top-level heading from becoming a roadmap item heading

`importPrompts` in `scripts/import-prompts.mjs` moves every heading of depth 5 or less after the title down one level, so a second `# ` heading in a prompt becomes `## `, which `roadmap:close` and the numbered-heading check read as an item boundary. Move headings after the title so that none lands at depth 2, and test it with a prompt holding a second `# ` heading: the imported item holds no `## ` line besides its own.

## 8. graph:check prints the steps of flows sharing a label apart

`scripts/graph-check.mjs` finds a flow's steps by `p.label`, but labels repeat across processes (in this index `SearchCommand → List`, `ListLabelsCommand → List` and `ListFiltersCommand → List` each label three), so the steps of every process with that label come back in one list ordered by step, interleaved. Return `p.id` with each row (`RETURN p.id, r.step, s.id, s.filePath ORDER BY p.id, r.step`) and print each process under its own heading naming the label and the id. Test with the runner stubbed: an answer holding two processes of one label prints two step lists, each in step order.

## 9. graph:check names a flow listing it cannot read

When `detect-changes` rates the risk `high` or `critical` and prints `Affected execution flows:`, but no line under it matches `FLOW_LINE` in `scripts/graph-check.mjs`, the check prints no steps and says nothing, so a change in how GitNexus formats those lines turns the steps off silently. In that case print one line naming the unrecognised flow listing, keeping the exit code. Test with the runner stubbed: a high rating whose flow lines are in another format prints that line and runs no steps query.
