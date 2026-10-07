'use strict';
// E2E test: synthetic rollout files + fake `codex` shim -> assert the full
// detect -> schedule -> resume -> verify -> notify chain, plus fail-closed
// and give-up paths. No real Codex needed.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { Rules } = require('../src/rules');
const { SessionMonitor } = require('../src/monitor');
const { Recover } = require('../src/recover');
const { Notifier } = require('../src/notify');
const { State } = require('../src/state');

const TID1 = '11111111-2222-4333-8444-555555555555';
const TID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-')); }

function rollout(codexHome, tid) {
  const dir = path.join(codexHome, 'sessions', '2026', '10', '07');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-2026-10-07T03-00-00-${tid}.jsonl`);
}

function append(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

const testRules = {
  pollIntervalMs: 50, stallAfterMs: 120, verifyAfterMs: 120, retryDelayMs: 40, maxAttempts: 2,
  resumeMessage: 'Continue', goalResumeMessage: '/goal resume', recoveryMethod: 'auto',
  stall: { enabled: true, action: 'queue', message: 'Continue' },
  rules: [
    { name: 'usage_limit', contains: ['usage limit'], extractReset: 'try again at ([^\"]+)', action: 'wait_reset', fallbackDelayMs: 80 },
    { name: 'permanent_error', contains: ['model_not_found', '无可用渠道', 'authentication failed'], action: 'notify' },
    { name: 'stream_disconnected', contains: ['stream disconnected before completion'], action: 'queue', delayMs: 50 },
    { name: 'goal_usage_limited', contains: ['usagelimited'], action: 'queue', message: '/goal resume', delayMs: 30 },
    { name: 'never_retry', contains: ['cancelled by user'], action: 'ignore' },
  ],
};

const PY_MKDB = `
import sqlite3, sys, os, time
home = sys.argv[1]
con = sqlite3.connect(os.path.join(home, 'logs_2.sqlite'))
con.execute("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, ts TEXT, level TEXT, target TEXT, feedback_log_body TEXT, thread_id TEXT)")
con.execute("INSERT INTO logs (ts, level, thread_id, feedback_log_body) VALUES (datetime('now'), 'ERROR', ?, ?)", (sys.argv[2], sys.argv[3]))
con.commit(); con.close()
con = sqlite3.connect(os.path.join(home, 'goals_1.sqlite'))
con.execute("CREATE TABLE IF NOT EXISTS thread_goals (thread_id TEXT, goal_id TEXT, status TEXT, tokens_used INT, token_budget INT)")
con.execute("INSERT INTO thread_goals VALUES (?, 'g1', 'usageLimited', 100, 1000)", (sys.argv[4],))
con.commit(); con.close()
con = sqlite3.connect(os.path.join(home, 'state_5.sqlite'))
con.execute("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT, updated_at_ms INT, recency_at_ms INT, tokens_used INT, source TEXT)")
old = int(time.time()*1000)-60000
con.execute("INSERT OR REPLACE INTO threads VALUES (?, 't', ?, ?, 0, 'app')", (sys.argv[5], old, old))
con.execute("INSERT OR REPLACE INTO threads VALUES (?, 't', ?, ?, 0, 'exec')", (sys.argv[7], old, old))
con.commit(); con.close()
con = sqlite3.connect(os.path.join(home, 'thread_history_1.sqlite'))
con.execute("CREATE TABLE IF NOT EXISTS thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, error_json TEXT, started_at TEXT, completed_at TEXT)")
con.execute("INSERT INTO thread_turns VALUES (?, 'turn-fail', 'failed', ?, datetime('now'), datetime('now'))", (sys.argv[6], sys.argv[8]))
con.execute("INSERT INTO thread_turns VALUES (?, 'turn-orphan', 'inProgress', '', datetime('now','-1 hour'), '')", (sys.argv[7],))
con.commit(); con.close()
`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
let passed = 0, failed = 0;
function ok(cond, name) { if (cond) { passed++; console.log('  ok', name); } else { failed++; console.log('  FAIL', name); } }

async function main() {
  const tmp = mkTmp();
  const codexHome = path.join(tmp, '.codex');
  const stateDir = path.join(tmp, '.agentwatch');
  const rulesFile = path.join(tmp, 'rules.json');
  fs.writeFileSync(rulesFile, JSON.stringify(testRules));
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });

  // fake codex shim: logs every invocation
  const callsLog = path.join(tmp, 'calls.log');
  const binDir = path.join(tmp, 'bin'); fs.mkdirSync(binDir);
  const shimPath = path.join(binDir, 'codex.cmd');
  fs.writeFileSync(shimPath, `@echo off\r\necho %*>> "${callsLog.replace(/\\/g, '\\\\')}"\r\n`);

  const rules = new Rules(rulesFile);
  const monitor = new SessionMonitor(codexHome);
  const state = new State(stateDir);
  const notifier = new Notifier({ quiet: true });
  const recover = new Recover({ rules, state, notifier, codexBin: shimPath, dryRun: false, log: () => {} });

  console.log('== stream disconnect -> queue -> recovered ==');
  const f1 = rollout(codexHome, TID1);
  append(f1, { timestamp: '2026-10-07T03:00:00Z', type: 'session_meta', payload: { id: TID1 } });
  monitor.poll(); // establish baseline offset
  append(f1, { timestamp: '2026-10-07T03:10:00Z', type: 'event_msg', payload: { type: 'error', message: 'stream disconnected before completion: stream closed before response.completed' } });
  for (const ev of monitor.poll()) {
    recover.onActivity(ev.threadId);
    const rule = rules.match(SessionMonitor.haystack(ev));
    if (rule) recover.onFailure(ev.threadId, rule, SessionMonitor.haystack(ev));
  }
  ok(state.t(TID1).status === 'scheduled', 'stream disconnect scheduled');
  ok(state.t(TID1).lastRule === 'stream_disconnected', 'rule name recorded');
  await sleep(120); await recover.tick(monitor);
  await sleep(120); // let shim exit
  const calls = fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf8') : '';
  ok(calls.includes(`--thread ${TID1}`), 'codex queue called with exact thread UUID');
  ok(calls.includes('--message Continue'), 'resume message sent');
  ok(state.t(TID1).status === 'verifying', 'verifying after fire');
  // simulate the thread coming back to life
  append(f1, { timestamp: '2026-10-07T03:11:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1234 } } } });
  for (const ev of monitor.poll()) recover.onActivity(ev.threadId);
  ok(state.t(TID1).status === 'ok', 'recovered to ok on activity');
  ok(notifier.log.some(n => n.text.includes('recovered')), 'recovery notification emitted');

  console.log('== usage limit -> wait_reset -> fires when due ==');
  const f2 = rollout(codexHome, TID2);
  append(f2, { timestamp: '2026-10-07T04:00:00Z', type: 'session_meta', payload: { id: TID2 } });
  monitor.poll();
  const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  append(f2, { timestamp: '2026-10-07T04:10:00Z', type: 'event_msg', payload: { type: 'error', message: `You've hit your usage limit. try again at ${past}` } });
  for (const ev of monitor.poll()) {
    const rule = rules.match(SessionMonitor.haystack(ev));
    if (rule) recover.onFailure(ev.threadId, rule, SessionMonitor.haystack(ev));
  }
  const st2 = state.t(TID2);
  ok(st2.status === 'scheduled' && st2.lastRule === 'usage_limit', 'usage limit scheduled');
  ok(st2.scheduledAt <= Date.now(), 'reset time extracted (past+grace -> due now)');
  await sleep(50); await recover.tick(monitor); await sleep(100);
  const calls2 = fs.readFileSync(callsLog, 'utf8');
  ok(calls2.includes(`--thread ${TID2}`), 'usage-limit resume fired for thread 2');

  console.log('== permanent config error -> notify, no retry ==');
  const f1b = f1;
  append(f1b, { timestamp: '2026-10-07T05:00:00Z', type: 'event_msg', payload: { type: 'error', message: 'authentication failed: invalid api key' } });
  const before = fs.readFileSync(callsLog, 'utf8').length;
  for (const ev of monitor.poll()) {
    recover.onActivity(ev.threadId);
    const rule = rules.match(SessionMonitor.haystack(ev));
    if (rule) recover.onFailure(ev.threadId, rule, SessionMonitor.haystack(ev));
  }
  await sleep(80); await recover.tick(monitor); await sleep(80);
  ok(fs.readFileSync(callsLog, 'utf8').length === before, 'no queue call for permanent error');
  ok(state.t(TID1).status === 'notify', 'permanent error alerted via notify');
  ok(notifier.log.some(n => n.text.includes('permanent_error')), 'permanent error notification emitted');
  // user-cancelled work stays silent (fail-closed)
  const f1c = f1;
  append(f1c, { timestamp: '2026-10-07T05:05:00Z', type: 'event_msg', payload: { type: 'error', message: 'cancelled by user' } });
  for (const ev of monitor.poll()) {
    const rule = rules.match(SessionMonitor.haystack(ev));
    if (rule) recover.onFailure(ev.threadId, rule, SessionMonitor.haystack(ev));
  }
  ok(fs.readFileSync(callsLog, 'utf8').length === before, 'no queue call for user cancel');

  console.log('== stall detection -> queue -> give up path ==');
  const TID3 = 'cccccccc-dddd-4eee-8fff-000000000000';
  const f3 = rollout(codexHome, TID3);
  append(f3, { timestamp: '2026-10-07T05:30:00Z', type: 'session_meta', payload: { id: TID3 } });
  append(f3, { timestamp: '2026-10-07T05:30:10Z', type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: '{}' } });
  monitor.poll();
  await sleep(140); // exceeds stallAfterMs=120, no terminal/error in last line
  for (const s of monitor.stalledThreads(rules.stallAfterMs)) {
    if (s.threadId === TID3) recover.onStall(s.threadId, rules.cfg.stall, s.idleMs);
  }
  ok(state.t(TID3).status === 'scheduled', 'stall detected & scheduled');
  // fire, verify-fail, retry, verify-fail -> attempts=2=max -> dead
  for (let i = 0; i < 5; i++) {
    await sleep(140); await recover.tick(monitor);
  }
  await sleep(100);
  ok(state.t(TID3).status === 'dead', 'gave up after maxAttempts');
  ok(notifier.log.some(n => n.text.includes('GAVE UP') && n.text.includes(TID3.slice(0, 8))), 'escalation notification emitted for TID3');

  console.log('== dbwatch: sqlite signals ==');
  const { DbWatch } = require('../src/dbwatch');
  const TID4 = 'eeeeeeee-1111-4222-8333-444444444444';
  const TID5 = '55555555-6666-4777-8888-999999999999';
  if (new DbWatch(codexHome).pyBin) {
    const TID6 = '66666666-7777-4888-8999-000000000000'; // failed turn (model_not_found)
    const TID7 = '77777777-8888-4999-8000-111111111111'; // orphan inProgress turn, exec source
    execFileSync('python', ['-c', PY_MKDB, codexHome, TID4, 'stream disconnected before completion: boom', TID5, TID4, TID6, TID7, 'model_not_found: no channel'], { timeout: 15000 });
    const dbwatch = new DbWatch(codexHome);
    const recover2 = new Recover({ rules, state, notifier, codexBin: shimPath, dryRun: false, log: () => {}, sourceOf: tid => dbwatch.sourceOf(tid) });
    let dbev = dbwatch.poll();
    ok(dbev.events.some(e => e.kind === 'log' && e.threadId === TID4), 'logs_2 ERROR row detected for thread');
    ok(dbev.events.some(e => e.kind === 'goal' && e.threadId === TID5 && /usageLimited/i.test(e.status)), 'goal usageLimited detected');
    ok(dbev.events.some(e => e.kind === 'log' && e.threadId === TID6 && /model_not_found/.test(e.text)), 'failed turn error_json detected');
    for (const ev of dbev.events) {
      if (ev.kind === 'thread') { recover2.onActivity(ev.threadId); continue; }
      const rule = rules.match(ev.text);
      if (rule) recover2.onFailure(ev.threadId, rule, ev.text);
    }
    ok(state.t(TID4).status === 'scheduled', 'db log failure scheduled');
    ok(state.t(TID5).status === 'scheduled' && state.t(TID5).message === '/goal resume', 'goal resume message scheduled');
    ok(state.t(TID6).status === 'notify', 'model_not_found turn -> notify not retry');
    // orphan turn (inProgress + idle thread) -> stall -> exec-resume routed
    const orphans = dbwatch.orphanTurns(rules.stallAfterMs);
    ok(orphans.some(o => o.threadId === TID7), 'orphan inProgress turn detected');
    for (const o of orphans) if (o.threadId === TID7) recover2.onStall(o.threadId, rules.cfg.stall, o.idleMs);
    await sleep(140); await recover2.tick(monitor); await sleep(500); // shim file-append races assertions
    const calls3 = fs.readFileSync(callsLog, 'utf8');
    ok(calls3.includes(`--thread ${TID4}`) && calls3.includes(`--thread ${TID5}`), 'db-driven resumes fired');
    ok(calls3.includes('/goal resume'), 'goal resume message sent');
    ok(calls3.includes(`exec resume ${TID7}`), 'exec-source orphan routed to codex exec resume');
    // thread activity via DB -> recovered
    execFileSync('python', ['-c',
      `import sqlite3,sys,time;con=sqlite3.connect(sys.argv[1]+'/state_5.sqlite');con.execute("UPDATE threads SET updated_at_ms=?",(int(time.time()*1000),));con.commit()`,
      codexHome], { timeout: 15000 });
    dbev = dbwatch.poll();
    for (const ev of dbev.events) if (ev.kind === 'thread') recover2.onActivity(ev.threadId);
    ok(state.t(TID4).status === 'ok', 'db activity marks recovery');
  } else {
    console.log('  (skipped: no python)');
  }

  console.log('== cli smoke ==');
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), 'scan',
    '--codex-home', codexHome, '--state-dir', stateDir, '--rules', rulesFile, '--codex-bin', shimPath],
    { encoding: 'utf8', timeout: 20000 });
  ok(/thread\(s\) seen/.test(out), 'cli scan prints threads');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
