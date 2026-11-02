# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. graph:check prints the steps of each affected flow on a HIGH or CRITICAL rating

A HIGH or CRITICAL `detect-changes` rating has to be traced flow by flow before a commit: the process ids found by label, then each step from the `STEP_IN_PROCESS` edges, several hand-written cypher queries per rating. When the `Risk level:` line of `detect-changes` reads `high` or `critical`, have `scripts/graph-check.mjs` query each affected flow's steps (`MATCH (s)-[r:CodeRelation]->(p:Process) WHERE r.type = 'STEP_IN_PROCESS' AND p.label = '<label>' RETURN r.step, s.id ORDER BY r.step`) and print each flow as its ordered step ids with their files, keeping the exit code `detect-changes` gave. Test with the runner stubbed: a low or medium rating prints no steps, a high one prints each listed flow's steps in order, and a flow the query does not find is named as not found.
