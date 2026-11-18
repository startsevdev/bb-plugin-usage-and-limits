// Codex reports cumulative token counts, including cached input. Shares use
// tokens, not invented API prices or subscription charges.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { UsageRecord } from "./claude-logs";
import type { Snapshot, WindowKey } from "./forecast";

interface State {
  offset: number;
  sessionId: string;
  project: string;
  model: string;
  agentId: string | null;
  previous: number | null;
  records: UsageRecord[];
  quotas: Array<Snapshot & { key: WindowKey; plan: string | null }>;
}
export class CodexLogIndex {
  private files = new Map<string, State>();
  private readonly root: string;
  constructor(root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")) { this.root = root; }

  private pending: Promise<unknown> = Promise.resolve();
  scan(since: number): Promise<UsageRecord[]> {
    const result = this.pending.then(() => this.scanFiles(since));
    this.pending = result.catch(() => undefined);
    return result;
  }

  /** Call after scan(); quota observations are read even when token info is null. */
  quotaHistory(key: WindowKey, plan: string | null): Snapshot[] {
    return [...this.files.values()].flatMap(state => state.quotas.filter(s =>
      s.key === key && (s.plan === null || s.plan.toLowerCase() === plan?.toLowerCase()),
    ));
  }

  private async scanFiles(since: number): Promise<UsageRecord[]> {
    const paths = new Set<string>();
    const visit = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.name.endsWith(".jsonl")) {
          const info = await stat(path).catch(() => null);
          if (info && info.mtimeMs >= since) paths.add(path);
        }
      }
    };
    await visit(this.root);
    for (const path of paths) {
      const size = (await stat(path).catch(() => null))?.size;
      if (size === undefined) continue;
      let state = this.files.get(path);
      if (!state || size < state.offset) {
        state = { offset: 0, sessionId: basename(path), project: "home folder", model: "Codex", agentId: null, previous: null, records: [], quotas: [] };
        this.files.set(path, state);
      }
      if (size <= state.offset) continue;
      let carry = Buffer.alloc(0);
      for await (const chunk of createReadStream(path, { start: state.offset, end: size - 1 })) {
        const buffer = Buffer.concat([carry, chunk as Buffer]);
        const end = buffer.lastIndexOf(10);
        if (end < 0) { carry = buffer; continue; }
        carry = buffer.subarray(end + 1);
        state.offset += end + 1;
        for (const line of buffer.toString("utf8", 0, end).split("\n")) {
          if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
          try {
            const entry = JSON.parse(line);
            const p = entry.payload;
            if (p?.type === "token_count" && p.rate_limits?.limit_id === "codex") {
              const at = Date.parse(entry.timestamp);
              for (const quota of [p.rate_limits.primary, p.rate_limits.secondary]) {
                const key = quota?.window_minutes === 10080 ? "7d" : quota?.window_minutes === 300 ? "5h" : null;
                if (key === null || !Number.isFinite(at) || !Number.isFinite(quota.used_percent)
                  || quota.used_percent < 0 || quota.used_percent > 100 || !Number.isFinite(quota.resets_at)) continue;
                state.quotas.push({ key, at, percent: quota.used_percent, resetsAt: quota.resets_at * 1000,
                  plan: typeof p.rate_limits.plan_type === "string" ? p.rate_limits.plan_type : null });
              }
            }
            if (entry.type === "session_meta") {
              state.sessionId = p.id ?? state.sessionId;
              state.project = basename(p.cwd ?? "") || "home folder";
              const sub = p.source?.subagent;
              const parent = sub?.thread_spawn?.parent_thread_id;
              if (parent) { state.agentId = state.sessionId; state.sessionId = parent; }
            } else if (entry.type === "turn_context") {
              state.model = p.model ?? state.model;
            } else if (p?.type === "token_count" && p.info?.total_token_usage) {
              const usage = p.info.total_token_usage;
              const total = usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
              if (!Number.isFinite(total) || total < 0) continue;
              // First event may include usage inherited from a fork. Only its
              // last request belongs here. Repeated totals consume nothing.
              const delta = state.previous === null || total < state.previous
                ? Math.min(total, p.info.last_token_usage?.total_tokens ?? 0)
                : total - state.previous;
              state.previous = total;
              const at = Date.parse(entry.timestamp);
              if (delta > 0 && Number.isFinite(at)) state.records.push({
                sessionId: state.sessionId, project: state.project, model: state.model,
                agentId: state.agentId, at, cost: delta,
              });
            }
          } catch { /* Ignore malformed lines; unfinished lines are re-read. */ }
        }
      }
    }
    const result: UsageRecord[] = [];
    for (const [path, state] of this.files) {
      if (!paths.has(path)) { this.files.delete(path); continue; }
      result.push(...state.records.filter(r => r.at >= since));
    }
    return result;
  }
}
