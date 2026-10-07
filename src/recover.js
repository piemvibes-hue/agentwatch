'use strict';
const { spawn } = require('child_process');

// Recovery engine: decides actions per rule, schedules them, executes
// `codex queue`, then verifies the thread actually resumed producing events.
class Recover {
  constructor({ rules, state, notifier, codexBin = 'codex', dryRun = false, log = console.log }) {
    this.rules = rules;
    this.state = state;
    this.notifier = notifier;
    this.codexBin = codexBin;
    this.dryRun = dryRun;
    this.log = log;
    this.graceMs = 2 * 60 * 1000;
  }

  // A failure rule matched on a thread line.
  onFailure(threadId, rule, text) {
    const st = this.state.t(threadId);
    if (st.status === 'verifying' || st.status === 'scheduled') {
      this.log(`[skip] ${threadId.slice(0, 8)} already ${st.status}`);
      return;
    }
    if (st.status === 'dead') return; // gave up; human notified

    switch (rule.action) {
      case 'ignore':
        this.log(`[ignore] ${threadId.slice(0, 8)} matched never-retry rule ${rule.name}`);
        return;
      case 'notify':
        st.status = 'notify';
        this.state.save();
        this.notifier.send(`agentwatch: ${rule.name} on ${threadId.slice(0, 8)}`, text.slice(0, 300));
        return;
      case 'wait_reset': {
        const reset = this.rules.extractReset(rule, text);
        const at = reset ? reset.getTime() + this.graceMs : Date.now() + (rule.fallbackDelayMs || 3600000);
        this._schedule(threadId, rule, at);
        return;
      }
      case 'queue':
      default: {
        const backoff = rule.retryBackoff || 1;
        const delay = (rule.delayMs || 0) * Math.pow(backoff, Math.max(0, st.attempts - 1));
        this._schedule(threadId, rule, Date.now() + delay);
        return;
      }
    }
  }

  onStall(threadId, stallCfg, idleMs) {
    const rule = {
      name: 'stall', action: stallCfg.action || 'queue',
      message: stallCfg.message || 'Continue', delayMs: 0,
    };
    this.log(`[stall] ${threadId.slice(0, 8)} idle ${Math.round(idleMs / 60000)}min`);
    this.onFailure(threadId, rule, `stalled ${Math.round(idleMs / 60000)} min with no new events`);
  }

  _schedule(threadId, rule, at) {
    const st = this.state.t(threadId);
    st.status = 'scheduled';
    st.scheduledAt = at;
    st.lastRule = rule.name;
    st.attempts += 1;
    st.message = rule.message || this.rules.resumeMessage;
    st.updatedAt = Date.now();
    this.state.save();
    this.log(`[scheduled] ${threadId.slice(0, 8)} ${rule.name} attempt#${st.attempts} at ${new Date(at).toISOString()}`);
    if (st.attempts > 1) return;
    this.notifier.send(`agentwatch: detected ${rule.name} on thread ${threadId.slice(0, 8)}`,
      `resume scheduled ${new Date(at).toLocaleTimeString()} (attempt ${st.attempts}/${this.rules.maxAttempts})`);
  }

  // Called every poll cycle.
  async tick(monitor) {
    const now = Date.now();
    for (const [threadId, st] of Object.entries(this.state.data.threads)) {
      if (st.status === 'scheduled' && st.scheduledAt <= now) {
        await this._fire(threadId, st);
      } else if (st.status === 'verifying' && st.verifyUntil <= now) {
        // verification window expired with no activity
        if (st.attempts < this.rules.maxAttempts) {
          this.log(`[verify-fail] ${threadId.slice(0, 8)} no activity; retrying`);
          st.status = 'ok';
          const rule = { name: st.lastRule || 'retry', action: 'queue', message: st.message };
          this._schedule(threadId, rule, now + this.rules.retryDelayMs * st.attempts);
        } else {
          st.status = 'dead';
          st.updatedAt = now;
          this.state.save();
          this.notifier.send(`agentwatch: GAVE UP on ${threadId.slice(0, 8)}`,
            `${st.lastRule}: ${st.attempts} resume attempts produced no activity. Manual check needed.`);
        }
      }
    }
  }

  async _fire(threadId, st) {
    const msg = st.message || this.rules.resumeMessage;
    this.log(`[resume] ${threadId.slice(0, 8)} -> codex queue "${msg}"`);
    st.status = 'verifying';
    st.verifyUntil = Date.now() + this.rules.verifyAfterMs;
    st.updatedAt = Date.now();
    this.state.save();
    if (this.dryRun) {
      this.log(`[dry-run] would run: ${this.codexBin} queue --thread ${threadId} --message "${msg}"`);
      return;
    }
    const shell = process.platform === 'win32';
    const child = spawn(this.codexBin, ['queue', '--thread', threadId, '--message', msg], { shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      this.log(`[resume-error] ${threadId.slice(0, 8)} spawn failed: ${e.message}`);
    });
    child.on('exit', code => {
      if (code !== 0) {
        this.log(`[resume-error] ${threadId.slice(0, 8)} codex queue exited ${code}: ${err.slice(0, 200)}`);
        // force verification to fail fast so we retry sooner
        const s = this.state.t(threadId);
        s.verifyUntil = Math.min(s.verifyUntil, Date.now() + 30000);
        this.state.save();
      }
    });
  }

  // New rollout activity for a thread currently being verified → recovered.
  onActivity(threadId) {
    const st = this.state.t(threadId);
    if (st.status === 'verifying') {
      st.status = 'ok';
      st.attempts = 0;
      st.scheduledAt = null;
      st.updatedAt = Date.now();
      this.state.save();
      this.notifier.send(`agentwatch: ${threadId.slice(0, 8)} recovered`, 'thread is producing events again');
      this.log(`[recovered] ${threadId.slice(0, 8)}`);
    } else if (st.status === 'scheduled') {
      // User resumed it manually — stand down.
      st.status = 'ok';
      st.attempts = 0;
      st.scheduledAt = null;
      st.updatedAt = Date.now();
      this.state.save();
      this.log(`[stand-down] ${threadId.slice(0, 8)} resumed externally`);
    }
  }
}

module.exports = { Recover };
