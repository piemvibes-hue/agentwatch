'use strict';
const fs = require('fs');
const path = require('path');

// Persistent per-thread watchdog state (attempts, scheduled resumes).
class State {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.data = { threads: {} };
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    if (!this.data.threads) this.data.threads = {};
  }

  t(threadId) {
    if (!this.data.threads[threadId]) {
      this.data.threads[threadId] = { attempts: 0, status: 'ok', scheduledAt: null, lastRule: null, updatedAt: null };
    }
    return this.data.threads[threadId];
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {}
  }
}

module.exports = { State };
