// bb-plugin-limits — "Usage & Limits".
//
// Combines real Codex subscription windows with local session logs.
// Thread shares use observed tokens.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ClaudeLogIndex, type UsageRecord } from "./lib/claude-logs";
import { CodexLogIndex } from "./lib/codex-logs";
import { actionsReportSchema, createActionsReader } from "./lib/github-actions";
import { humanizeCron, modelLabel, count } from "./lib/format";
import { forecastLimit, WINDOW_MS, PACE, type Snapshot } from "./lib/forecast";

import { connectedProviders } from "./lib/connected";
import { readManualResets } from "./lib/manual-resets";

const providerKey = z.enum(["codex", "claude-code"]);
export type ProviderKey = z.infer<typeof providerKey>;
const windowKey = z.enum(["5h", "7d"]);
export type WindowKey = z.infer<typeof windowKey>;

const limitWindowSchema = z.object({
  key: windowKey,
  usedPercent: z.number(),
  resetsAt: z.number(),
});
type LimitWindow = z.infer<typeof limitWindowSchema>;
const forecastSchema = z.object({
  kind: z.enum(["ok", "runs_out", "exhausted", "unknown"]),
  minutes: z.number().nullable(),
});

const reportSchema = z.object({
  manualResets: z.number().int().nonnegative().nullable(),
  provider: providerKey,
  shareBasis: z.enum(["cost", "tokens"]),
  plan: z.string().nullable(),
  /** Each window carries its own forecast. */
  windows: z.array(limitWindowSchema.extend({ forecast: forecastSchema })),
  byType: z.array(
    z.object({ key: z.string(), label: z.string(), share: z.number() }),
  ),
  threads: z.array(
    z.object({
      key: z.string(),
      threadId: z.string().nullable(),
      title: z.string(),
      details: z.string(),
      share: z.number(),
    }),
  ),
  rest: z.object({ count: z.number(), share: z.number() }),
  /** When the real percentages were last confirmed by OpenAI. */
  limitsCheckedAt: z.number().nullable(),
  generatedAt: z.number(),
});
export type Report = z.infer<typeof reportSchema>;

export const rpcContract = defineRpcContract({
  connected_providers: { input: z.object({}), output: z.array(providerKey) },
  github_actions: { input: z.object({}), output: actionsReportSchema },
  limits_report: {
    input: z.object({ window: windowKey, provider: providerKey.default("codex") }),
    output: reportSchema,
  },
});

/** Threads are listed down to this share as the card rounds it (1% included). */
const MIN_THREAD_PERCENT = 1;
const LIMITS_TTL = 5 * 60_000;

interface ThreadInfo {
  id: string;
  title: string;
  kind: string;
  bucket: "own" | "routine";
  updatedAt: number;
  sessions: string[];
}

interface Routine {
  id: string;
  name: string;
  /** "Routine, daily 06:05". */
  label: string;
}

const automationSchema = z.object({
  automations: z.array(
    z.object({
      automation: z
        .object({
          id: z.string(),
          name: z.string(),
          projectId: z.string(),
          lastRunAt: z.number().nullable().optional(),
          trigger: z
            .object({ triggerType: z.string(), cron: z.string().optional() })
            .passthrough(),
        })
        .passthrough(),
    }),
  ),
});
const runsSchema = z.object({
  runs: z.array(z.object({ threadId: z.string().nullable() }).passthrough()),
});
const snapshotStoreSchema = z.object({
  plan: z.string().nullable(),
  windows: z.object({ "5h": z.array(z.object({ at: z.number().finite(), percent: z.number().min(0).max(100), resetsAt: z.number().finite() })),
    "7d": z.array(z.object({ at: z.number().finite(), percent: z.number().min(0).max(100), resetsAt: z.number().finite() })) }),
});

