import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexLogIndex } from "../lib/codex-logs.ts";

const line = (type: string, payload: unknown) => JSON.stringify({ type, payload, timestamp: "2026-10-30T10:00:00Z" }) + "\n";
const tokens = (total: number, last: number) => line("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { total_tokens: last } } });

test("cumulative usage, duplicates, fork baseline, model changes, incremental and partial lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-codex-test-"));
  try {
    const path = join(root, "rollout.jsonl");
    await writeFile(path, line("session_meta", { id: "fork", cwd: "/project/тест" }) + line("turn_context", { model: "gpt-test" }) + tokens(1000, 100) + tokens(1000, 100) + tokens(1200, 200));
    const index = new CodexLogIndex(root);
    const first = await index.scan(0);
    assert.deepEqual(first.map(r => r.cost), [100, 200]);
    assert.equal(first[0].project, "тест");
    assert.equal(first[0].sessionId, "fork");
    assert.deepEqual(await index.scan(0), first);
    assert.deepEqual(await Promise.all([index.scan(0), index.scan(0)]), [first, first]);
    const partial = tokens(1500, 300);
    await appendFile(path, line("turn_context", { model: "gpt-new" }) + partial.slice(0, -1));
    assert.deepEqual(await index.scan(0), first);
    await appendFile(path, "\n");
    const updated = await index.scan(0);
    assert.deepEqual(updated.map(r => r.cost), [100, 200, 300]);
    assert.equal(updated[2].model, "gpt-new");
    assert.equal((await index.scan(Date.parse("2026-10-31"))).length, 0);
    await writeFile(path, line("session_meta", { id: "new" }) + tokens(40, 40));
    assert.deepEqual((await index.scan(0)).map(r => r.cost), [40]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("subagents belong to parent and missing directories are empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-codex-test-"));
  try {
    await writeFile(join(root, "agent.jsonl"), line("session_meta", { id: "child", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } }) + tokens(50, 50));
    const [record] = await new CodexLogIndex(root).scan(0);
    assert.equal(record.sessionId, "parent");
    assert.equal(record.agentId, "child");
    assert.deepEqual(await new CodexLogIndex(join(root, "absent")).scan(0), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("quota history reads both rate windows even with null token info, survives reindexing and excludes other plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-codex-quota-test-"));
  const quota = (plan: string | null, limitId = "codex", percent = 42) => line("event_msg", {
    type: "token_count", info: null,
    rate_limits: { limit_id: limitId, limit_name: null, plan_type: plan,
      primary: { used_percent: percent, window_minutes: 10080, resets_at: 1793959200 },
      secondary: { used_percent: 10, window_minutes: 300, resets_at: 1793361600 },
      credits: { has_credits: false, unlimited: false, balance: "0" }, individual_limit: null,
      spend_control_reached: null, rate_limit_reached_type: null },
  });
  try {
    await writeFile(join(root, "quota.jsonl"), quota("prolite") + quota("pro") + quota("prolite", "other") + quota("prolite", "codex", -1));
    const index = new CodexLogIndex(root);
    assert.deepEqual(await index.scan(0), []);
    assert.deepEqual(index.quotaHistory("7d", "Prolite").map(s => s.percent), [42]);
    assert.deepEqual(index.quotaHistory("5h", "Prolite").map(s => s.percent), [10, 10]);
    const fresh = new CodexLogIndex(root);
    await fresh.scan(0);
    assert.deepEqual(fresh.quotaHistory("7d", "Prolite"), index.quotaHistory("7d", "Prolite"));
    await index.scan(0);
    assert.equal(index.quotaHistory("7d", "Prolite").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
