'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Structured detection layer: reads Codex's own SQLite stores under ~/.codex
// (logs_2.sqlite errors per thread, goals_1.sqlite usageLimited status,
// state_5.sqlite thread activity + source, thread_history_1.sqlite per-turn
// status — failed turns carry error_json; orphaned inProgress turns = died
// mid-run). Zero npm deps: queries run through a Python sqlite3 subprocess
// when Python exists, else this layer disables itself and the rollout-file
// monitor carries detection alone.

const PY = `
import sqlite3, json, sys, os
home, last_log_id = sys.argv[1], int(sys.argv[2])
out = {"logs": [], "goals": [], "threads": [], "turns": [], "max_log_id": last_log_id, "dbs": []}
def q(db, sql, args=()):
    p = os.path.join(home, db)
    if not os.path.exists(p): return
    try:
        con = sqlite3.connect("file:" + p.replace("\\\\", "/") + "?mode=ro", uri=True)
        out["dbs"].append(db)
        return con.execute(sql, args).fetchall()
    except Exception:
        return None
rows = q("logs_2.sqlite",
  "SELECT id, ts, level, COALESCE(thread_id,''), substr(feedback_log_body,1,2000) FROM logs WHERE id > ? ORDER BY id LIMIT 500",
  (last_log_id,))
if rows is not None:
    for r in rows:
        out["max_log_id"] = max(out["max_log_id"], r[0])
        if r[2] in ("ERROR", "WARN") and r[3]:
            out["logs"].append({"id": r[0], "ts": r[1], "level": r[2], "thread_id": r[3], "body": r[4]})
rows = q("goals_1.sqlite",
  "SELECT thread_id, goal_id, status, tokens_used, token_budget FROM thread_goals")
if rows is not None:
    for r in rows:
        out["goals"].append({"thread_id": r[0], "goal_id": r[1], "status": r[2], "tokens_used": r[3], "token_budget": r[4]})
rows = q("state_5.sqlite",
  "SELECT id, COALESCE(title,''), COALESCE(updated_at_ms,0), COALESCE(recency_at_ms,0), COALESCE(tokens_used,0), COALESCE(source,'') FROM threads")
if rows is None:  # older codex: threads table predates the source column
    rows = q("state_5.sqlite",
      "SELECT id, COALESCE(title,''), COALESCE(updated_at_ms,0), COALESCE(recency_at_ms,0), COALESCE(tokens_used,0), '' FROM threads")
if rows is not None:
    for r in rows:
        out["threads"].append({"id": r[0], "title": r[1], "updated_ms": r[2], "recency_ms": r[3], "tokens_used": r[4], "source": r[5]})
rows = q("thread_history_1.sqlite",
  "SELECT thread_id, turn_id, status, COALESCE(error_json,''), COALESCE(started_at,''), COALESCE(completed_at,'') FROM thread_turns")
if rows is not None:
    for r in rows:
        out["turns"].append({"thread_id": r[0], "turn_id": r[1], "status": r[2], "error_json": r[3], "started_at": r[4], "completed_at": r[5]})
print(json.dumps(out))
`;

class DbWatch {
  constructor(codexHome) {
    this.codexHome = codexHome;
    this.pyBin = this._findPython();
    this.lastLogId = null;   // null = not initialized (first poll sets baseline)
    this.goalStatus = new Map(); // "threadId/goalId" -> status
    this.threadSeen = new Map(); // threadId -> updated_ms
    this.threadSource = new Map(); // threadId -> threads.source (exec/app/...)
    this.turnStatus = new Map(); // turnId -> {threadId,status,startedAt}
    this.disabledReason = null;
  }

  _findPython() {
    for (const bin of ['python', 'python3', 'py']) {
      try {
        const r = spawnSync(bin, ['--version'], { timeout: 5000 });
        if (r.status === 0) return bin;
      } catch {}
    }
    return null;
  }

  get available() {
    return this.pyBin !== null && !this.disabledReason;
  }

