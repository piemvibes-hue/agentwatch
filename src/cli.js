#!/usr/bin/env node
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Rules } = require('./rules');
const { SessionMonitor } = require('./monitor');
const { DbWatch } = require('./dbwatch');
const { Recover } = require('./recover');
const { Notifier } = require('./notify');
const { State } = require('./state');
const { serve } = require('./dashboard');
const { install, uninstall } = require('./install');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const name = k.slice(2);
      if (name === 'dry-run' || name === 'verbose' || name === 'once' || name === 'quiet' || name === 'serve') a[name] = true;
      else a[name] = argv[++i];
    } else a._.push(k);
  }
  return a;
}

function usage() {
  console.log(`agentwatch — watchdog for long-running AI coding agents

  agentwatch watch      Monitor ~/.codex/sessions and auto-resume dead threads
  agentwatch run CMD..  Run a command (e.g. 'agentwatch run codex exec ...')
                        under the watchdog; exits when the command exits
  agentwatch install    One command: auto-start on login + launch now
                        (watch --serve at http://127.0.0.1:8787)
  agentwatch uninstall  Remove the auto-start and stop the watchdog
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
  --serve             Local dashboard at http://127.0.0.1:8787 (with watch)
  --port N            Dashboard port (default 8787)
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
  const dbwatch = new DbWatch(codexHome);
  const state = new State(stateDir);
  const notifier = new Notifier({ webhook: a.webhook, ntfy: a.ntfy, quiet: a.quiet });
  const events = [];
  const log = m => { events.push({ ts: Date.now(), msg: m }); if (events.length > 500) events.shift(); console.log(m); };
  const recover = new Recover({ rules, state, notifier, codexBin: a['codex-bin'] || 'codex', dryRun: !!a['dry-run'], log, sourceOf: tid => dbwatch.sourceOf(tid) });

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
    // Structured layer: ~/.codex SQLite stores (logs/goals/threads).
    const db = dbwatch.poll();
    if (db.disabled && a.verbose) console.log(`[dbwatch] disabled: ${db.disabled}`);
    for (const ev of db.events) {
      if (ev.kind === 'thread') { recover.onActivity(ev.threadId); continue; }
      const rule = rules.match(ev.text);
      if (a.verbose) console.log(`[db:${ev.kind}] ${ev.threadId.slice(0, 8)}${ev.replay ? ' (replay)' : ''} rule=${rule ? rule.name : '-'}`);
      if (rule) recover.onFailure(ev.threadId, rule, ev.text);
    }
    for (const s of dbwatch.staleThreads(rules.stallAfterMs)) {
      recover.onStall(s.threadId, rules.cfg.stall || { action: 'notify' }, s.idleMs);
    }
    // Orphaned inProgress turns (process died mid-turn): the strongest stall
    // signal — the turn row itself is the abandoned work.
    for (const s of dbwatch.orphanTurns(rules.stallAfterMs)) {
      if (a.verbose) console.log(`[db:orphan] ${s.threadId.slice(0, 8)} turn ${s.turnId.slice(0, 8)} idle ${Math.round(s.idleMs / 60000)}min`);
      recover.onStall(s.threadId, rules.cfg.stall || { action: 'notify' }, s.idleMs);
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

  if (cmd === 'install' || cmd === 'uninstall') {
    fs.mkdirSync(stateDir, { recursive: true });
    const cliJs = path.join(__dirname, 'cli.js');
    const fn = cmd === 'install' ? install : uninstall;
    const extra = [['--ntfy', a.ntfy], ['--webhook', a.webhook], ['--port', a.port && Number(a.port) !== 8787 ? a.port : null]];
    const r = fn({ nodeBin: process.execPath, cliJs, stateDir, extra, log });
    if (r.ok) {
      log(cmd === 'install'
        ? `installed via ${r.how} — dashboard http://127.0.0.1:${Number(a.port) || 8787}`
        : 'uninstalled');
    } else {
      console.error(`[install-error] ${r.error}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'run') {
    // Wrap a codex invocation: watchdog in this process, child gets your TTY.
    // `agentwatch run codex exec "task"` or `agentwatch run codex` (TUI).
    const childArgs = a._.slice(1);
    if (!childArgs.length) { usage(); process.exit(1); }
    const bin = childArgs[0] === 'codex' ? (a['codex-bin'] || 'codex') : childArgs[0];
    log(`[agentwatch] supervising: ${childArgs.join(' ')}`);
    if (a.serve) serve({ port: Number(a.port) || 8787, codexHome, dryRun: a['dry-run'], pollMs: rules.pollIntervalMs, monitor, dbwatch, state, events, log, recover });
    let exited = false;
    const child = spawn(bin, childArgs.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', code => {
      exited = true;
      log(`[agentwatch] supervised command exited ${code}; stopping after one final cycle`);
      setTimeout(() => process.exit(code ?? 0), 2000).unref();
    });
    while (!exited) {
      try { await cycle(); }
      catch (e) { log('[cycle-error] ' + e.message); }
      await new Promise(r => setTimeout(r, rules.pollIntervalMs));
    }
    return;
  }

  if (cmd !== 'watch') { usage(); process.exit(1); }

  console.log(`[agentwatch] watching ${monitor.sessionsDir} every ${rules.pollIntervalMs / 1000}s${a['dry-run'] ? ' [dry-run]' : ''}`);
  if (a.serve) serve({ port: Number(a.port) || 8787, codexHome, dryRun: a['dry-run'], pollMs: rules.pollIntervalMs, monitor, dbwatch, state, events, log, recover });
  if (a.once) { await cycle(); return; }
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try { await cycle(); }
    catch (e) { console.error('[cycle-error]', e.message); }
    await new Promise(r => setTimeout(r, rules.pollIntervalMs));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