function createProviderReports(bb: BbPluginApi, provider: ProviderKey) {
  const label = provider === "claude-code" ? "Claude Code" : "Codex";
  const logs = provider === "claude-code" ? new ClaudeLogIndex() : new CodexLogIndex();
  const threads = new Map<string, ThreadInfo>();
  /** Codex session id → BB thread id. */
  const sessionOwner = new Map<string, string>();
  /** BB thread id → the routine that started it. */
  let routineLabels = new Map<string, Routine>();
  let routinesFetchedAt = 0;
  const snapshots: Record<WindowKey, Snapshot[]> = { "5h": [], "7d": [] };
  let snapshotsPlan: string | null | undefined;
  let snapshotWork = Promise.resolve();

  // Avoid frequent provider checks, so the real
  // percentages are fetched at most every LIMITS_TTL and the last good answer
  // is kept for when a check is refused.
  let limitsCache: { manualResets?: number | null; plan: string | null; windows: LimitWindow[]; at: number } | null = null;
  let limitsInFlight: Promise<void> | null = null;
  /** Failed checks also wait LIMITS_TTL, so a refusal is never retried in a burst. */
  let limitsAttemptAt = 0;

  async function fetchLimits(): Promise<void> {
    const usage = await bb.sdk.system.usageLimits({ providerId: provider });
    const account = usage[provider];
    if (account === undefined || account.status !== "ok") {
      bb.log.warn(`${provider} usage check refused: ${account?.status ?? "missing"}`);
      return;
    }
    const windows: LimitWindow[] = [];
    for (const window of account.windows) {
      // Model-specific weekly windows (e.g. Fable) stay in BB's own card.
      if ("model" in window && window.model) continue;
      const key =
        window.kind === "five-hour" || /5\s*(h|hour)/i.test(window.label) ? "5h" : window.kind === "weekly" || /week|7\s*d/i.test(window.label) ? "7d" : null;
      if (key === null || window.resetsAt === null || !Number.isFinite(Date.parse(window.resetsAt))) continue;
      windows.push({
        key,
        usedPercent: window.usedPercent,
        resetsAt: Date.parse(window.resetsAt),
      });
    }
    limitsCache = { manualResets: provider === "codex" ? await readManualResets(account.accountKey) : null, plan: account.planLabel, windows, at: Date.now() };
    // Survives plugin reloads, so a refused check right after one still has data.
    await bb.storage.kv.set(`limits:${provider}`, limitsCache);
  }

  async function readLimits() {
    limitsCache ??= (await bb.storage.kv.get<NonNullable<typeof limitsCache>>(`limits:${provider}`)) ?? null;
    const fresh = limitsCache !== null && limitsCache.manualResets !== undefined && Date.now() - limitsCache.at < LIMITS_TTL;
    if (!fresh && Date.now() - limitsAttemptAt >= LIMITS_TTL) {
      limitsAttemptAt = Date.now();
      limitsInFlight ??= fetchLimits()
        .catch((cause: unknown) => bb.log.warn(`usage check failed: ${String(cause)}`))
        .finally(() => {
          limitsInFlight = null;
        });
    }
    if (limitsInFlight !== null) await limitsInFlight;
    if (limitsCache === null) return { plan: null, windows: [] as LimitWindow[], checkedAt: null };
    const now = Date.now();
    const windows = limitsCache.windows.filter(w => w.resetsAt > now);
    return { plan: limitsCache.plan, windows, checkedAt: limitsCache.at };
  }

  function remember(windows: LimitWindow[], at: number | null, plan: string | null) {
    const work = snapshotWork.then(async () => {
      if (snapshotsPlan !== plan) {
        const saved = snapshotStoreSchema.safeParse(await bb.storage.kv.get(`snapshots:${provider}`));
        snapshots["5h"] = saved.success && saved.data.plan === plan ? saved.data.windows["5h"] : [];
        snapshots["7d"] = saved.success && saved.data.plan === plan ? saved.data.windows["7d"] : [];
        snapshotsPlan = plan;
      }
      if (at === null) return;
      let changed = false;
      for (const window of windows) {
        // Never turn an expired cache's synthetic zero into an observation.
        if (at < window.resetsAt - WINDOW_MS[window.key] - 60_000 || at >= window.resetsAt) continue;
        const list = snapshots[window.key];
        const last = list.at(-1);
        if (last && at <= last.at) continue; // Re-opening the card is not a new provider reading.
        if (window.key === "5h" && last && Math.abs(window.resetsAt - last.resetsAt) > 60_000) list.length = 0;
        list.push({ at, percent: window.usedPercent, resetsAt: window.resetsAt });
        const keep = window.key === "7d" ? 8 * 24 * 3_600_000 : PACE[window.key].lookback;
        // Keep one anchor before the boundary, for interpolation.
        while (list.length > 1 && list[1]!.at < Date.now() - keep) list.shift();
        changed = true;
      }
      if (changed) await bb.storage.kv.set(`snapshots:${provider}`, { plan, windows: snapshots });
    });
    snapshotWork = work.catch(cause => bb.log.warn(`snapshot history failed: ${String(cause)}`));
    return snapshotWork;
  }

  async function refreshThreads(since: number) {
    const lists = await Promise.all([
      bb.sdk.threads.list({ includeHidden: true, limit: 5000 }),
      bb.sdk.threads.list({ includeHidden: true, archived: true, limit: 5000 }),
    ]);
    for (const thread of lists.flat()) {
      if (thread.providerId !== provider || thread.updatedAt < since) continue;
      const known = threads.get(thread.id);
      const isRoutine = thread.originPluginId === "automations";
      const kind = isRoutine
        ? "Routine"
        : thread.originPluginId === "side-chat"
          ? "Side chat"
          : thread.originKind === "fork"
            ? "Fork"
            : thread.parentThreadId !== null
              ? "Child thread"
              : "Manual";
      const info: ThreadInfo = {
        id: thread.id,
        title: thread.title ?? thread.titleFallback ?? "Untitled",
        kind,
        bucket: isRoutine ? "routine" : "own",
        updatedAt: thread.updatedAt,
        sessions: known?.sessions ?? [],
      };
      if (known === undefined || known.updatedAt !== thread.updatedAt) {
        const rows = await bb.sdk.threads.events.list({
          threadId: thread.id,
          types: ["thread/identity"],
          order: "desc",
          limit: "50",
        });
        const sessions = new Set<string>();
        for (const row of rows) {
          const id = (row.data as { providerThreadId?: unknown }).providerThreadId;
          if (typeof id === "string") sessions.add(id);
        }
        info.sessions = [...sessions];
      }
      threads.set(thread.id, info);
      for (const session of info.sessions) sessionOwner.set(session, thread.id);
    }
  }

  async function refreshRoutines(since: number) {
    if (Date.now() - routinesFetchedAt < 10 * 60_000) return;
    const overview = await bb.sdk.plugins.callRpc({
      pluginId: "automations",
      method: "automations_overview",
      input: null,
      outputSchema: automationSchema,
    });
    const labels = new Map<string, Routine>();
    for (const { automation } of overview.automations) {
      if ((automation.lastRunAt ?? 0) < since) continue;
      const trigger = automation.trigger;
      const label =
        trigger.triggerType === "once"
          ? "Routine, one-off"
          : `Routine, ${humanizeCron(trigger.cron ?? "")}`;
      const { runs } = await bb.sdk.plugins.callRpc({
        pluginId: "automations",
        method: "automations_runs",
        input: { projectId: automation.projectId, automationId: automation.id, limit: 50 },
        outputSchema: runsSchema,
      });
      const routine = { id: automation.id, name: automation.name, label };
      for (const run of runs) if (run.threadId !== null) labels.set(run.threadId, routine);
    }
    routineLabels = labels;
    routinesFetchedAt = Date.now();
  }

  async function buildReport(key: WindowKey, minPercent = MIN_THREAD_PERCENT): Promise<Report> {
    const now = Date.now();
    const limits = await readLimits();
    await remember(limits.windows, limits.checkedAt, limits.plan);
    const selected = limits.windows.find((w) => w.key === key);
    const since = (selected?.resetsAt ?? now) - WINDOW_MS[key];
    // Include an extra day to anchor interpolation at the rolling week boundary.
    const weekSince = now - WINDOW_MS["7d"] - 24 * 3_600_000;

    const records = await logs.scan(Math.min(since, weekSince));
    await refreshThreads(since);
    await refreshRoutines(since).catch((cause: unknown) => {
      bb.log.warn(`automations lookup failed: ${String(cause)}`);
    });

    const inWindow = records.filter((r) => r.at >= since);
    const total = inWindow.reduce((sum, r) => sum + r.cost, 0);
    const buckets = { own: 0, routine: 0, subagents: 0, outside: 0 };
    interface Row {
      key: string;
      threadId: string | null;
      title: string;
      kind: string;
      cost: number;
      models: Map<string, number>;
      agents: Set<string>;
      runs: Set<string>;
      lastAt: number;
    }
    const rows = new Map<string, Row>();
    for (const record of inWindow) {
      const threadId = sessionOwner.get(record.sessionId) ?? null;
      const thread = threadId === null ? undefined : threads.get(threadId);
      if (record.agentId !== null) buckets.subagents += record.cost;
      else if (thread === undefined) buckets.outside += record.cost;
      else buckets[thread.bucket] += record.cost;

      // Every run of a routine is its own thread; one row per routine shows
      // its real weight.
      const routine = thread === undefined ? undefined : routineLabels.get(thread.id);
      const rowKey = routine
        ? `routine:${routine.id}`
        : (thread?.id ?? `outside:${record.project}`);
      let row = rows.get(rowKey);
      if (row === undefined) {
        row = {
          key: rowKey,
          threadId: thread?.id ?? null,
          title: routine?.name ?? thread?.title ?? `${label} outside BB · ${record.project}`,
          kind:
            thread === undefined
              ? "Outside BB"
              : thread.bucket === "routine"
                ? (routine?.label ?? "Routine")
                : thread.kind,
          cost: 0,
          models: new Map(),
          agents: new Set(),
          runs: new Set(),
          lastAt: 0,
        };
        rows.set(rowKey, row);
      }
      row.cost += record.cost;
      if (thread !== undefined) {
        row.runs.add(thread.id);
        // Clicking a routine row opens its latest run.
        if (record.at > row.lastAt) {
          row.lastAt = record.at;
          row.threadId = thread.id;
        }
      }
      row.models.set(record.model, (row.models.get(record.model) ?? 0) + record.cost);
      if (record.agentId !== null) row.agents.add(`${record.sessionId}/${record.agentId}`);
    }

    const share = (cost: number) => (total > 0 ? cost / total : 0);
    const byType: Report["byType"] = [
      { key: "own", label: "Your threads", share: share(buckets.own) },
      { key: "routine", label: "Routines", share: share(buckets.routine) },
      { key: "subagents", label: "Subagents", share: share(buckets.subagents) },
      { key: "outside", label: "Outside BB", share: share(buckets.outside) },
    ].filter((entry) => entry.key !== "outside" || entry.share >= 0.005);

    const sorted = [...rows.values()].sort((a, b) => b.cost - a.cost);
    const cut = sorted.findIndex((row) => Math.round(share(row.cost) * 100) < minPercent);
    const shown = cut === -1 ? sorted : sorted.slice(0, cut);
    const rest = cut === -1 ? [] : sorted.slice(cut);
    return {
      provider,
      manualResets: limitsCache && now - limitsCache.at < LIMITS_TTL ? limitsCache.manualResets ?? null : null,
      shareBasis: "tokens",
      plan: limits.plan,
      windows: limits.windows.map((w) => ({ ...w, forecast: forecastLimit(w,
        w.key === "7d" && logs instanceof CodexLogIndex ? [...snapshots[w.key], ...logs.quotaHistory(w.key, limits.plan)] : snapshots[w.key], records) })),
      byType,
      threads: shown.map((row) => {
        const model = [...row.models].sort((a, b) => b[1] - a[1])[0]?.[0];
        const details: Array<string | null> = [row.kind];
        if (row.key.startsWith("routine:") && row.runs.size > 1) {
          details.push(count(row.runs.size, "run"));
        }
        details.push(model ? modelLabel(model) : null);
        if (row.agents.size > 0) {
          details.push(count(row.agents.size, "subagent"));
        }
        return {
          key: row.key,
          threadId: row.threadId,
          title: row.title,
          details: details.filter((part) => part !== null).join(" · "),
          share: share(row.cost),
        };
      }),
      limitsCheckedAt: limits.checkedAt,
      rest: { count: rest.length, share: share(rest.reduce((s, r) => s + r.cost, 0)) },
      generatedAt: now,
    };
  }

  // Concurrent opens share one in-flight build per window.
  const inFlight = new Map<WindowKey, Promise<Report>>();
  function report(key: WindowKey): Promise<Report> {
    let pending = inFlight.get(key);
    if (pending === undefined) {
      pending = buildReport(key).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  }

  // Snapshots of the real 5h percentage feed the forecast even while the
  // card is closed.
  if (provider === "codex") bb.background.service(`limit-snapshots-${provider}`, {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const { windows, checkedAt, plan } = await readLimits();
          await remember(windows, checkedAt, plan);
        } catch (cause) {
          bb.log.warn(`usage snapshot failed: ${String(cause)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, LIMITS_TTL);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  return { report, buildReport };
}

export default async function plugin(bb: BbPluginApi) {
  const readActions = createActionsReader("startsevdev");
  const providers = {
    codex: createProviderReports(bb, "codex"),
    "claude-code": createProviderReports(bb, "claude-code"),
  };
  bb.rpc.register(rpcContract, {
    connected_providers: async () => connectedProviders(await bb.sdk.system.usageLimits()),
    github_actions: () => readActions(),
    limits_report: ({ window, provider }) => providers[provider].report(window),
  });

  bb.cli.register({
    name: "where-the-limit-goes",
    summary: "Show remaining quota, resets and thread usage",
    commands: [
      {
        name: "report",
        summary: "Print the usage breakdown",
        usage: "bb where-the-limit-goes report [5h|7d] [--provider codex|claude-code] [--all] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const all = argv.includes("--all");
      const providerIndex = argv.indexOf("--provider");
      const selectedProvider = providerKey.safeParse(providerIndex < 0 ? "codex" : argv[providerIndex + 1]);
      if (!selectedProvider.success) return { exitCode: 1, stderr: "Choose codex or claude-code" };
      const positional = argv.filter((arg, index) => !arg.startsWith("--") && (providerIndex < 0 || index !== providerIndex + 1));
      const [command, rawWindow] = positional;
      const { report, buildReport } = providers[selectedProvider.data];
      if (command !== "report") {
        return { exitCode: command === undefined ? 0 : 1, stdout: "Usage: bb where-the-limit-goes report [5h|7d] [--provider codex|claude-code] [--all] [--json]" };
      }
      const parsed = windowKey.safeParse(rawWindow ?? "5h");
      if (!parsed.success) return { exitCode: 1, stderr: "Window must be 5h or 7d" };
      const result = all ? await buildReport(parsed.data, 0) : await report(parsed.data);
      if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
      const pct = (value: number) => `${Math.round(value * 100)}%`;
      const lines = [
        `${result.provider} · shares by ${result.shareBasis}`,
        ...result.windows.map(
          (w) =>
            `${w.key}: ${w.usedPercent}% · forecast ${w.forecast.kind}${w.forecast.minutes === null ? "" : ` ${w.forecast.minutes}m`}`,
        ),
        ...result.byType.map((t) => `${t.label}: ${pct(t.share)}`),
        ...result.threads.map((t) => `${pct(t.share)}  ${t.title} — ${t.details}`),
        `+${result.rest.count} more · ${pct(result.rest.share)}`,
      ];
      return { exitCode: 0, stdout: lines.join("\n") };
    },
  });
}
