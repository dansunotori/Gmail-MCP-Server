# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

Do not renumber. Numbers are unique. Bug and code fixes precede coding and test machinery.

<!-- highest item number: 34 -->

## 36. One reader for the blob batch output that check-duplicates and check-roadmap parse

`writeStagedFiles` in `scripts/check-duplicates.mjs` and `headRoadmap` in `scripts/check-roadmap.mjs` each parse `git cat-file --batch` output by hand: the `<sha> <type> <size>` header, the content of that size and the `missing` answer. Move the parsing into one function in `scripts/script-support.mjs` that takes the output buffer and returns each object's type and content, or `missing`, in input order, and use it from both. Test it with a found blob holding multi-byte text, a missing object and two blobs in one output.

## 35. npm run verify resumes from a named step

A step of `npm run verify` that fails for a reason outside the change, such as the GitNexus worker failing to start in `graph:check` straight after the test suite, means running the full suite again, or the remaining steps one by one by hand. Make `scripts/verify.mjs` take `--from <step>`, running `STEPS` from that step to the end and refusing a step `STEPS` does not hold with the list of steps, and make its failure line name the command that resumes from the failed step (`npm run verify -- --from graph:check`). Describe it in the `npm run verify` sentence of `AGENTS.md`. Test that `--from` runs only that step and those after it, that an unknown step is refused with the steps listed, and that the failure line names the resume command.
