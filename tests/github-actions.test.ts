import test from "node:test";
import assert from "node:assert/strict";
import { parseActionsBilling, forecastActions } from "../lib/github-actions.ts";

const now = new Date("2026-11-03T11:00:00Z");
const item = (sku: string, grossAmount: number, product = "Actions", unitType = "minutes") => ({ product, sku, grossAmount, unitType });
const summary = (usageItems: unknown[]) => ({ user: "startsevdev", timePeriod: { year: 2026, month: 11 }, usageItems });
const parse = (usageItems: unknown[], plan = "free") => parseActionsBilling(summary(usageItems), plan, "startsevdev", now);

test("real billing summary: 53 Linux minutes uses $0.318 of Free's $12 allowance", () => {
  const result = parse([item("actions_linux", 0.318)]);
  assert.equal(result.includedAmount, 12);
  assert.equal(result.usedAmount, 0.318);
  assert.equal(Math.round(100 - result.usedPercent), 97);
});

test("sum compute costs across runner rates and shared sandbox, exclude storage and other products", () => {
  const result = parse([item("actions_linux", 1), item("actions_macos", 2), item("sandbox_memory", 0.5, "sandbox", "GB-hours"), item("actions_storage", 10), item("copilot_ai_credit", 99, "Copilot")], "pro");
  assert.equal(result.usedAmount, 3.5);
  assert.equal(result.includedAmount, 18);
  assert.equal(parse([]).usedPercent, 0);
  assert.equal(parse([item("actions_linux", 24)]).usedPercent, 200);
});

test("unknown allowances, malformed data, stale periods and wrong accounts must not imply full allowance", () => {
  for (const value of [{}, summary([item("actions_linux", -1)]), summary([item("actions_linux", Infinity)]), { ...summary([]), user: "other" }, { ...summary([]), timePeriod: { year: 2026, month: 10 } }]) {
    assert.throws(() => parseActionsBilling(value, "free", "startsevdev", now));
  }
  assert.throws(() => parse([], "unknown"));
  assert.throws(() => parse([item("actions_unknown", 1)]));
  assert.throws(() => parse([item("actions_linux", 1, "Actions", "GB-hours")]));
});


test("monthly reset uses UTC and handles year rollover and leap February", () => {
  for (const [year, month, expected] of [
    [2026, 11, "2026-12-01T00:00:00.000Z"],
    [2026, 12, "2027-01-01T00:00:00.000Z"],
    [2028, 2, "2028-03-01T00:00:00.000Z"],
  ] as const) {
    const value = { ...summary([]), timePeriod: { year, month } };
    const result = parseActionsBilling(value, "free", "startsevdev", new Date(Date.UTC(year, month - 1, 15)));
    assert.equal(new Date(result.resetsAt).toISOString(), expected);
  }
});


test("monthly pace predicts lasting until reset, exhaustion or running out sooner", () => {
  assert.deepEqual(forecastActions(0.318, 12, now), { kind: "ok", minutes: null });
  assert.deepEqual(forecastActions(12, 12, now), { kind: "exhausted", minutes: null });
  assert.deepEqual(forecastActions(24, 12, now), { kind: "exhausted", minutes: null });
  assert.deepEqual(forecastActions(0, 12, now), { kind: "ok", minutes: null });
  assert.deepEqual(forecastActions(6, 12, new Date("2026-11-03T00:00:00Z")), { kind: "runs_out", minutes: 2880 });
  assert.deepEqual(forecastActions(6, 12, new Date("2026-11-16T00:00:00Z")), { kind: "ok", minutes: null });
  assert.deepEqual(forecastActions(0, 12, new Date("2026-11-01T00:30:00Z")), { kind: "unknown", minutes: null });
});
