# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. graph:check rebuilds an index holding nodes with an empty id

An incremental `analyze --index-only` keeps the rows of unchanged files, and those rows can hold nodes whose `id` is empty (837 of them in one run, object-literal properties across `scripts/` and `src/`). `impact` on a symbol whose node has an empty id walks upstream from every empty-id node at once, so an unrelated test-fixture property reports CRITICAL risk and 25 CLI flows, and `detect-changes` repeats that rating. Only `analyze --index-only --force --no-parse-cache` rebuilds them. In `scripts/graph-check.mjs`, after the refresh, count them with `cypher "MATCH (n) WHERE n.id = '' RETURN count(n)"`; when the count is above zero, run the forced rebuild once and count again, and fail naming the count when any remain, before `detect-changes` runs. Test with the runner stubbed as `scripts/graph-check.test.ts` does: a zero count goes straight to `detect-changes`, a non-zero count that the rebuild clears passes, one it does not clear fails, and a cypher failure fails with its exit code.

## 2. graph:check prints the steps of each affected flow on a HIGH or CRITICAL rating

A HIGH or CRITICAL `detect-changes` rating has to be traced flow by flow before a commit: the process ids found by label, then each step from the `STEP_IN_PROCESS` edges, several hand-written cypher queries per rating. When the `Risk level:` line of `detect-changes` reads `high` or `critical`, have `scripts/graph-check.mjs` query each affected flow's steps (`MATCH (s)-[r:CodeRelation]->(p:Process) WHERE r.type = 'STEP_IN_PROCESS' AND p.label = '<label>' RETURN r.step, s.id ORDER BY r.step`) and print each flow as its ordered step ids with their files, keeping the exit code `detect-changes` gave. Test with the runner stubbed: a low or medium rating prints no steps, a high one prints each listed flow's steps in order, and a flow the query does not find is named as not found.
