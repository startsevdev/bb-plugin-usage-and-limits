See where your provider usage goes, which threads use the most,
and when a limit may run out at the current pace.

## What you get

- A Gauge button in the sidebar footer for Codex and Claude Code.
- Usage: remaining provider limit percentages, reset times and forecasts.
- GitHub Actions: remaining included monthly compute, reset countdown and a pace forecast through local GitHub CLI billing access.
- Threads: 5h and 7d rankings with thread type, model and subagent count.
  Click a row to open its thread.
- The same reports through `bb where-the-limit-goes report` for each provider.

## How it works

Limit percentages come from BB's Codex usage. Thread shares use tokens,
including cached input, and are labelled accordingly: they are not charges
or exact shares of the subscription limit. Forecasts are estimates. Everything
is read locally; nothing is uploaded. ChatGPT web conversations are not included.

GitHub billing requires a local `gh` login with the `user` scope. If the account billing API is unavailable or uses an unsupported format, no percentage is shown.
