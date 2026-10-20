# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. commitContents checked against git itself

`commitContents` in `scripts/commit-hook.mjs` classifies a git commit's arguments as recording the index, the working copy or a mix, from a hand-written option list, and each gap in that list (an option with an attached value, `--no-all`, an abbreviation, `--fixup=reword:`) was found by review rather than by a test. Add a test that builds a fixture repository with a staged change and a different working-copy change in two tracked files, runs `git commit --dry-run --porcelain` with each argument list from a table (plain, `-a`, `-am x`, `-a --no-all`, `-uall`, `-Skey`, `--amend`, `--only`, `-i`, a pathspec, `--fixup=reword:HEAD`, `--pathspec-from-fil=x`, …), reads from git's output which copy of each file it would record, and asserts that `commitContents` returns `index` exactly when git records the staged copy alone, `working` exactly when it records the working copy of every tracked file, and `select` otherwise. A new git option then fails the test with the arguments named, before review.

## 2. A quiet mode for npm run ci:watch

`npm run ci:watch` streams `gh run watch` and reprints the whole job table every ten seconds until the run ends, so one watch fills the output with dozens of identical tables. Add `--quiet` to `scripts/ci-watch.mjs`, which waits the same way but prints only the closing verdict line (`CI <url> passed for <sha>`), or on failure the failed steps and the commands that read or rerun them, as the full mode prints them, and make it what `scripts/land.mjs` runs. Test that the quiet mode prints one line for a pass and the failed steps for a failure, with `gh` stubbed.

## 3. graph:check prints the verdict, not the analyzer's progress

`npm run graph:check` passes the GitNexus analyzer's stdout through, so every `npm run verify` prints its banner, index statistics and JSON warning lines before the detect-changes summary that matters. Print the analyzer's output only when the refresh fails, and otherwise print the detect-changes summary alone, so `verify`'s output ends in the risk level and changed symbols. Test both cases with the stubbed runner in `scripts/graph-check.test.ts`.

## 4. reply_all without its unused result

The `reply_all` handler in `src/server.ts` assigns the result of `handleEmailAction("send", emailArgs)` to `result` and never reads it; the reply text is built from the recipients and subject. Drop the binding and await the call, keeping the result text that `src/server.test.ts` pins.
