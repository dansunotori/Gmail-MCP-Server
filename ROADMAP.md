# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 16. Run the roadmap check before every commit

`scripts/check-roadmap.mjs` runs in CI and as the project's PreToolUse hook on Write and Edit, so a roadmap change made another way (a shell command, a merge, an editor) is checked only after it is pushed. Nothing in this repository runs it at commit time, and agents on this machine may not change `.git/hooks` or `.git/config`, where a git pre-commit hook would be installed, so that step is the maintainer's.

Done when:

- A git pre-commit hook runs `npm run roadmap:check` on the staged `ROADMAP.md` and refuses the commit on a finding, without weakening any review that already runs at commit time.
- A commit with finished-work wording in a staged `ROADMAP.md` is refused locally, whatever made the change.