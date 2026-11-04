# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

Do not renumber. Numbers are unique. Bug and code fixes precede coding and test machinery.

<!-- highest item number: 33 -->

## 32. npm run roadmap:add numbers a new item

Items written by hand take a number chosen by reading the headings, the highest-number comment and the git history, which `nextNumber` and `highestNumberInRoadmapHistory` in `scripts/import-prompts.mjs` already compute. Add `scripts/roadmap-add.mjs`, run as `npm run roadmap:add -- "<title>"`, that appends `## <next>. <title>` with an empty body to `ROADMAP.md` using those functions and prints the number, refusing an empty title. Name it in the Roadmap paragraph of `AGENTS.md` as the way to add an item. Test that it numbers above an item closed before any commit and above a number only the history holds.

## 34. npm run verify runs its quick checks before the test suite

`STEPS` in `scripts/verify.mjs` runs `test` first, so a duplicated block or a type error is reported only after the whole suite has run, and fixing it means running the suite again before the quick check is reached. Order `STEPS` as `lockfile:lint`, `roadmap:check`, `duplicates:check`, `typecheck`, `test`, `audit`, `graph:check`, `install-cli`, keeping the CLI rebuild last, and reorder the `npm run verify` sentence of `AGENTS.md` to match. Update the order test in `scripts/verify.test.ts`, and test that `duplicates:check` and `typecheck` come before `test`.
