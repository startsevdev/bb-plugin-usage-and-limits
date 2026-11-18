---
name: limits
description: Use when the user asks what is spending their Codex limit, which threads, routines or subagents use the most, or when the limit will run out.
---

# Where the limit goes

`bb where-the-limit-goes report [5h|7d] [--provider codex] [--all] [--json]`
prints real provider windows, forecasts, usage shares by type and top threads.
This plugin reports Codex only.

Codex shares are input + output tokens (including cached input) from `$CODEX_HOME/sessions`,
default `~/.codex/sessions`. These shares are not percentages of the subscription
limit or billed dollars. Compressed archives and ChatGPT web chats are excluded.
Real percentages come from BB's provider usage. Weekly forecasts use rolling
7-day quota consumption, including previous weekly windows and early subscription resets.
Provider snapshots persist across reloads; local Codex rate-limit events backfill
history. Missing history shows an unavailable forecast, rather than forcing a
new waiting period after every reset. Five-hour forecasts estimate recent pace.
The black tick (white in dark mode) on Codex and GitHub Actions bars marks time remaining until reset,
on the same scale as quota remaining (weekly/five-hour window or UTC calendar month).
It is 1px wide and three times the bar's height. The moving fill edge is square.
The same data appears in the sidebar footer card without a provider switch.

The Usage card also reads personal GitHub Actions billing for startsevdev via local
`gh api`, using the existing keychain login with scope `user`. This is a separate
RPC (`github_actions`), not part of the Codex CLI report. Unsupported or inaccessible
billing data is unavailable, never interpreted as a full allowance.
