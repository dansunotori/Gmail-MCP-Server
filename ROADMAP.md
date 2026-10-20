# Roadmap

Work to implement, in order. Every change applies to the MCP tools and to the CLIs alike, the CLIs being required, not optional. An item leaves this file when its work is done.

## 1. reply_all without its unused result

The `reply_all` handler in `src/server.ts` assigns the result of `handleEmailAction("send", emailArgs)` to `result` and never reads it; the reply text is built from the recipients and subject. Drop the binding and await the call, keeping the result text that `src/server.test.ts` pins.
