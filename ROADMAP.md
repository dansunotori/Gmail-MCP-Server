# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

Do not renumber. Numbers are unique. Bug and code fixes precede coding and test machinery.

<!-- highest item number: 34 -->

## 36. One reader for the blob batch output that check-duplicates and check-roadmap parse

`writeStagedFiles` in `scripts/check-duplicates.mjs` and `headRoadmap` in `scripts/check-roadmap.mjs` each parse `git cat-file --batch` output by hand: the `<sha> <type> <size>` header, the content of that size and the `missing` answer. Move the parsing into one function in `scripts/script-support.mjs` that takes the output buffer and returns each object's type and content, or `missing`, in input order, and use it from both. Test it with a found blob holding multi-byte text, a missing object and two blobs in one output.

## 35. npm run verify resumes from a named step

A step of `npm run verify` that fails for a reason outside the change, such as the GitNexus worker failing to start in `graph:check` straight after the test suite, means running the full suite again, or the remaining steps one by one by hand. Make `scripts/verify.mjs` take `--from <step>`, running `STEPS` from that step to the end and refusing a step `STEPS` does not hold with the list of steps, and make its failure line name the command that resumes from the failed step (`npm run verify -- --from graph:check`). Describe it in the `npm run verify` sentence of `AGENTS.md`. Test that `--from` runs only that step and those after it, that an unknown step is refused with the steps listed, and that the failure line names the resume command.

## 37. Replace the hand-written htmlToText converter with a maintained HTML-to-text library

`htmlToText` in `src/message-body.ts` converts HTML to text by its own parsing, with its own entity table (`LATIN1_ENTITY_NAMES`), for the body over a stub and for download_email's txt and json. The project does not write its own parsers: the Markdown format of gmail-get-message uses the `turndown` library. Replace the converter with a maintained HTML-to-text library pinned in `dependencies`, keeping `htmlToText`'s signature so `selectBody` and its callers stay as they are, and dropping the entity table. Keep the existing `message-body.test.ts` expectations for the text a stubbed message delivers, adjusting only those that state the hand-written converter's own spacing rather than the content.

## 38. npm run field:trace names every surface that carries a result field

A request to confirm a result field across the server means checking by hand the MCP tool descriptions and output schemas in `src/tools.ts`, the CLI `--help` text in `src/cli/commands.ts`, the README command table, the code that sets the field and the tests that assert it. Add `scripts/field-trace.mjs`, run as `npm run field:trace -- <field>`, which reads the tracked files and prints, for that field, each MCP tool whose description or output schema names it, each CLI whose help names it, whether the README command table names it, each source line outside tests that sets it, and each test file that asserts it, and exits non-zero with the missing surfaces named when a tool or CLI that `src/cli/result-field-docs.test.ts` maps the field to does not document it. Describe it in `AGENTS.md`. Test the output for a field every surface carries and the failure for one a CLI's help leaves out.
