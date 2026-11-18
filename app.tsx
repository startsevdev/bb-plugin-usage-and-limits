// bb-plugin-limits — sidebar footer card "Where the limit goes".
//
// Mirrors BB's own Provider usage card: the same sidebar tokens, the same
// four-column subgrid for bars, and colour only when a limit is running out.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type ExperimentalSidebarFooterDisclosureProps,
} from "@get-bb/plugin-sdk/app";
import type { ActionsReport } from "./lib/github-actions";
import type { Report, WindowKey, rpcContract } from "./server";
import { WINDOW_MS } from "./lib/forecast";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const REFRESH_MS = 60_000;
/** BB's hover timing: colour snaps in on hover and fades out over 150 ms. */
const HOVER_TRANSITION = "transition-colors duration-150 hover:duration-0";
const STALE_MS = 10 * 60_000;

const clock = (at: number) =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Same thresholds as BB's usage card. */
function barTone(percent: number): string {
  return percent >= 95 ? "bg-destructive" : percent >= 80 ? "bg-warning" : "bg-primary";
}
function textTone(percent: number): string {
  return percent >= 95
    ? "text-destructive"
    : percent >= 80
      ? "text-warning"
      : "text-sidebar-foreground";
}

/** "55m", "4h 55m", "4d 10h" — the units BB's card uses. */
function untilReset(resetsAt: number): string {
  const minutes = Math.max(0, Math.round((resetsAt - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function forecastText(forecast: Report["windows"][number]["forecast"]) {
  switch (forecast.kind) {
    case "exhausted":
      return <span className="text-destructive">Limit reached</span>;
    case "runs_out": {
      const minutes = forecast.minutes ?? 0;
      const hours = Math.floor(minutes / 60);
      const label =
        minutes < 60
          ? `${minutes}m`
          : hours < 24
            ? `${hours}h ${minutes % 60}m`
            : `${Math.floor(hours / 24)}d ${hours % 24}h`;
      return (
        <>
          At this pace it runs out{" "}
          <span className={minutes <= 60 ? "text-destructive" : "text-sidebar-foreground"}>
            in ~{label}
          </span>
        </>
      );
    }
    case "ok":
      return (
        <>
          At this pace it lasts <span className="text-sidebar-foreground">until reset</span>
        </>
      );
    default:
      return "Forecast appears in a few minutes";
  }
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

function Bar({ usedPercent, timeRemainingPercent }: { usedPercent: number; timeRemainingPercent?: number }) {
  return (
    <span className="relative h-1 min-w-0">
      <span className="block h-full overflow-hidden rounded-full bg-sidebar-border">
        <span
          className={cn("block h-full", barTone(usedPercent))}
          style={{ width: `${100 - Math.max(0, Math.min(100, usedPercent))}%` }}
        />
      </span>
      {timeRemainingPercent === undefined ? null : (
        <span
          className="absolute w-px bg-black [.dark_&]:bg-white"
          style={{ top: "-100%", height: "300%", left: `clamp(0px, ${timeRemainingPercent}%, calc(100% - 1px))` }}
          title={`${Math.round(100 - timeRemainingPercent)}% of the limit period has elapsed`}
        />
      )}
    </span>
  );
}

function useReport(window: WindowKey) {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const request = ++generation.current;
    setLoading(true);
    rpc
      .call("limits_report", { window, provider: "codex" })
      .then(
        (result) => {
          if (request !== generation.current) return;
          setReport(result);
          setError(null);
        },
        (cause: unknown) => { if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); },
      )
      .finally(() => { if (request === generation.current) setLoading(false); });
  }, [rpc, window]);
  useEffect(() => {
    setReport(null);
    setError(null);
    refetch();
    const timer = setInterval(refetch, REFRESH_MS);
    return () => { clearInterval(timer); generation.current++; };
  }, [refetch]);
  return { report, error, loading, refetch };
}

function ActionsUsage({ refreshKey }: { refreshKey: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<ActionsReport | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => rpc.call("github_actions", {}).then(
      value => { if (active) { setReport(value); setFailed(false); } },
      () => { if (active) setFailed(true); },
    );
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => { active = false; clearInterval(timer); };
  }, [rpc, refreshKey]);
  const used = failed ? null : report?.usedPercent ?? null;
  const reset = report?.resetsAt;
  const resetDate = reset == null ? null : new Date(reset);
  const monthStart = resetDate === null ? null : Date.UTC(resetDate.getUTCFullYear(), resetDate.getUTCMonth() - 1, 1);
  const timeRemainingPercent = reset == null || monthStart === null ? undefined
    : Math.max(0, Math.min(100, (reset - Date.now()) / (reset - monthStart) * 100));
  return (
    <section className="mt-2.5 border-t border-sidebar-border pt-2.5">
      <div className="mb-1.5 flex min-w-0 items-baseline gap-2">
        <span className="text-xs text-sidebar-foreground">GitHub Actions</span>
      </div>
      {used === null ? (
        <p className="text-2xs text-subtle-foreground">
          {report === null && !failed ? "Checking usage…" : "Billing data is temporarily unavailable"}
        </p>
      ) : (
        <>
          <div className="grid min-h-5 grid-cols-[max-content_minmax(0,1fr)_max-content_max-content] items-center gap-x-3 text-2xs">
            <span className="whitespace-nowrap text-subtle-foreground">Monthly</span>
            <Bar usedPercent={used} timeRemainingPercent={timeRemainingPercent} />
            <span className={cn("whitespace-nowrap text-right tabular-nums", textTone(used))}>
              {Math.round(100 - Math.max(0, Math.min(100, used)))}%
            </span>
            <span
              className="min-w-9 whitespace-nowrap text-right tabular-nums text-subtle-foreground"
              title={report?.resetsAt == null ? undefined : `Resets ${new Date(report.resetsAt).toLocaleString()}`}
            >
              {report?.resetsAt == null ? "—" : untilReset(report.resetsAt)}
            </span>
          </div>
          <p
            className="text-2xs leading-snug text-subtle-foreground"
            title="Estimated from average usage since the start of this month"
          >
            {report == null ? null : report.forecast.kind === "unknown" ? "Forecast appears after the first hour of the month" : forecastText(report.forecast)}
          </p>
        </>
      )}
    </section>
  );
}

type Tab = "usage" | "threads";
const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "usage", label: "Usage" },
  { key: "threads", label: "Threads" },
];

