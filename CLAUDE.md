# CLAUDE.md - Gmail MCP Server

## Branch Workflow
Single branch: work lands on `main` directly, and CI must pass after every push. See `.claude/skills/pr-review-sop/SKILL.md` for full SOP.

## PR & Issue Review
Mandatory security audit on every PR before presenting. See `.claude/skills/pr-review-sop/SKILL.md`.

## Roadmap
`ROADMAP.md` lists work still to do; an item leaves it once implemented. Prompts written for this server elsewhere (`gmail-*.md`) are added with `node scripts/import-prompts.mjs <prompts-dir>`, which skips any prompt imported before.

## No Changelogs, History, Reports or Self-Praise in the Repository
Every file and code comment describes the code as it is now. Git history records how it got there; chat and PR comments carry reports.
- No changelogs: no "added", "fixed", "new", "now", "updated" or version notes, and no CHANGELOG file.
- No history: no "previously", "used to", "no longer", "originally", "ported from", "kept for compatibility", dates of changes, or issue, PR or commit references describing past work. A comment never names a past bug; it states the constraint the code keeps.
- No reports: no live-check results, test counts, audit findings or "verified" or "done" notes. A finished roadmap item is deleted, never marked done. Results go to the user in chat, or to a PR comment.
- No self-praise: no "powerful", "robust", "comprehensive", "seamless", "enhanced" or similar.
- When behaviour changes, rewrite the passage that describes it so it states the new behaviour; never append a note about the change. A roadmap item or prompt that asks for a "changed" note is satisfied by describing the current behaviour.
- Commit messages are the place for what changed and why.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Gmail-MCP-Server**.

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/Gmail-MCP-Server/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Gmail-MCP-Server/clusters` | All functional areas |
| `gitnexus://repo/Gmail-MCP-Server/processes` | All execution flows |
| `gitnexus://repo/Gmail-MCP-Server/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

GitNexus generates `.claude/skills/gitnexus/` locally. The directory is intentionally untracked; when it is absent, use installed user-level GitNexus skills or the CLI and MCP commands above.
