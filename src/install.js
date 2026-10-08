'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

// One-command install: register agentwatch to auto-start on login AND launch it
// now. Three platforms: Windows (schtasks + .bat shim), Linux (systemd --user,
// cron @reboot fallback), macOS (launchd plist). `install --uninstall` reverts.

function watchArgs(extra = []) {
  const a = ['watch', '--serve'];
  for (const [k, v] of extra) if (v) a.push(k, String(v));
  return a;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

function startNow(nodeBin, cliJs, logFile, log, watchArgsArr) {
  // Detached child so the watchdog survives this process exiting.
  const out = fs.openSync(logFile, 'a');
  const child = spawn(nodeBin, [cliJs, ...watchArgsArr], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  log(`started watchdog (pid ${child.pid}), log: ${logFile}`);
}

function install({ nodeBin, cliJs, stateDir, extra = [], log }) {
  const logFile = path.join(stateDir, 'agentwatch.log');
  const p = process.platform;
  const WATCH_ARGS = watchArgs(extra);

  if (p === 'win32') {
    // .bat shim keeps schtasks /tr quoting trivial and adds log redirection.
    const bat = path.join(stateDir, 'agentwatch-start.bat');
    fs.writeFileSync(bat, `@echo off\r\n"${nodeBin}" "${cliJs}" ${WATCH_ARGS.join(' ')} >> "${logFile}" 2>&1\r\n`);
    const r = run('schtasks', ['/create', '/tn', 'agentwatch', '/tr', `"${bat}"`, '/sc', 'onlogon', '/rl', 'limited', '/f']);
    if (!r.ok) return { ok: false, error: 'schtasks: ' + r.out.trim() };
    log('registered logon task "agentwatch" (schtasks)');
    // Launch the .bat detached right now too.
    const child = spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', shell: false });
    child.unref();
    log('watchdog started');
    return { ok: true, how: 'schtasks', logFile };
  }

  if (p === 'darwin') {
    const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plist = path.join(plistDir, 'ai.agentwatch.plist');
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ai.agentwatch</string>
<key>ProgramArguments</key><array><string>${nodeBin}</string><string>${cliJs}</string>${WATCH_ARGS.map(a => `<string>${a}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${logFile}</string><key>StandardErrorPath</key><string>${logFile}</string>
</dict></plist>`);
    run('launchctl', ['unload', plist]); // reload idempotently
    const r = run('launchctl', ['load', plist]);
    if (!r.ok) return { ok: false, error: 'launchctl: ' + r.out.trim() };
    log(`launchd agent installed & loaded (${plist})`);
    return { ok: true, how: 'launchd', logFile };
  }

  // linux/bsd: systemd user unit preferred
  if (run('systemctl', ['--user', '--version']).ok) {
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const unit = path.join(unitDir, 'agentwatch.service');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unit, `[Unit]\nDescription=agentwatch codex watchdog\nAfter=default.target\n\n[Service]\nExecStart=${nodeBin} ${cliJs} ${WATCH_ARGS.join(' ')}\nRestart=always\nRestartSec=10\nStandardOutput=append:${logFile}\nStandardError=append:${logFile}\n\n[Install]\nWantedBy=default.target\n`);
    run('systemctl', ['--user', 'daemon-reload']);
    const r = run('systemctl', ['--user', 'enable', '--now', 'agentwatch.service']);
    if (!r.ok) return { ok: false, error: 'systemctl: ' + r.out.trim() };
    log('systemd user service enabled & started');
    return { ok: true, how: 'systemd', logFile };
  }
  const r = run('sh', ['-c', `(crontab -l 2>/dev/null | grep -v agentwatch; echo "@reboot ${nodeBin} ${cliJs} ${WATCH_ARGS.join(' ')} >> ${logFile} 2>&1 # agentwatch") | crontab -`]);
  if (!r.ok) return { ok: false, error: 'no systemd or cron available' };
  startNow(nodeBin, cliJs, logFile, log, WATCH_ARGS);
  return { ok: true, how: 'cron', logFile };
}

function uninstall({ stateDir, log }) {
  const p = process.platform;
  if (p === 'win32') {
    run('schtasks', ['/delete', '/tn', 'agentwatch', '/f']);
    // No cmd shell here — direct powershell.exe so the script's quoting survives.
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'agentwatch|cli\\.js watch' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);
    try { fs.rmSync(path.join(stateDir, 'agentwatch-start.bat')); } catch {}
    return { ok: true };
  }
  if (p === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.agentwatch.plist');
    run('launchctl', ['unload', plist]);
    try { fs.rmSync(plist); } catch {}
    run('pkill', ['-f', 'agentwatch.*watch']);
    return { ok: true };
  }
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'agentwatch.service');
  if (fs.existsSync(unit)) {
    run('systemctl', ['--user', 'disable', '--now', 'agentwatch.service']);
    try { fs.rmSync(unit); } catch {}
    run('systemctl', ['--user', 'daemon-reload']);
  }
  run('sh', ['-c', "crontab -l 2>/dev/null | grep -v agentwatch | crontab -"]);
  run('pkill', ['-f', 'cli.js watch']);
  return { ok: true };
}

module.exports = { install, uninstall };
