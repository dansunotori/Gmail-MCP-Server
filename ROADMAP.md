# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 5. download_email txt refuses a stub whose HTML part cannot be fetched

The txt format refuses a message whose plain part cannot be fetched, but when the plain part is only a stub and the HTML part it points at cannot be fetched, the txt file is saved holding the stub, with nothing saying the real content is missing. Refuse the txt format in that case too, with the HTML failure's own `GmailRequestError` wrapped by `withContext` so the exit code follows Gmail's status, and test it in `src/read-tools.test.ts` and `src/cli/commands.test.ts`.

## 6. npm run land: one command from a worktree branch to green CI on main

Landing a worktree branch takes the same sequence every time, run by hand: in the main checkout, check the tree is clean and on `main`, fetch, refuse a branch that is not a fast-forward of `origin/main` (naming the `git rebase origin/main` to run in the worktree), fast-forward `main` to it, run `npm ci` when `package-lock.json` differs between the old and new `HEAD`, run `npm run verify`, push, and run `npm run ci:watch`. Add `scripts/land.mjs` as `npm run land -- <branch>`, run from the main checkout, which does exactly that and stops at the first failing step, naming it and exiting with its code; a tree with uncommitted changes, another session's included, is refused before anything moves. Test it on fixture repositories from `scripts/git-fixture.ts` with npm and gh stubbed, and describe it in the Branch Workflow section of `AGENTS.md`.

## 7. npm run verify passes in a linked worktree

Two steps of `npm run verify` fail in a linked worktree after every check before them has passed, so the failure has to be read to tell it from a real one. `npm run graph:check` stops because `.gitnexus/run.cjs` is untracked and exists only in the main checkout, and `npm run install-cli` refuses to relink the CLIs, since the links in `~/.local/bin` point into the main checkout. Detect a linked worktree in both scripts (`git rev-parse --git-dir` differs from `--git-common-dir`): `scripts/graph-check.mjs` runs the main checkout's `.gitnexus/run.cjs` (the parent of the git common dir) against the worktree, and `scripts/install-cli.mjs` builds as before, leaves the links alone and exits 0 with one line saying the CLIs stay linked from the main checkout. A link pointing outside both checkouts still fails. Test each case.

## 8. The verify steps in AGENTS.md kept in step with STEPS by a test

The Branch Workflow section of `AGENTS.md` names each `npm run verify` step in order, and the list is edited by hand whenever `STEPS` in `scripts/verify.mjs` changes. Add a test in `scripts/verify.test.ts` that reads `AGENTS.md` and asserts it names `npm run <step>` for every entry of `STEPS`, in the same order, and no other step, so a step added to verify without the sentence, or the other way round, fails with the step named.

## 9. The duplicate-code commit hook checks what the commit records

`scripts/check-duplicates.mjs --commit-hook` reads the working copy of each path git's index lists, so a file staged in part is checked as the working tree holds it, not as the commit records it; CI catches the difference only after the push. Write each in-scope staged blob (`git ls-files -s` with `git cat-file --batch`) under its own path in a temporary directory, run jscpd there, and report the clones by their repository paths. Keep `npm run duplicates:check` on the working copy. Test a commit whose staged copy holds a clone its working copy does not, and the reverse.

## 10. textResult in every text result of the MCP server

`createGmailServer` in `src/server.ts` builds its text results through `textResult` in the batch and filter handlers only; every other handler still spells out `{ content: [{ type: "text", text }] }`. Use `textResult` in each handler that returns a single text block, with the result text unchanged, which `src/server.test.ts` and the tool tests pin.

## 11. Tests and scripts under npm run typecheck

`tsconfig.json` includes only `src` and excludes `src/**/*.test.ts`, so the test files and `scripts/*.ts` are never type-checked; a wrong helper signature in a test shows up only when the test runs, if at all. Add a `tsconfig.test.json` with `noEmit` that includes the test files, `scripts/*.ts` and the test helpers, run it from `npm run typecheck` after the build config, and correct what it reports.
