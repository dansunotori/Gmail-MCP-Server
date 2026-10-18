# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 16. Run the roadmap check before every commit

`scripts/check-roadmap.mjs` runs in CI and as the project's PreToolUse hook on Write and Edit, so a roadmap change made another way (a shell command, a merge, an editor) is checked only after it is pushed. `npm run roadmap:check:staged` checks the `ROADMAP.md` staged for commit and exits 1 on a finding, ready for a pre-commit hook, but agents on this machine may not change `.git/hooks` or `.git/config`, where the hook is installed, so adding it is the maintainer's step.

Done when:

- The repository's git pre-commit hook runs `npm run roadmap:check:staged` and stops on its exit 1, alongside any review that already runs at commit time.
- A commit with finished-work wording in a staged `ROADMAP.md` is refused locally, whatever made the change.