/** BB's tab pill, shared by the card tabs and the Threads window switch. */
function tabClass(active: boolean): string {
  return cn(
    "relative flex h-6 shrink-0 cursor-pointer items-center justify-center rounded-md px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    HOVER_TRANSITION,
    active
      ? "bg-sidebar-accent text-sidebar-foreground"
      : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
  );
}

function LimitsCard({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const [tab, setTab] = useState<Tab>("usage");
  // The window threads are ranked over; Usage shows both windows either way.
  const [window, setWindow] = useState<WindowKey>("5h");
  const { report, error, loading, refetch } = useReport(window);
  const providerLabel = "Codex";
  const vendor = "OpenAI";
  const navigate = useBbNavigate();

  return (
    <div className="flex max-h-80 flex-col">
      <div className="flex h-9 min-w-0 shrink-0 items-center gap-1 border-b border-sidebar-border px-1.5">
        <div role="tablist" aria-label="View" className="flex shrink-0 items-center gap-0.5">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tabClass(tab === key)}
              onClick={() => setTab(key)}
            >
              <span className="text-2xs font-medium">{label}</span>
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button
          type="button"
          title="Refresh"
          aria-label="Refresh"
          disabled={loading}
          className={cn(
            "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-default disabled:opacity-50",
            HOVER_TRANSITION,
          )}
          onClick={refetch}
        >
          <Icon name="RotateCcw" className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        <button
          type="button"
          title="Collapse"
          aria-label="Collapse"
          className={cn(
            "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            HOVER_TRANSITION,
          )}
          onClick={dismiss}
        >
          <Icon name="ChevronDown" className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto p-2.5">
        {report === null ? (
          <p className="text-2xs text-subtle-foreground">
            {error === null ? "Calculating usage…" : `Couldn't calculate: ${error}`}
          </p>
        ) : tab === "threads" ? (
          <section>
            <div className="flex items-center gap-1.5">
              <div role="tablist" aria-label="Window" className="flex shrink-0 items-center gap-0.5">
                {(["5h", "7d"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={window === key}
                    className={tabClass(window === key)}
                    onClick={() => setWindow(key)}
                  >
                    <span className="text-2xs font-medium">{key}</span>
                  </button>
                ))}
              </div>
              <span className="min-w-0 flex-1 truncate text-right text-2xs text-subtle-foreground">
                {report.shareBasis === "tokens" ? "Share of tokens" : "Share of spend"}
              </span>
            </div>
            {report.threads.length === 0 ? (
              <p className="mt-1.5 text-2xs text-subtle-foreground">No usage in this window</p>
            ) : (
              <ul className="mt-1">
                {report.threads.map((thread) => (
                  <li key={thread.key}>
                    <button
                      type="button"
                      disabled={thread.threadId === null}
                      className={cn(
                        "-mx-1.5 block w-[calc(100%+0.75rem)] rounded-md px-1.5 py-0.5 text-left enabled:cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring enabled:hover:bg-sidebar-accent",
                        HOVER_TRANSITION,
                      )}
                      onClick={() => {
                        if (thread.threadId === null) return;
                        navigate.toThread(thread.threadId);
                        dismiss();
                      }}
                    >
                      <span className="flex min-w-0 items-baseline gap-3 text-xs">
                        <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                          {thread.title}
                        </span>
                        <span className="shrink-0 whitespace-nowrap tabular-nums text-sidebar-foreground">
                          {pct(thread.share)}
                        </span>
                      </span>
                      <span className="block truncate text-2xs text-subtle-foreground">
                        {thread.details}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {report.shareBasis === "tokens" ? <p className="mt-1.5 text-2xs text-subtle-foreground">Token shares include cached input; subscription usage may differ.</p> : null}
            {report.rest.count === 0 ? null : (
              <p className="pt-1 text-2xs text-subtle-foreground">
                {report.rest.count} more · {pct(report.rest.share)}
              </p>
            )}
          </section>
        ) : (
          <section className="grid grid-cols-[max-content_minmax(0,1fr)_max-content_max-content] gap-x-3">
            <div className="col-span-full mb-1.5 flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground">{providerLabel}</span>
              {report.plan === null ? null : (
                <span className="shrink-0 rounded-sm bg-sidebar-border/60 px-1 py-0.5 text-2xs leading-none text-subtle-foreground">
                  {report.plan}
                </span>
              )}
            </div>
            {report.windows.length === 0 ? (
              <p className="col-span-full text-2xs leading-snug text-subtle-foreground">
                Limit percentages are temporarily unavailable from {vendor}
              </p>
            ) : null}
            {report.windows.map((w, index) => (
              <div
                key={w.key}
                className={cn("col-span-full grid grid-cols-subgrid", index > 0 && "mt-1.5")}
              >
                <div className="col-span-full grid min-h-5 grid-cols-subgrid items-center text-2xs">
                  <span className="whitespace-nowrap text-subtle-foreground">{w.key}</span>
                  <Bar
                    usedPercent={w.usedPercent}
                    timeRemainingPercent={Math.max(0, Math.min(100, (w.resetsAt - Date.now()) / WINDOW_MS[w.key] * 100))}
                  />
                  <span className={cn("whitespace-nowrap text-right tabular-nums", textTone(w.usedPercent))}>
                    {Math.round(100 - Math.max(0, Math.min(100, w.usedPercent)))}%
                  </span>
                  <span className="min-w-9 whitespace-nowrap text-right tabular-nums text-subtle-foreground">
                    {untilReset(w.resetsAt)}
                  </span>
                </div>
                <p
                  className="col-span-full text-2xs leading-snug text-subtle-foreground"
                  title={w.key === "7d" ? "Estimated from actual quota usage over the last 7 days, including usage before scheduled or early resets" : undefined}
                >
                  {w.key === "7d" && w.forecast.kind === "unknown"
                    ? "Not enough usage history for a 7-day forecast"
                    : forecastText(w.forecast)}
                </p>
              </div>
            ))}
            {report.limitsCheckedAt !== null &&
            report.generatedAt - report.limitsCheckedAt > STALE_MS ? (
              <p className="col-span-full mt-0.5 text-2xs leading-snug text-subtle-foreground/75">
                Percentages as of {clock(report.limitsCheckedAt)}: waiting for {vendor}
              </p>
            ) : null}
          </section>
        )}
        {tab === "usage" ? <ActionsUsage refreshKey={report?.generatedAt ?? 0} /> : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "limits",
    label: "Where the limit goes",
    icon: "where-the-limit-goes/gauge",
    component: LimitsCard,
  });
});
