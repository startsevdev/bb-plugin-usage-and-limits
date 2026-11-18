import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const usageResult = z.object({
  accountId: z.string().min(1),
  rateLimitResetCredits: z.object({ availableCount: z.number().int().nonnegative() }),
});

export function manualResetCount(result: unknown, accountKey: unknown): number | null {
  const parsed = usageResult.safeParse(result);
  if (!parsed.success || accountKey !== "openai:chatgpt:" + parsed.data.accountId) return null;
  return parsed.data.rateLimitResetCredits.availableCount;
}

export async function readManualResets(accountKey: unknown): Promise<number | null> {
  if (typeof accountKey !== "string") return null;
  const local = join(homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex");
  const child = spawn(existsSync(local) ? local : "codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  return new Promise(resolve => {
    let done = false;
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(null), 10000);
    function finish(count: number | null) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      resolve(count);
    }
    child.once("error", () => finish(null));
    child.once("close", () => finish(null));
    child.stdin.on("error", () => finish(null));
    const send = (id: number, method: string, params: object) =>
      child.stdin.write(JSON.stringify({id, method, params}) + "\n");
    lines.on("line", line => {
      if (done) return;
      try {
        const response = JSON.parse(line);
        if (response.id === 1 && response.result) {
          send(2, "account/rateLimits/read", {});
        } else if (response.id === 2) {
          finish(manualResetCount(response.result, accountKey));
        } else if (response.id === 1) finish(null);
      } catch { finish(null); }
    });
    send(1, "initialize", {clientInfo:{name:"bb_limits",version:"0.1.2"}, capabilities:{experimentalApi:true}});
  });
}
