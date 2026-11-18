# Usage & Limits

A BB sidebar widget for connected Codex and Claude Code accounts. Use **Usage** for real subscription percentages, reset times and pace
forecasts, or **Threads** for the 5h / 7d usage breakdown. Click a thread to open it.
Only windows returned by the provider appear in Usage (some plans have only 7d).
Usage bars and percentage labels show the remaining limit (100% minus usage),
without an added label. Warning colours still indicate a nearly exhausted limit.

Codex shares
use input + output tokens, including cached input, from `$CODEX_HOME/sessions`
(default `~/.codex/sessions`). These token shares are not subscription charges
or exact shares of the OpenAI limit. Forecasts are estimates at the observed pace.
Local uncompressed JSONL logs are indexed incrementally; archived compressed
logs and ChatGPT web conversations are not included. Nothing is uploaded.

Weekly forecasts use real quota usage over the rolling last 7 days,
including nights, idle time and usage before the latest weekly reset.
Provider percentage snapshots are persisted across reloads; existing Codex
rate-limit events backfill history immediately, including observations with
null token info. At scheduled or early subscription resets, only observed quota consumption is added across
windows; unused allowance is never counted as spend. Small timestamp jitter
and repeated/corrected readings do not count twice. The 7-day boundary is
interpolated between observations, so the pace remains an estimate.
When there is no history covering the last 7 days, the widget says so;
it does not impose a new waiting period after each weekly reset.
Five-hour forecasts continue to estimate the recent working pace.

A black tick (white in dark mode) on each Codex and GitHub Actions bar marks the remaining fraction of its time
window, using the same direction as the remaining allowance. After one day of
a weekly window it sits one seventh of the bar's width from the right edge.
If the allowance ends to the right of the tick, more quota remains than time;
if it ends to the left, quota is being used faster than the window elapses.
The tick is 1px wide and three times the bar's height, centred vertically.
The moving end of the filled allowance bar is square for precise comparison.
The Actions tick follows its actual UTC calendar month, including short months.

Usage checks have a five-minute TTL. Quota history stays local and is isolated
by the provider's plan label; the weekly provider history retains 8 days (7 days plus an interpolation anchor).
If provider checks fail, the last
successful result stays visible with its timestamp.

```sh
bb where-the-limit-goes report 5h --provider codex --json
bb where-the-limit-goes report 7d --all
npm test
npm run typecheck
bb plugin build
bb plugin reload where-the-limit-goes
```

One connected account opens directly. When both providers report usage, a selector switches the quota and thread views between them. The Codex card shows the number of banked manual resets returned by the local Codex app server for the matching account. An unavailable balance is displayed as unavailable. Claude Code thread shares use local input, output and cache tokens.

GitHub Actions appears as a separate Usage block for `startsevdev`. It reads
monthly compute spend from the billing usage summary and the allowance for Free/Pro through the locally authenticated
GitHub CLI (`gh`, personal billing requires the `user` scope). Results are cached
for five minutes; unavailable or unsupported billing responses show no percentage.
Credentials stay in the existing gh credential store. The GitHub block is
independent of Codex and does not change the Threads breakdown.

The Actions row uses the same bar / remaining percentage / reset countdown layout
as Codex. Monthly compute resets on the first day of the next month at 00:00 UTC;
the account login is not displayed.

Actions shows a pace forecast instead of dollar amounts, using average compute
usage since the start of the UTC billing month. The first hour has insufficient
data; the forecast is an estimate and may change with workflow activity.

## Install in BB

~~~sh
bb plugin install git:https://github.com/startsevdev/bb-plugin-where-the-limit-goes.git@v0.1.4
~~~

The public package uses the ID where-the-limit-goes because limits belongs to another plugin in BB Community. The original GitHub Actions block is specific to the author's account. Other users can use the Codex views with their own data.
