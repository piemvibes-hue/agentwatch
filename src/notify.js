'use strict';
const http = require('http');
const https = require('https');

function post(urlStr, body) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const req = lib.request({
        method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: 10000,
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(-1));
      req.on('timeout', () => { req.destroy(); resolve(-1); });
      req.write(data); req.end();
    } catch { resolve(-1); }
  });
}

class Notifier {
  // opts: { webhook, ntfy, quiet }
  constructor(opts = {}) {
    this.webhook = opts.webhook || process.env.AGENTWATCH_WEBHOOK || null;
    this.ntfy = opts.ntfy || process.env.AGENTWATCH_NTFY || null;
    this.quiet = !!opts.quiet;
    this.log = [];
  }

  async send(title, detail = '') {
    const text = detail ? `${title} — ${detail}` : title;
    const entry = { at: new Date().toISOString(), text };
    this.log.push(entry);
    if (!this.quiet) console.log(`[notify] ${text}`);
    const jobs = [];
    if (this.ntfy) {
      const u = this.ntfy.startsWith('http') ? this.ntfy : `https://ntfy.sh/${this.ntfy}`;
      jobs.push(post(u, text));
    }
    if (this.webhook) jobs.push(post(this.webhook, { text, title, detail, source: 'agentwatch' }));
    await Promise.all(jobs);
  }
}

module.exports = { Notifier };
