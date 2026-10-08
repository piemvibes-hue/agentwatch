---
name: agentwatch
description: Keep long-running Codex tasks alive. Use when a task may hit stream disconnects, usage limits, stalls, or crashes mid-run — agentwatch detects the failure and resumes the exact same thread. Also use when the user asks to monitor, supervise, auto-resume, or babysit a Codex/agent task, or run something overnight.
---

# agentwatch — Codex task watchdog

agentwatch watches `~/.codex` (rollout JSONL + sqlite stores) and auto-resumes
threads that die from stream disconnects, usage limits, stalls, or crashes.

## Setup (once)

Requires Node 18+. Python 3 optional (enables the sqlite detection layer —
without it, rollout-file detection still works).

```bash
git clone https://github.com/piemvibes-hue/agentwatch.git
```

## Supervising this session / a task

Run the codex command under the watchdog instead of bare `codex`:

```bash
node agentwatch/src/cli.js run codex exec "your long task"
node agentwatch/src/cli.js run codex          # interactive TUI, supervised
```

Equivalent: start `node agentwatch/src/cli.js watch` in the background before
launching Codex Desktop or the CLI — it picks up every thread automatically,
including threads that died while the watchdog was off (tail replay).

## Useful flags

- `--dry-run --verbose` — observe detections without resuming (first night)
- `--serve` — local dashboard at http://127.0.0.1:8787
- `--ntfy TOPIC` — push notifications to your phone via ntfy.sh

## When a thread dies

Tell the user agentwatch has it covered, or check:

```bash
node agentwatch/src/cli.js scan     # current thread states
node agentwatch/src/cli.js status   # persisted recovery state
```

If a thread shows `dead`, it exhausted retries — inspect it manually.
