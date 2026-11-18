export type WindowKey = "5h" | "7d";
export interface LimitWindow {
  key: WindowKey;
  usedPercent: number;
  resetsAt: number;
}
export interface Snapshot {
  at: number;
  percent: number;
  resetsAt: number;
}
export interface Forecast {
  kind: "ok" | "runs_out" | "exhausted" | "unknown";
  minutes: number | null;
}

const HOUR = 3_600_000;
export const WINDOW_MS: Record<WindowKey, number> = { "5h": 5 * HOUR, "7d": 168 * HOUR };
export const PACE: Record<WindowKey, { lookback: number; minSpan: number; costSpan: number }> = {
  "5h": { lookback: HOUR, minSpan: 30 * 60_000, costSpan: 30 * 60_000 },
  "7d": { lookback: 168 * HOUR, minSpan: 168 * HOUR, costSpan: 168 * HOUR },
};

/** Rolling quota spend; a reset adds the new cycle's usage, not unused quota. */
export function weeklyUsage(window: LimitWindow, snapshots: Snapshot[], now: number): number | null {
  const boundary = now - WINDOW_MS["7d"];
  const tolerance = 60_000; // Provider reset timestamps can vary by a few seconds.
  const samples = [...snapshots.filter(s =>
    Number.isFinite(s.at) && Number.isFinite(s.percent) && Number.isFinite(s.resetsAt)
    && s.at >= now - 8 * 24 * HOUR && s.at <= now && s.percent >= 0 && s.percent <= 100
    && s.at <= s.resetsAt + tolerance
    && s.at >= s.resetsAt - WINDOW_MS["7d"] - tolerance
  ), { at: now, percent: window.usedPercent, resetsAt: window.resetsAt }].sort((a, b) => a.at - b.at);
  const points: Array<{ at: number; total: number }> = [];
  let reset: number | null = null;
  let offset = 0;
  let high = 0;
  for (const sample of samples) {
    if (reset === null) reset = sample.resetsAt;
    else if (sample.resetsAt < reset - tolerance) continue; // Late old-cycle reply.
    else if (sample.resetsAt > reset + tolerance) {
      // A subscription renewal can reset the quota before the scheduled date.
      // Preserve observed spend across it, just like a scheduled reset.
      if (sample.resetsAt - reset > WINDOW_MS["7d"] + tolerance) return null;
      offset += high;
      high = 0;
      points.push({ at: Math.min(sample.at, Math.max(points.at(-1)!.at, reset)), total: offset });
      reset = sample.resetsAt;
    }
    // Repeated/cached replies and rounding corrections must not count twice.
    high = Math.max(high, sample.percent);
    points.push({ at: sample.at, total: offset + high });
  }
  if (!points.length || points[0]!.at > boundary) return null;
  let before = points[0]!;
  for (const after of points) {
    if (after.at <= boundary) { before = after; continue; }
    const fraction = (boundary - before.at) / (after.at - before.at);
    const baseline = before.total + fraction * (after.total - before.total);
    return Math.max(0, points.at(-1)!.total - baseline);
  }
  return null;
}

export function forecastLimit(
  window: LimitWindow | undefined,
  snapshots: Snapshot[],
  records: Array<{ at: number; cost: number }>,
  now = Date.now(),
): Forecast {
  if (window === undefined) return { kind: "unknown", minutes: null };
  if (window.usedPercent >= 100) return { kind: "exhausted", minutes: null };
  const pace = PACE[window.key];
  let perMinute: number | null = null;
  if (window.key === "7d") {
    const usage = weeklyUsage(window, snapshots, now);
    if (usage === null) return { kind: "unknown", minutes: null };
    perMinute = usage / (7 * 24 * 60);
  } else {
    // Five-hour windows continue to show the recent working pace.
    const recent = snapshots.filter((s) => s.at >= now - pace.lookback);
    const first = recent[0];
    const last = recent.at(-1);
    if (first && last && last.at - first.at >= pace.minSpan && last.percent - first.percent >= 3) {
      perMinute = (last.percent - first.percent) / ((last.at - first.at) / 60_000);
    } else {
      const windowStart = window.resetsAt - WINDOW_MS[window.key];
      const spanStart = Math.max(windowStart, now - pace.costSpan);
      let windowCost = 0;
      let recentCost = 0;
      for (const record of records) {
        if (record.at < windowStart) continue;
        windowCost += record.cost;
        if (record.at >= spanStart) recentCost += record.cost;
      }
      const spanMinutes = (now - spanStart) / 60_000;
      if (windowCost > 0 && window.usedPercent > 0 && spanMinutes > 0) {
        perMinute = ((recentCost / spanMinutes) * window.usedPercent) / windowCost;
      }
    }
  }
  if (perMinute === null) return { kind: "unknown", minutes: null };
  if (perMinute <= 0) return { kind: "ok", minutes: null };
  const minutes = (100 - window.usedPercent) / perMinute;
  if (now + minutes * 60_000 >= window.resetsAt) return { kind: "ok", minutes: null };
  return { kind: "runs_out", minutes: Math.max(1, Math.round(minutes)) };
}
