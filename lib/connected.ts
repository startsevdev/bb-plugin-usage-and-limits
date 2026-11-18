export type UsageProvider = "codex" | "claude-code";

export function connectedProviders(accounts: Record<string, {status: string}>): UsageProvider[] {
  const supported: UsageProvider[] = ["codex", "claude-code"];
  return supported.filter(key => accounts[key]?.status === "ok");
}
