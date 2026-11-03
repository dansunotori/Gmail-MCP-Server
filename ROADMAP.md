# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

Do not renumber. Numbers are unique. Bug and code fixes precede coding and test machinery.

<!-- highest item number: 30 -->

## 5. npm run land refuses a branch name that git would read as an option

`scripts/land.mjs` passes the branch argument straight into `git merge-base --is-ancestor origin/main <branch>` and `git merge --ff-only --quiet <branch>`, so a name starting with `-` is parsed by git as an option. Refuse such a name with the usage line and exit code 2 before any git command runs, and test it with `scriptedRun` from `scripts/git-fixture.ts`: the runner receives no call.

## 6. The staged duplicate-code check keeps paths that contain a tab

`writeStagedFiles` in `scripts/check-duplicates.mjs` reads each `git ls-files -s -z` entry with `line.split('\t')`, so a path holding a tab is cut at its second tab and the staged copy is written under the wrong name. Split each entry at its first tab only, so the path is everything after it.

## 7. import-prompts keeps a second top-level heading from becoming a roadmap item heading

`importPrompts` in `scripts/import-prompts.mjs` moves every heading of depth 5 or less after the title down one level, so a second `# ` heading in a prompt becomes `## `, which `roadmap:close` and the numbered-heading check read as an item boundary. Move headings after the title so that none lands at depth 2, and test it with a prompt holding a second `# ` heading: the imported item holds no `## ` line besides its own.

## 29. roadmap:check refuses an item removed without its number recorded

An item deleted from `ROADMAP.md` by hand, not with `npm run roadmap:close`, leaves no `<!-- highest item number: N -->` record, so when it was never committed its number can be given to the next imported item. In the staged check of `scripts/check-roadmap.mjs`, refuse a staged `ROADMAP.md` that drops a `## N.` heading the working copy or `HEAD` holds while its highest-number comment (`recordedHighest` in `scripts/roadmap-close.mjs`) records less than `N`, naming the heading and `npm run roadmap:close -- <N>`. Also refuse a `ROADMAP.md` whose `## N.` headings repeat a number or hold none. Test both refusals, and that a close made with `closeItem` passes.

## 31. verify refuses a tracked file that .gitignore matches

A file committed before its `.gitignore` rule stays tracked, so the rule does nothing for it, and nothing reports that. Add `scripts/check-ignored.mjs`, run as `npm run ignored:check` in CI and in `STEPS` of `scripts/verify.mjs` after `lockfile:lint`, that runs `git ls-files -ci --exclude-standard -z` and fails naming each path and `git rm --cached <path>`, and that also fails on a non-comment `.gitignore` line repeated in the file. Describe it in the `npm run verify` sentence of `AGENTS.md`. Test with a stubbed runner: a tracked ignored path fails naming it, a repeated line fails naming it, and a clean listing passes.

## 32. npm run roadmap:add numbers a new item

Items written by hand take a number chosen by reading the headings, the highest-number comment and the git history, which `nextNumber` and `highestNumberInRoadmapHistory` in `scripts/import-prompts.mjs` already compute. Add `scripts/roadmap-add.mjs`, run as `npm run roadmap:add -- "<title>"`, that appends `## <next>. <title>` with an empty body to `ROADMAP.md` using those functions and prints the number, refusing an empty title. Name it in the Roadmap paragraph of `AGENTS.md` as the way to add an item. Test that it numbers above an item closed before any commit and above a number only the history holds.
