import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const nonnegative = z.number().finite().nonnegative();
const actionsForecastSchema = z.object({
  kind: z.enum(["ok", "runs_out", "exhausted", "unknown"]),
  minutes: z.number().nullable(),
});
const summarySchema = z.object({
  user: z.string(),
  timePeriod: z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) }),
  usageItems: z.array(z.object({
    product: z.string(), sku: z.string(), unitType: z.string(), grossAmount: nonnegative,
  })),
});
export const actionsReportSchema = z.object({
  forecast: actionsForecastSchema,
  account: z.string(), status: z.enum(["ok", "unavailable"]),
  usedPercent: z.number().nullable(), usedAmount: z.number().nullable(),
  includedAmount: z.number().nullable(), resetsAt: z.number().nullable(), checkedAt: z.number(), message: z.string().nullable(),
});
export type ActionsReport = z.infer<typeof actionsReportSchema>;

// GitHub's included COMPUTE allowance, not storage or a paid spending cap.
// https://docs.github.com/en/billing/reference/product-usage-included (2026-11-03)
const ALLOWANCE: Record<string, number> = { free: 12, pro: 18 };
const STANDARD_RUNNERS = new Set([
  "actions_linux", "actions_linux_arm", "actions_linux_slim",
  "actions_windows", "actions_windows_arm", "actions_macos",
]);
const STORAGE = new Set(["actions_storage", "actions_cache_storage", "actions_custom_image_storage"]);

/** Average compute usage since the start of the current UTC billing month. */
export function forecastActions(used: number, included: number, now: Date): z.infer<typeof actionsForecastSchema> {
  if (used >= included) return { kind: "exhausted", minutes: null };
  const startedAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const resetsAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsed = now.getTime() - startedAt;
  if (elapsed < 3_600_000) return { kind: "unknown", minutes: null };
  if (used === 0) return { kind: "ok", minutes: null };
  const remainingMs = (included - used) * elapsed / used;
  if (remainingMs >= resetsAt - now.getTime()) return { kind: "ok", minutes: null };
  return { kind: "runs_out", minutes: Math.max(1, Math.round(remainingMs / 60_000)) };
}

export function parseActionsBilling(value: unknown, plan: string, account: string, now = new Date()) {
  const summary = summarySchema.parse(value);
  const includedAmount = ALLOWANCE[plan];
  if (!includedAmount || summary.user.toLowerCase() !== account.toLowerCase()
    || summary.timePeriod.year !== now.getUTCFullYear() || summary.timePeriod.month !== now.getUTCMonth() + 1) {
    throw new Error("Unknown allowance or mismatched billing period/account");
  }
  let usedAmount = 0;
  for (const item of summary.usageItems) {
    const product = item.product.toLowerCase();
    if (product === "actions") {
      if (STORAGE.has(item.sku)) continue;
      // Larger runners do not draw from the personal Free/Pro allowance.
      if (!STANDARD_RUNNERS.has(item.sku)) throw new Error("Unsupported Actions compute SKU");
      if (item.unitType.toLowerCase() !== "minutes") throw new Error("Unexpected compute unit");
      usedAmount += item.grossAmount;
    } else if (product === "sandbox") {
      // Sandbox compute and memory share the same included compute allowance.
      if (item.sku !== "sandbox_linux" && item.sku !== "sandbox_memory") {
        throw new Error("Unsupported shared sandbox SKU");
      }
      usedAmount += item.grossAmount;
    }
  }
  return {
    forecast: forecastActions(usedAmount, includedAmount, now),
    usedAmount, includedAmount, usedPercent: 100 * usedAmount / includedAmount,
    // Metered compute resets on the first day of the next month at 00:00 UTC.
    // https://docs.github.com/en/billing/concepts/billing-cycles
    resetsAt: Date.UTC(summary.timePeriod.year, summary.timePeriod.month, 1),
  };
}

/** Credentials stay in gh's keychain; only billing data leaves this process. */
export function createActionsReader(account: string) {
  let cached: ActionsReport | null = null;
  let pending: Promise<ActionsReport> | null = null;
  async function api(path: string): Promise<unknown> {
    const { stdout } = await run("gh", ["api", "--hostname", "github.com", path], {
      timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }
  async function fetchReport(): Promise<ActionsReport> {
    const now = new Date();
    try {
      const [profileValue, summary] = await Promise.all([
        api("user"),
        api(`users/${encodeURIComponent(account)}/settings/billing/usage/summary?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`),
      ]);
      const profile = z.object({ login: z.string(), plan: z.object({ name: z.string() }) }).parse(profileValue);
      if (profile.login.toLowerCase() !== account.toLowerCase()) throw new Error("Wrong gh account");
      return { account, status: "ok", ...parseActionsBilling(summary, profile.plan.name, account, now), checkedAt: Date.now(), message: null };
    } catch {
      return { account, status: "unavailable", forecast: { kind: "unknown", minutes: null }, usedPercent: null, usedAmount: null, includedAmount: null, resetsAt: null,
        checkedAt: Date.now(), message: "GitHub Actions billing is unavailable for this account." };
    }
  }
  return () => {
    const now = new Date();
    if (cached && Date.now() - cached.checkedAt < 5 * 60_000
      && new Date(cached.checkedAt).getUTCMonth() === now.getUTCMonth()) return Promise.resolve(cached);
    pending ??= fetchReport().then(result => (cached = result)).finally(() => { pending = null; });
    return pending;
  };
}
