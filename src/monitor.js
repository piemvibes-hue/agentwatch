'use strict';
const fs = require('fs');
const path = require('path');

// Scans ~/.codex/sessions/**/rollout-*.jsonl and tails new lines.
// Emits: 'line' {threadId, file, line, parsed}, plus snapshot info per thread.
const ROLLOUT_RE = /rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:_\d+)?\.jsonl$/;

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) yield p;
  }
}

class SessionMonitor {
  constructor(codexHome) {
    this.sessionsDir = path.join(codexHome, 'sessions');
    // file -> { offset, lastLineAt, lastLine, lastParsed, seenActive, threadId }
    this.files = new Map();
  }

  // One scan+tail cycle. Returns array of {threadId, file, line, parsed}.
  poll() {
    const out = [];
    const files = new Set([...walk(this.sessionsDir)]);
    for (const file of files) {
      const m = ROLLOUT_RE.exec(file);
      const threadId = m ? m[1] : file;
      let t = this.files.get(file);
      if (!t) {
        t = { offset: 0, lastLineAt: 0, lastLine: null, lastParsed: null, seenActive: false, threadId };
        this.files.set(file, t);
        // First sight: don't replay history, but DO inspect the tail so a thread
        // that died before we started (the overnight case) can be recovered.
        try {
          const st = fs.statSync(file);
          t.offset = st.size;
          t.lastLineAt = st.mtimeMs;
          t.seenActive = true;
          const tail = this._tailLine(file);
          if (tail) {
            t.lastLine = tail.line;
            t.lastParsed = tail.parsed;
            out.push({ threadId, file, line: tail.line, parsed: tail.parsed, replay: true, fileMtime: st.mtimeMs });
          }
        } catch {}
      }
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      t.threadId = threadId; // keep current (unchanged, but explicit)
      if (size < t.offset) t.offset = 0; // truncated/rotated
      if (size === t.offset) continue;
      const fd = fs.openSync(file, 'r');
      try {
        const len = size - t.offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, t.offset);
        const chunk = buf.toString('utf8');
        const lines = chunk.split(/\r?\n/);
        if (!chunk.endsWith('\n')) {
          // keep the partial last line for next round
          const partial = lines.pop();
          t.offset = size - Buffer.byteLength(partial, 'utf8');
        } else {
          t.offset = size;
          lines.pop();
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed = null;
          try { parsed = JSON.parse(line); } catch {}
          t.lastLineAt = Date.now();
          t.lastLine = line;
          t.lastParsed = parsed;
          t.seenActive = true;
          out.push({ threadId, file, line, parsed });
        }
      } finally { fs.closeSync(fd); }
    }
    return out;
  }

  // Last non-empty line of a file (reads at most the last 64KB).
  _tailLine(file) {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.statSync(file).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split(/\r?\n/).filter(l => l.trim());
      const last = lines[lines.length - 1];
      if (!last) return null;
      let parsed = null;
      try { parsed = JSON.parse(last); } catch {}
      return { line: last, parsed };
    } finally { fs.closeSync(fd); }
  }

  // Haystack text for rule matching: raw line + common message fields.
  static haystack(ev) {
    const parts = [ev.line];
    const p = ev.parsed && (ev.parsed.payload || ev.parsed);
    if (p && typeof p === 'object') {
      for (const k of ['message', 'error', 'type', 'status', 'msg', 'reason']) {
        if (typeof p[k] === 'string') parts.push(p[k]);
      }
      if (p.error && typeof p.error === 'object' && typeof p.error.message === 'string') parts.push(p.error.message);
    }
    return parts.join(' ');
  }

  // Thread snapshot for stall detection.
  snapshot(threadId) {
    for (const t of this.files.values()) if (t.threadId === threadId) return t;
    return null;
  }

  // Threads that were active before but produced nothing for >ms.
  // maxIdleMs caps how old a stall can be before we give up on it entirely.
  // Emits at most one stall per thread (the freshest file wins).
  stalledThreads(ms, maxIdleMs = 12 * 60 * 60 * 1000) {
    const now = Date.now();
    const byThread = new Map();
    for (const [file, t] of this.files) {
      if (!t.seenActive || !t.lastLineAt) continue;
      const idle = now - t.lastLineAt;
      if (idle < ms || idle > maxIdleMs) continue;
      // Conservative: only when the last line does not itself look terminal.
      const s = (t.lastLine || '').toLowerCase();
      const terminal = ['turn_complete', 'task_complete', 'session_end', '"type":"shutdown"', 'usage limit', 'stream disconnected', 'error'];
      if (terminal.some(x => s.includes(x))) continue;
      const cur = byThread.get(t.threadId);
      if (!cur || idle < cur.idleMs) byThread.set(t.threadId, { threadId: t.threadId, file, idleMs: idle, lastLine: t.lastLine });
    }
    return [...byThread.values()];
  }

  listThreads() {
    const seen = new Map();
    for (const [file, t] of this.files) {
      if (!seen.has(t.threadId) || t.lastLineAt > seen.get(t.threadId).lastLineAt) {
        seen.set(t.threadId, { threadId: t.threadId, file, lastLineAt: t.lastLineAt, seenActive: t.seenActive });
      }
    }
    return [...seen.values()];
  }
}

module.exports = { SessionMonitor };
