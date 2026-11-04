# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

Do not renumber. Numbers are unique. Bug and code fixes precede coding and test machinery.

<!-- highest item number: 33 -->

## 34. npm run verify runs its quick checks before the test suite

`STEPS` in `scripts/verify.mjs` runs `test` first, so a duplicated block or a type error is reported only after the whole suite has run, and fixing it means running the suite again before the quick check is reached. Order `STEPS` as `lockfile:lint`, `roadmap:check`, `duplicates:check`, `typecheck`, `test`, `audit`, `graph:check`, `install-cli`, keeping the CLI rebuild last, and reorder the `npm run verify` sentence of `AGENTS.md` to match. Update the order test in `scripts/verify.test.ts`, and test that `duplicates:check` and `typecheck` come before `test`.
