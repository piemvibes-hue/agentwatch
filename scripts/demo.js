'use strict';
// Demo: runs the REAL `cli.js watch` against a synthetic ~/.codex so the whole
// detect -> route -> resume -> verify -> recovered loop plays out on camera in
// ~45s. The fake `codex` shim makes resumed threads produce new rollout lines
// and bumps threads.updated_at_ms — exactly like a real `codex exec resume`.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { DbWatch } = require('../src/dbwatch');

const TID1 = 'deadbeef-0001-4aaa-8000-0000000000e1'; // exec thread: orphan corpse
const TID2 = 'cafef00d-0002-4aaa-8000-0000000000e2'; // app thread: stream disconnect

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-demo-'));
const codexHome = path.join(tmp, '.codex');
const stateDir = path.join(tmp, '.agentwatch');
const sessDir = path.join(codexHome, 'sessions', '2026', '10', '08');
fs.mkdirSync(sessDir, { recursive: true });

const rulesFile = path.join(tmp, 'rules.json');
fs.writeFileSync(rulesFile, JSON.stringify({
  pollIntervalMs: 500, stallAfterMs: 2500, verifyAfterMs: 8000,
  retryDelayMs: 2000, maxAttempts: 3,
  resumeMessage: 'Continue', goalResumeMessage: '/goal resume', recoveryMethod: 'auto',
  stall: { enabled: true, action: 'queue', message: 'Continue' },
  rules: [
    { name: 'stream_disconnected', contains: ['stream disconnected before completion'], action: 'queue', delayMs: 500 },
    { name: 'permanent_error', contains: ['model_not_found'], action: 'notify' },
    { name: 'never_retry', contains: ['cancelled by user'], action: 'ignore' },
  ],
}));

// bump.py: mark the thread row fresh + close the orphan turn, like real codex
// does after an `exec resume` completes a turn.
const binDir = path.join(tmp, 'bin'); fs.mkdirSync(binDir);
const bumpPy = path.join(binDir, 'bump.py');
fs.writeFileSync(bumpPy, [
  'import sqlite3, os, sys, time',
  'home, tid = sys.argv[1], sys.argv[2]',
  'now = int(time.time() * 1000)',
  'c = sqlite3.connect(os.path.join(home, "state_5.sqlite"))',
  'c.execute("UPDATE threads SET updated_at_ms=?, recency_at_ms=? WHERE id=?", (now, now, tid))',
  'c.commit(); c.close()',
  'c = sqlite3.connect(os.path.join(home, "thread_history_1.sqlite"))',
  'c.execute("UPDATE thread_turns SET status=\'completed\', completed_at=datetime(\'now\') WHERE thread_id=? AND status=\'inProgress\'", (tid,))',
  'c.commit(); c.close()',
].join('\n'));

// fake codex shim: `queue` parks the message (dead mailbox — no surface open);
// `exec resume <tid>` makes the thread produce activity + bumps the thread row,
// like the real one.
const shimJs = path.join(binDir, 'codex-shim.js');
fs.writeFileSync(shimJs, `'use strict';
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const home=process.env.DEMO_CODEX_HOME;
const bump=${JSON.stringify(bumpPy)};
const a=process.argv.slice(2);
console.log('  $ codex '+a.join(' '));
function rolloutFor(tid){const base=path.join(home,'sessions');
  function*walk(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);
    if(fs.statSync(p).isDirectory())yield*walk(p);else if(f.includes(tid))yield p;}}
  for(const p of walk(base))return p;return null;}
function bumpDb(tid){for(const py of['python','python3','py']){
  const r=spawnSync(py,[bump,home,tid],{encoding:'utf8'});if(!r.error)return;}}
if(a[0]==='exec'&&a[1]==='resume'){
  const f=rolloutFor(a[2]);
  console.log('  [codex] resuming thread '+a[2].slice(0,8)+' ...');
  bumpDb(a[2]);
  let i=0;
  const t=setInterval(()=>{
    const last=i>=2;
    fs.appendFileSync(f,JSON.stringify({timestamp:new Date().toISOString(),
      type:'event_msg',payload:last?{type:'task_complete'}:{type:'token_count',info:{total_token_usage:{total_tokens:4000+i}}}})+'\\n');
    if(last){clearInterval(t);bumpDb(a[2]);console.log('  [codex] turn completed');process.exit(0);}i++;},900);
}else if(a[0]==='queue'){
  console.log('  [codex] queued for '+a[a.indexOf('--thread')+1].slice(0,8)+' — no live surface holds this thread, will sit unread');
  process.exit(0);
}else{console.log('  [codex] unknown');process.exit(0);}
`);
const isWin = process.platform === 'win32';
const codexBin = path.join(binDir, isWin ? 'codex.cmd' : 'codex');
fs.writeFileSync(codexBin, isWin
  ? `@echo off\r\nnode "${shimJs}" %*\r\n`
  : `#!/bin/sh\nexec node "${shimJs}" "$@"\n`);
