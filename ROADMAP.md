# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. graph:check prints the verdict, not the analyzer's progress

`npm run graph:check` passes the GitNexus analyzer's stdout through, so every `npm run verify` prints its banner, index statistics and JSON warning lines before the detect-changes summary that matters. Print the analyzer's output only when the refresh fails, and otherwise print the detect-changes summary alone, so `verify`'s output ends in the risk level and changed symbols. Test both cases with the stubbed runner in `scripts/graph-check.test.ts`.

## 2. reply_all without its unused result

The `reply_all` handler in `src/server.ts` assigns the result of `handleEmailAction("send", emailArgs)` to `result` and never reads it; the reply text is built from the recipients and subject. Drop the binding and await the call, keeping the result text that `src/server.test.ts` pins.
