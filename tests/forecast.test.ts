import test from "node:test";
import assert from "node:assert/strict";
import { forecastLimit, type LimitWindow } from "../lib/forecast.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const start = Date.parse("2026-11-05T08:34:21Z");
const week = (usedPercent: number): LimitWindow => ({ key: "7d", usedPercent, resetsAt: start + 7 * DAY });

test("a fresh installation without a week of history stays unknown", () => {
  const now = start + 7 * HOUR;
  assert.deepEqual(forecastLimit(week(9), [
    { at: start, percent: 0, resetsAt: week(9).resetsAt },
  ], [{ at: now, cost: 100 }], now), { kind: "unknown", minutes: null });
});

test("the whole last week sets the pace, including usage before a regular reset", () => {
  const now = start + 2 * DAY;
  const history = [
    { at: now - 7 * DAY, percent: 10, resetsAt: start },
    { at: start - 60_000, percent: 100, resetsAt: start },
    { at: start, percent: 0, resetsAt: week(50).resetsAt },
    { at: now - DAY, percent: 40, resetsAt: week(50).resetsAt },
  ];
  // 90 previous-cycle points + 50 current points = 140/week = 20/day.
  // The last day's 10 points must not override the week: 50 points last 2.5 days.
  assert.deepEqual(forecastLimit(week(50), history, [], now), { kind: "runs_out", minutes: 3600 });
  assert.deepEqual(forecastLimit(week(50), JSON.parse(JSON.stringify(history)), [
    { at: now, cost: 999 },
  ], now), { kind: "runs_out", minutes: 3600 });
});

test("a purchased early quota reset retains the previous week's usage immediately", () => {
  const now = start + HOUR;
  const window = { ...week(4), resetsAt: now + 7 * DAY - HOUR };
  const previousReset = start + 2 * DAY;
  assert.deepEqual(forecastLimit(window, [
    { at: now - 7 * DAY, percent: 40, resetsAt: previousReset - 7 * DAY },
    { at: previousReset - 7 * DAY - 60_000, percent: 100, resetsAt: previousReset - 7 * DAY },
    { at: previousReset - 7 * DAY, percent: 0, resetsAt: previousReset },
    { at: start - 60_000, percent: 100, resetsAt: previousReset },
  ], [], now), { kind: "runs_out", minutes: 5900 });
  // 60 + 100 + 4 = 164 points/week; 96 remaining last ~5900 minutes.
});

test("reset adds actual usage rather than unused allowance", () => {
  const now = start + HOUR;
  assert.deepEqual(forecastLimit(week(9), [
    { at: now - 7 * DAY, percent: 50, resetsAt: start },
    { at: start - 60_000, percent: 51, resetsAt: start },
  ], [], now), { kind: "ok", minutes: null });
});

test("interpolate the seven-day boundary; timestamp jitter and counter dips do not count twice", () => {
  const now = start + 2 * DAY;
  assert.deepEqual(forecastLimit(week(50), [
    { at: now - 7 * DAY - HOUR, percent: 8, resetsAt: start },
    { at: now - 7 * DAY + HOUR, percent: 12, resetsAt: start + 10_000 },
    { at: start - 60_000, percent: 100, resetsAt: start },
    { at: start, percent: 0, resetsAt: week(50).resetsAt },
    { at: now - 2 * HOUR, percent: 40, resetsAt: week(50).resetsAt },
    { at: now - HOUR, percent: 39, resetsAt: week(50).resetsAt },
  ], [], now), { kind: "runs_out", minutes: 3600 });
});

test("late old-cycle replies after an early reset cannot inflate usage", () => {
  const now = start + HOUR;
  assert.deepEqual(forecastLimit(week(50), [
    { at: now - 7 * DAY, percent: 10, resetsAt: start },
    { at: start - 60_000, percent: 100, resetsAt: start },
    { at: start, percent: 0, resetsAt: week(50).resetsAt },
    { at: now - 60_000, percent: 100, resetsAt: start },
  ], [], now), { kind: "runs_out", minutes: 3600 });
});

test("exhaustion is immediate; a full idle week lasts until reset; missing windows stay unknown", () => {
  assert.deepEqual(forecastLimit(week(100), [], [], start + HOUR), { kind: "exhausted", minutes: null });
  assert.deepEqual(forecastLimit(week(0), [
    { at: start - 7 * DAY, percent: 0, resetsAt: start },
  ], [], start), { kind: "ok", minutes: null });
  assert.deepEqual(forecastLimit(undefined, [], [], start), { kind: "unknown", minutes: null });
  assert.deepEqual(forecastLimit(week(20), [], [], start + 2 * DAY), { kind: "unknown", minutes: null });
});

test("five-hour forecasts retain their short-term percentage and token pace", () => {
  const window: LimitWindow = { key: "5h", usedPercent: 40, resetsAt: start + 5 * HOUR };
  const now = start + HOUR;
  assert.deepEqual(forecastLimit(window, [
    { at: now - HOUR / 2, percent: 20, resetsAt: window.resetsAt },
    { at: now, percent: 40, resetsAt: window.resetsAt },
  ], [], now), { kind: "runs_out", minutes: 90 });
  assert.deepEqual(forecastLimit({ ...window, usedPercent: 50 }, [], [
    { at: now - HOUR * 0.75, cost: 50 }, { at: now, cost: 50 },
  ], now), { kind: "runs_out", minutes: 60 });
});