if (!isWin) fs.chmodSync(codexBin, 0o755);

const f1 = path.join(sessDir, `rollout-2026-10-08T03-00-00-${TID1}.jsonl`);
const f2 = path.join(sessDir, `rollout-2026-10-08T04-00-00-${TID2}.jsonl`);
fs.writeFileSync(f1, JSON.stringify({ timestamp: '2026-10-08T03:00:00Z', type: 'session_meta', payload: { id: TID1 } }) + '\n');
fs.writeFileSync(f2, JSON.stringify({ timestamp: '2026-10-08T04:00:00Z', type: 'session_meta', payload: { id: TID2 } }) + '\n');

// sqlite stores: TID1 = exec-source thread with an orphaned inProgress turn (died 3am)
const py = new DbWatch(codexHome).pyBin;
if (py) {
  execFileSync(py, ['-c', `
import sqlite3, os
h = ${JSON.stringify(codexHome)}
c = sqlite3.connect(os.path.join(h,'state_5.sqlite'))
c.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, updated_at_ms INT, recency_at_ms INT, tokens_used INT, source TEXT)")
c.execute("INSERT INTO threads VALUES ('${TID1}','overnight refactor', strftime('%s','now','-3 hours')*1000, strftime('%s','now','-3 hours')*1000, 0, 'exec')")
c.execute("INSERT INTO threads VALUES ('${TID2}','desktop chat', strftime('%s','now','-2 hours')*1000, strftime('%s','now','-2 hours')*1000, 0, 'vscode')")
c.commit(); c.close()
c = sqlite3.connect(os.path.join(h,'thread_history_1.sqlite'))
c.execute("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, error_json TEXT, started_at TEXT, completed_at TEXT)")
c.execute("INSERT INTO thread_turns VALUES ('${TID1}','turn-dead','inProgress','', datetime('now','-3 hours'), '')")
c.commit(); c.close()
`], { timeout: 15000 });
}

console.log('\n  scenario: two codex threads died overnight — an exec run killed mid-turn');
console.log('  and a desktop thread cut by a stream disconnect. agentwatch just woke up.\n');
console.log('  ─────────────────────────────────────────────────────────────\n');

const child = spawn(process.execPath, [
  path.join(__dirname, '..', 'src', 'cli.js'), 'watch', '--verbose',
  '--codex-home', codexHome, '--state-dir', stateDir,
  '--rules', rulesFile, '--codex-bin', codexBin,
], { stdio: 'inherit', env: { ...process.env, DEMO_CODEX_HOME: codexHome } });

// thread 2's stream drops 3s in (a live failure event, not a replayed corpse)
setTimeout(() => {
  fs.appendFileSync(f2, JSON.stringify({
    timestamp: new Date().toISOString(), type: 'event_msg',
    payload: { type: 'error', message: 'stream disconnected before completion: stream closed before response.completed' },
  }) + '\n');
}, 3000);

setTimeout(() => {
  console.log('\n  ─────────────────────────────────────────────────────────────');
  console.log('  both threads rescued: exec corpse via `codex exec resume`,');
  console.log('  dead-queue message auto-fell-back to exec-resume. done.');
  child.kill();
  process.exit(0);
}, 50000);
