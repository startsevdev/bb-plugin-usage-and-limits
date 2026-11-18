import assert from "node:assert/strict";
import { test } from "node:test";
import { manualResetCount } from "../lib/manual-resets.ts";
import { connectedProviders } from "../lib/connected.ts";

test("manual resets require a matching account and an explicit available count", () => {
  const result = (count: number) => ({ accountId:"test",rateLimitResetCredits:{availableCount:count,credits:[]} });
  assert.equal(manualResetCount(result(2),"openai:chatgpt:test"),2);
  assert.equal(manualResetCount(result(0),"openai:chatgpt:test"),0);
  assert.equal(manualResetCount(result(2),"openai:chatgpt:other"),null);
  assert.equal(manualResetCount({accountId:"test",resetsAt:123},"openai:chatgpt:test"),null);
});
test("provider choices reflect accounts with usage, independent of registration order", () => {
  const ok = {status:"ok"};
  assert.deepEqual(connectedProviders({codex:ok,"claude-code":{status:"unauthenticated"}}),["codex"]);
  assert.deepEqual(connectedProviders({"claude-code":ok}),["claude-code"]);
  assert.deepEqual(connectedProviders({"claude-code":ok,codex:ok}),["codex","claude-code"]);
  assert.deepEqual(connectedProviders({}),[]);
});
