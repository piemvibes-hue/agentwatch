#!/usr/bin/env node
'use strict';
const path = require('path');
const os = require('os');
const { Rules } = require('./rules');
const { SessionMonitor } = require('./monitor');
const { Recover } = require('./recover');
const { Notifier } = require('./notify');
const { State } = require('./state');

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const name = k.slice(2);
      if (name === 'dry-run' || name === 'verbose' || name === 'once' || name === 'quiet') a[name] = true;
      else a[name] = argv[++i];
    } else a._.push(k);
  }
  return a;
}

function usage() {
  console.log(`agentwatch — watchdog for long-running AI coding agents

  agentwatch watch      Monitor ~/.codex/sessions and auto-resume dead threads
  agentwatch scan       One-shot scan, print thread/failure states, exit
  agentwatch status     Print persisted watchdog state

options:
  --codex-home DIR    Codex home (default ~/.codex)
  --state-dir DIR     Watchdog state dir (default ~/.agentwatch)
  --rules FILE        Rules file (default ./rules.json next to package)
  --codex-bin NAME    codex binary (default "codex" on PATH)
  --webhook URL       POST notifications to a generic webhook
  --ntfy TOPIC        ntfy.sh topic (or full URL) for push notifications
  --dry-run           Detect & schedule but never execute codex queue
  --once              Run one poll cycle (with watch/scan implied)
  --verbose           Log every scanned line's rule result
  --quiet             Only webhook/ntfy, no console notifications
`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0] || 'watch';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return usage();

  const codexHome = a['codex-home'] || path.join(os.homedir(), '.codex');
  const stateDir = a['state-dir'] || path.join(os.homedir(), '.agentwatch');
  const rulesFile = a['rules'] || path.join(__dirname, '..', 'rules.json');

  const rules = new Rules(rulesFile);
  const monitor = new SessionMonitor(codexHome);
  const state = new State(stateDir);
  const notifier = new Notifier({ webhook: a.webhook, ntfy: a.ntfy, quiet: a.quiet });
  const recover = new Recover({ rules, state, notifier, codexBin: a['codex-bin'] || 'codex', dryRun: !!a['dry-run'] });

  async function cycle() {
    rules.reload();
    const events = monitor.poll();
    for (const ev of events) {
      recover.onActivity(ev.threadId);
      const text = SessionMonitor.haystack(ev);
      const rule = rules.match(text);
      if (a.verbose) console.log(`[line] ${ev.threadId.slice(0, 8)}${ev.replay ? ' (replay)' : ''} rule=${rule ? rule.name : '-'}`);
      // Replayed tail lines only count if the file is fresh (avoid reviving
      // weeks-old error banners from long-finished conversations).
      if (rule && !(ev.replay && ev.fileMtime && Date.now() - ev.fileMtime > 24 * 3600 * 1000)) {
        recover.onFailure(ev.threadId, rule, text);
      }
    }
    if (rules.cfg.stall && rules.cfg.stall.enabled) {
      for (const s of monitor.stalledThreads(rules.stallAfterMs)) {
        recover.onStall(s.threadId, rules.cfg.stall, s.idleMs);
      }
    }
    await recover.tick(monitor);
  }

  if (cmd === 'scan') {
    await cycle();
    const threads = monitor.listThreads();
    console.log(`${threads.length} thread(s) seen:`);
    for (const t of threads) {
      const st = state.t(t.threadId);
      console.log(`  ${t.threadId}  ${st.status}  lastLineAt=${t.lastLineAt ? new Date(t.lastLineAt).toISOString() : '-'}`);
    }
    return;
  }

  if (cmd === 'status') {
    console.log(JSON.stringify(state.data, null, 2));
    return;
  }

  if (cmd !== 'watch') { usage(); process.exit(1); }

  console.log(`[agentwatch] watching ${monitor.sessionsDir} every ${rules.pollIntervalMs / 1000}s${a['dry-run'] ? ' [dry-run]' : ''}`);
  if (a.once) { await cycle(); return; }
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try { await cycle(); }
    catch (e) { console.error('[cycle-error]', e.message); }
    await new Promise(r => setTimeout(r, rules.pollIntervalMs));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
