# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 10. textResult in every text result of the MCP server

`createGmailServer` in `src/server.ts` builds its text results through `textResult` in the batch and filter handlers only; every other handler still spells out `{ content: [{ type: "text", text }] }`. Use `textResult` in each handler that returns a single text block, with the result text unchanged, which `src/server.test.ts` and the tool tests pin.

## 11. Tests and scripts under npm run typecheck

`tsconfig.json` includes only `src` and excludes `src/**/*.test.ts`, so the test files and `scripts/*.ts` are never type-checked; a wrong helper signature in a test shows up only when the test runs, if at all. Add a `tsconfig.test.json` with `noEmit` that includes the test files, `scripts/*.ts` and the test helpers, run it from `npm run typecheck` after the build config, and correct what it reports.
