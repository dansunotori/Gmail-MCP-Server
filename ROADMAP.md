# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. npm run roadmap:close -- <n>

Closing a roadmap item means deleting its section by hand and renumbering every later heading, three or four edits per item, each a chance to drop a paragraph or skip a number. Add `scripts/roadmap-close.mjs` as `npm run roadmap:close -- <n>`: it removes the `## <n>.` section up to the next `## ` heading, renumbers the later headings from `n` in order, keeps the preamble and spacing as they are, and refuses with a message naming the headings it found when no section `<n>` exists or the headings are not numbered 1, 2, 3, … in order. Test removal of the first, a middle and the last item, the refusals, and that `npm run roadmap:check` passes on the result.

## 2. npm run push: push main and watch its CI in one step

Every sprint on `main` ends with `git push origin main` followed by `npm run ci:watch`, two commands an agent has to remember in order before the Stop gate accepts the turn. Add `scripts/push.mjs` as `npm run push`: it refuses unless the checkout is on `main` with no uncommitted changes, runs `git push origin main`, then `npm run ci:watch -- --quiet`, stopping at the first failing step with its exit code, as `scripts/land.mjs` does for those two steps (share them with it rather than repeating them). Test with git and npm stubbed as `scripts/land.test.ts` does, and name it in the Branch Workflow section of AGENTS.md.
