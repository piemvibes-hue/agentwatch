# agentwatch

**断了续，死了报。** Watchdog for long-running AI coding agents — starts with OpenAI Codex (CLI, Desktop, exec — they all share `~/.codex`).

Leave a Codex task running overnight. When the stream disconnects, the usage limit hits, the servers 429, or the thread quietly stalls, agentwatch detects it, resumes **that exact thread** through the official `codex queue` command, verifies it is actually producing work again, and pushes you a notification when it can't.

## How it works

```
~/.codex/sessions/**/rollout-*.jsonl   (tailed every 15s)
        │  each new line → rules.json (hot-reloaded)
        ▼
  failure class → action
        │  wait_reset: extract resets_at, queue at reset+2min
        │  queue:      codex queue --thread <UUID> --message "Continue"
        │  notify:     alert only        ignore: fail-closed, never retry
        ▼
  verify: new rollout events within 5min → recovered ✓
        │  nothing → retry (max 3) → still nothing → "GAVE UP" notification
```

- **No GUI automation, no PTY wrapping, no guessing `--last`.** Recovery goes through `codex queue --thread <uuid>` — the official thread-level injection that works for interactive, exec, and Desktop sessions alike.
- **Fail-closed.** Only named failures are retried (stream disconnect, 429, overload, 5xx, timeout, usage limit, stall). Auth errors, user cancellations, content-policy stops etc. are never touched — the `never_retry` rule wins first.
- **Pre-existing corpses are detected too.** On startup agentwatch inspects the tail of every rollout file — a thread that died at 3 AM is found when you launch the watchdog at 8 AM.
- **State persists** in `~/.agentwatch/state.json` — restart-safe schedules.

## Usage

```bash
# requires Node 18+, and `codex` on PATH (ships with Codex CLI / Desktop)

node src/cli.js watch                      # run the watchdog
node src/cli.js watch --ntfy my-topic      # + push notifications via ntfy.sh
node src/cli.js watch --webhook https://…  # + POST {text,title,detail} JSON
node src/cli.js watch --dry-run            # detect & schedule, never execute
node src/cli.js scan                       # one-shot status table
node src/cli.js status                     # persisted watchdog state
```

First real-world run on your machine:

```bash
node src/cli.js watch --dry-run --verbose
```

Keep it on for a day and check the log — it shows every rollout line's rule verdict without touching anything. When it looks right, drop `--dry-run`.

## Detection coverage (rules.json)

| failure | examples matched | action |
|---|---|---|
| `usage_limit` | "hit your usage limit", "try again at 6:34 AM" | extract reset time → queue at reset + 2min (fallback 1h) |
| `stream_disconnected` | "stream disconnected before completion", transport/decode errors | queue "Continue" after 5s |
| `server_overload` | "servers are currently overloaded", "model is at capacity" | queue, 60s × 2^attempts |
| `rate_limit_429` | "429 Too Many Requests", "exceeded retry limit" | queue after 60s |
| `goal_usage_limited` | `"status":"usageLimited"` (durable Goal frozen) | queue `/goal resume` |
| `server_error_5xx`, `timeout` | 5xx, ETIMEDOUT, ECONNRESET | queue after 30s |
| `stall` | last event non-terminal, nothing new for 7min | queue "Continue" (12h max age) |
| `never_retry` | auth failure, user cancel, content policy, context length | **do nothing** |

Rules are plain JSON, hot-reloaded — add new Codex error wordings without restarting.

## Honest limitations

- `codex queue` delivers only while the app-server still has the thread — i.e. Codex Desktop/CLI must currently hold that conversation open. If the app was restarted, open the conversation once and the watchdog continues on its own.
- Detection reads rollout JSONL — the schema is unofficial and drifts. Rules match on message text, not fixed field paths, but check `watch --verbose` after a Codex update.

## Test

```bash
node test/run.js   # 16 checks: detect→schedule→resume→verify→notify, fail-closed, give-up
```

Uses a fake `codex` shim + synthetic rollouts — no Codex install needed.

## Roadmap

- [ ] Claude Code / Gemini CLI adapters (same monitor, different stores)
- [ ] `agentwatch run -- <cmd>` supervisor mode for `codex exec` / arbitrary jobs
- [ ] RunCheck integration: every recovery event reports to a run-outcome API
