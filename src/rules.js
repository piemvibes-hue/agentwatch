'use strict';
const fs = require('fs');
const path = require('path');

// Hot-reloadable rule engine. Rules match against raw rollout lines (tolerant
// to schema drift) and against extracted message text.
class Rules {
  constructor(file) {
    this.file = file;
    this._mtime = 0;
    this.reload();
  }

  reload() {
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs === this._mtime) return false;
      this._mtime = st.mtimeMs;
      const cfg = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.cfg = cfg;
      this.compiled = (cfg.rules || []).map(r => ({
        ...r,
        _re: (r.patterns || []).map(p => new RegExp(p, 'i')),
        _resetRe: r.extractReset ? new RegExp(r.extractReset, 'i') : null,
      }));
      return true;
    } catch (e) {
      if (!this.compiled) throw e;
      return false; // keep last good config on parse error
    }
  }

  get pollIntervalMs() { return this.cfg.pollIntervalMs ?? 15000; }
  get stallAfterMs() { return this.cfg.stallAfterMs ?? 7 * 60 * 1000; }
  get verifyAfterMs() { return this.cfg.verifyAfterMs ?? 5 * 60 * 1000; }
  get retryDelayMs() { return this.cfg.retryDelayMs ?? 60000; }
  get maxAttempts() { return this.cfg.maxAttempts ?? 3; }
  get resumeMessage() { return this.cfg.resumeMessage || 'Continue'; }

  // Returns matching rule or null. text = haystack (raw line + extracted msg).
  match(text) {
    if (!text) return null;
    const hay = text.toLowerCase();
    for (const r of this.compiled) {
      if ((r.contains || []).some(c => hay.includes(c.toLowerCase()))) return r;
      if (r._re.some(re => re.test(text))) return r;
    }
    return null;
  }

  extractReset(rule, text) {
    if (!rule || !rule._resetRe) return null;
    const m = rule._resetRe.exec(text);
    if (!m) return null;
    const raw = m[1].trim();
    // epoch ms
    if (/^\d{13}$/.test(raw)) return new Date(parseInt(raw, 10));
    // ISO-ish
    const iso = Date.parse(raw);
    if (!isNaN(iso)) return new Date(iso);
    // "6:34 AM" style — today or tomorrow
    const t = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(raw);
    if (t) {
      const now = new Date();
      let h = parseInt(t[1], 10);
      const mer = (t[3] || '').toLowerCase();
      if (mer === 'pm' && h < 12) h += 12;
      if (mer === 'am' && h === 12) h = 0;
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, parseInt(t[2], 10));
      if (d <= now) d.setDate(d.getDate() + 1);
      return d;
    }
    return null;
  }
}

module.exports = { Rules };