  // Emits normalized events:
  //   {kind:'log',   threadId, text, level}
  //   {kind:'goal',  threadId, text, status}
  //   {kind:'thread',threadId, updatedMs}         (activity signal)
  poll() {
    if (!this.pyBin) return { events: [], disabled: 'no-python' };
    if (this.disabledReason) return { events: [], disabled: this.disabledReason };
    const r = spawnSync(this.pyBin, ['-c', PY, this.codexHome, String(this.lastLogId ?? -1)],
      { timeout: 15000, encoding: 'utf8' });
    if (r.status !== 0) {
      this.disabledReason = 'query-failed';
      return { events: [], disabled: this.disabledReason };
    }
    let d;
    try { d = JSON.parse(r.stdout); } catch { this.disabledReason = 'bad-json'; return { events: [], disabled: this.disabledReason }; }
    if (!d.dbs.length) return { events: [], disabled: null }; // old codex: no DBs yet

    const events = [];
    const cutoff = Date.now() - 24 * 3600 * 1000;

    if (this.lastLogId === null) {
      // First poll: replay only recent errors (died-before-watchdog-started case).
      for (const l of d.logs) {
        const ts = Date.parse(l.ts) || 0;
        if (ts > cutoff) events.push({ kind: 'log', threadId: l.thread_id, text: l.body, level: l.level, replay: true });
      }
    } else {
      for (const l of d.logs) events.push({ kind: 'log', threadId: l.thread_id, text: l.body, level: l.level });
    }
    this.lastLogId = d.max_log_id;

    for (const g of d.goals) {
      const key = `${g.thread_id}/${g.goal_id}`;
      const prev = this.goalStatus.get(key);
      this.goalStatus.set(key, g.status);
      const bad = /usageLimited|fail|error|stopped/i.test(g.status || '');
      if (bad && prev !== g.status) {
        events.push({ kind: 'goal', threadId: g.thread_id, status: g.status, text: `"status":"${g.status}" goal=${g.goal_id}` });
      }
    }

    for (const t of d.threads) {
      this.threadSource.set(t.id, t.source);
      const prev = this.threadSeen.get(t.id) || 0;
      if (t.updated_ms > prev) {
        this.threadSeen.set(t.id, t.updated_ms);
        if (prev > 0) events.push({ kind: 'thread', threadId: t.id, updatedMs: t.updated_ms });
      }
    }

    // Per-turn status: 'failed' turns carry error_json (rule-matched like logs);
    // 'inProgress' turns whose thread went idle are orphan corpses (died mid-run)
    // and are surfaced through orphanTurns() for stall handling.
    const firstPollTurns = this.turnStatus.size === 0;
    for (const tn of d.turns) {
      const prev = this.turnStatus.get(tn.turn_id);
      const startedMs = Date.parse(tn.started_at) || 0;
      this.turnStatus.set(tn.turn_id, { threadId: tn.thread_id, status: tn.status, startedMs, errorJson: tn.error_json });
      if (tn.status === 'failed') {
        if (firstPollTurns ? startedMs > cutoff : (!prev || prev.status !== 'failed')) {
          events.push({ kind: 'log', threadId: tn.thread_id, text: tn.error_json || 'turn failed', level: 'ERROR', replay: firstPollTurns });
        }
      }
    }
    return { events, disabled: null };
  }

  // Threads whose DB-updated timestamp is older than idleMs (DB-level stall,
  // used when no rollout lines exist for the thread).
  staleThreads(idleMs, activeGoalOnly = true) {
    const now = Date.now();
    const out = [];
    for (const [tid, updatedMs] of this.threadSeen) {
      if (now - updatedMs < idleMs) continue;
      if (activeGoalOnly) {
        const hasActiveGoal = [...this.goalStatus.entries()]
          .some(([k, s]) => k.startsWith(tid + '/') && /working|running|active|progress|pending/i.test(s || ''));
        if (!hasActiveGoal) continue;
      }
      out.push({ threadId: tid, idleMs: now - updatedMs });
    }
    return out;
  }

  // Orphaned turns: status=inProgress but the owning thread has been idle for
  // idleMs — the process died mid-turn (crash, kill, power loss). Distinct
  // from staleThreads: the turn row itself proves work was abandoned.
  orphanTurns(idleMs) {
    const now = Date.now();
    const out = [];
    for (const [turnId, t] of this.turnStatus) {
      if (t.status !== 'inProgress') continue;
      const threadIdle = now - (this.threadSeen.get(t.threadId) || 0);
      const turnAge = t.startedMs ? now - t.startedMs : Infinity;
      if (Math.min(threadIdle, turnAge) >= idleMs) {
        out.push({ threadId: t.threadId, turnId, idleMs: Math.min(threadIdle, turnAge) });
      }
    }
    return out;
  }

  // Recovery routing hint: exec-source threads can be revived out-of-app via
  // `codex exec resume`; app/desktop/interactive threads need `codex queue`
  // (which only fires while that surface has the thread open).
  sourceOf(threadId) {
    return this.threadSource.get(threadId) || '';
  }
}

module.exports = { DbWatch };
