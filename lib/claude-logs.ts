// Reads Claude Code session logs (~/.claude/projects/**/*.jsonl) and turns
// every assistant message into a token-weighted usage record. Files are read
// incrementally: each scan only parses bytes appended since the last one.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface UsageRecord {
  /** Claude Code session the message belongs to (parent session for subagents). */
  sessionId: string;
  /** Subagent id when the message came from a subagent log. */
  agentId: string | null;
  /** Readable name of the Claude Code project folder. */
  project: string;
  model: string;
  at: number;
  /** Relative cost in USD at API prices — only used for shares. */
  cost: number;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface FileState {
  size: number;
  offset: number;
  /** Message id → record; Claude writes one line per content block. */
  records: Map<string, UsageRecord>;
}

export class ClaudeLogIndex {
  private readonly root: string;
  constructor(root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")) { this.root = root; }
  private readonly files = new Map<string, FileState>();

  /** Scans logs touched since `since` and returns every record newer than it. */
  async scan(since: number): Promise<UsageRecord[]> {
    const paths = await this.recentLogs(since);
    for (const path of paths) await this.readFile(path);
    const out: UsageRecord[] = [];
    for (const [path, state] of this.files) {
      if (!paths.has(path)) {
        this.files.delete(path);
        continue;
      }
      for (const record of state.records.values()) {
        if (record.at >= since) out.push(record);
      }
    }
    return out;
  }

  private async recentLogs(since: number): Promise<Set<string>> {
    const found = new Set<string>();
    const visit = async (dir: string, depth: number) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          // <project>/<session>/subagents/agent-*.jsonl is the deepest layout.
          if (depth < 3) await visit(path, depth + 1);
        } else if (entry.name.endsWith(".jsonl")) {
          try {
            if ((await stat(path)).mtimeMs >= since) found.add(path);
          } catch {
            // Deleted between readdir and stat.
          }
        }
      }
    };
    await visit(this.root, 0);
    return found;
  }

  private async readFile(path: string): Promise<void> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    let state = this.files.get(path);
    if (state === undefined || size < state.size) {
      state = { size: 0, offset: 0, records: new Map() };
      this.files.set(path, state);
    }
    if (size === state.offset) return;

    const isSubagent = basename(dirname(path)) === "subagents";
    const sessionId = isSubagent
      ? basename(dirname(dirname(path)))
      : basename(path, ".jsonl");
    const agentId = isSubagent ? basename(path, ".jsonl") : null;
    const project = projectName(
      basename(isSubagent ? dirname(dirname(dirname(path))) : dirname(path)),
    );

    const stream = createReadStream(path, { start: state.offset, end: size - 1 });
    // Split on raw bytes so a multi-byte character cut by a chunk boundary
    // never shifts the byte offset.
    let carry = Buffer.alloc(0);
    let consumed = state.offset;
    for await (const chunk of stream) {
      const buffer = Buffer.concat([carry, chunk as Buffer]);
      const end = buffer.lastIndexOf(10);
      if (end === -1) {
        carry = buffer;
        continue;
      }
      carry = buffer.subarray(end + 1);
      consumed += end + 1;
      for (const line of buffer.toString("utf8", 0, end).split("\n")) {
        if (!line.includes('"type":"assistant"')) continue;
        this.parseLine(line, { sessionId, agentId, project }, state.records);
      }
    }
    // A trailing partial line is re-read on the next scan.
    state.offset = consumed;
    state.size = size;
  }

  private parseLine(
    line: string,
    source: Pick<UsageRecord, "sessionId" | "agentId" | "project">,
    records: Map<string, UsageRecord>,
  ): void {
    let entry: {
      type?: string;
      timestamp?: string;
      message?: { id?: string; model?: string; usage?: RawUsage };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const message = entry.message;
    if (entry.type !== "assistant" || message?.usage === undefined) return;
    const model = message.model ?? "";
    if (model === "" || model.startsWith("<")) return;
    const at = Date.parse(entry.timestamp ?? "");
    if (Number.isNaN(at)) return;
    records.set(message.id ?? `${at}`, {
      ...source,
      model,
      at,
      cost: (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0)
        + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ??
          ((message.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (message.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0))),
    });
  }
}

/** "-Users-me-Projects-example" → "example". */
function projectName(folder: string): string {
  const marker = "-Projects-";
  const index = folder.lastIndexOf(marker);
  const name = index === -1 ? folder.replace(/^-+/, "") : folder.slice(index + marker.length);
  return name.split("--claude-worktrees-")[0] || "home folder";
}
