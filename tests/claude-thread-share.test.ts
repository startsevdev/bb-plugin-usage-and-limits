import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeLogIndex } from "../lib/claude-logs.ts";

test("Claude thread shares count cache tokens once and deduplicate message updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-claude-test-"));
  try {
    const dir = join(root, "example");
    await mkdir(dir);
    const line = JSON.stringify({type:"assistant", timestamp:new Date().toISOString(),
      message:{id:"m1", model:"test-model", usage:{input_tokens:7, output_tokens:3,
        cache_creation_input_tokens:5, cache_creation:{ephemeral_5m_input_tokens:5}, cache_read_input_tokens:11}}});
    await writeFile(join(dir, "session.jsonl"), line + "\n" + line + "\n");
    const records = await new ClaudeLogIndex(root).scan(0);
    assert.deepEqual(records.map(r => [r.sessionId, r.cost]), [["session", 26]]);
  } finally { await rm(root, { recursive:true, force:true }); }
});
