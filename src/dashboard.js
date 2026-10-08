'use strict';
const http = require('http');

// Zero-dep status dashboard: `agentwatch watch --serve` exposes a local page
// showing thread states, detection/recovery events, and notification history.

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentwatch</title>
<style>
:root{color-scheme:dark;--bg:#0d1117;--fg:#c9d1d9;--dim:#8b949e;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--line:#21262d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;padding:20px;max-width:1100px;margin:auto}
h1{font-size:18px;display:flex;gap:10px;align-items:center}h1 .dot{width:10px;height:10px;border-radius:50%;background:var(--ok)}
h1 .dot.dry{background:var(--warn)}
.meta{color:var(--dim);font-size:12px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--dim);text-align:left;font-weight:600;border-bottom:1px solid var(--line);padding:6px 8px}
td{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}
.tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;border:1px solid var(--line)}
.t-ok{color:var(--ok)}.t-scheduled,.t-verifying{color:var(--warn)}.t-dead,.t-notify{color:var(--bad)}.t-idle{color:var(--dim)}
h2{font-size:14px;color:var(--dim);margin:24px 0 8px}
#events{max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:12px;white-space:pre-wrap}
button{background:#21262d;color:var(--fg);border:1px solid #30363d;border-radius:5px;font:inherit;font-size:11px;padding:2px 8px;cursor:pointer;margin-right:4px}
button:hover{background:#30363d}
#events div{padding:1px 0}#events .ts{color:var(--dim)}
a{color:#58a6ff;text-decoration:none}
</style></head><body>
<h1><span class="dot" id="dot"></span>agentwatch <span id="mode" style="color:var(--dim);font-size:12px"></span></h1>
<div class="meta" id="meta"></div>
<table><thead><tr><th id="h1">thread</th><th id="h2">title</th><th id="h3">source</th><th id="h4">state</th><th id="h5">last activity</th><th id="h6">recovery</th><th id="h7"></th></tr></thead><tbody id="rows"></tbody></table>
<h2 id="evh">events</h2><div id="events"></div>
<script>
const qlang=new URLSearchParams(location.search).get('lang');
const L=((qlang||navigator.language||'en').toLowerCase().startsWith('zh'))?{
 thread:'线程',title:'标题',source:'来源',state:'状态',lasta:'最近活动',recovery:'恢复',
 watching:'监视中',thr:'个线程',updated:'更新于',events:'事件',empty:'还没有看到线程',
 resume:'续跑于',try:'第',verifying:'验证中… 第',gaveup:'已放弃（',tries:'次）',last:'上次：',
 sa:'秒前',ma:'分钟前',ha:'小时前',da:'天前',
 retry:'重试',ignore:'忽略',unignore:'恢复监听'
}:{
 thread:'thread',title:'title',source:'source',state:'state',lasta:'last activity',recovery:'recovery',
 watching:'watching',thr:'thread(s)',updated:'updated',events:'events',empty:'no threads seen yet',
 resume:'resume ',try:'try ',verifying:'verifying… try ',gaveup:'gave up after ',tries:' tries',last:'last: ',
 sa:'s ago',ma:'m ago',ha:'h ago',da:'d ago',
 retry:'retry',ignore:'ignore',unignore:'un-ignore'
};
['h1','h2','h3','h4','h5','h6','evh'].forEach((id,i)=>document.getElementById(id).textContent=[L.thread,L.title,L.source,L.state,L.lasta,L.recovery,L.events][i]);
async function act(thread,action){await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({thread,action})});tick()}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=ms=>{if(!ms)return'-';const s=Math.max(0,Math.round((Date.now()-ms)/1000));return s<60?s+L.sa:s<3600?Math.round(s/60)+L.ma:s<86400?Math.round(s/3600)+L.ha:Math.round(s/86400)+L.da};
async function tick(){try{
const r=await fetch('/api/status');const d=await r.json();
document.getElementById('dot').className='dot'+(d.dryRun?' dry':'');
document.getElementById('mode').textContent=d.dryRun?'dry-run':'';
document.getElementById('meta').textContent=L.watching+' '+d.codexHome+' · poll '+Math.round(d.pollMs/1000)+'s · '+d.threads.length+' '+L.thr+' · '+L.updated+' '+new Date().toLocaleTimeString();
document.getElementById('rows').innerHTML=d.threads.map(t=>{
 const rec=t.status==='scheduled'?L.resume+new Date(t.scheduledAt).toLocaleTimeString()+' · '+L.try+t.attempts
  :t.status==='verifying'?L.verifying+t.attempts
  :t.status==='dead'?L.gaveup+t.attempts+L.tries
  :t.lastRule?(L.last+t.lastRule):'-';
 const btns='<button onclick="act(\\''+t.id+'\\',\\'retry\\')">'+L.retry+'</button>'
  +(t.status==='ignored'?'<button onclick="act(\\''+t.id+'\\',\\'unignore\\')">'+L.unignore+'</button>'
    :'<button onclick="act(\\''+t.id+'\\',\\'ignore\\')">'+L.ignore+'</button>');
 return '<tr><td>'+esc(t.id.slice(0,13))+'</td><td>'+esc(t.title||'')+'</td><td>'+esc(t.source||'')+'</td>'
  +'<td><span class="tag t-'+esc(t.status)+'">'+esc(t.status)+'</span></td><td>'+ago(t.lastActivity)+'</td><td>'+esc(rec)+'</td><td>'+btns+'</td></tr>'}).join('')||'<tr><td colspan=7 style="color:var(--dim)">'+L.empty+'</td></tr>';
document.getElementById('events').innerHTML=d.events.slice(-200).reverse().map(e=>'<div><span class="ts">'+new Date(e.ts).toLocaleTimeString()+'</span> '+esc(e.msg)+'</div>').join('');
}catch(e){document.getElementById('meta').textContent='watchdog unreachable? '+e}}
tick();setInterval(tick,3000);
</script></body></html>`;

function serve({ port, codexHome, dryRun, pollMs, monitor, dbwatch, state, events, log, recover }) {
  const api = (res) => {
    // Merge threads seen via rollout files, sqlite stores, and persisted state.
    const rows = new Map();
    const put = (id, extra = {}) => {
      const cur = rows.get(id) || { id, title: '', source: '', lastActivity: 0 };
      rows.set(id, Object.assign(cur, extra));
    };
    for (const t of monitor.listThreads()) put(t.threadId, { lastActivity: t.lastLineAt || 0 });
    for (const [tid, ms] of dbwatch.threadSeen) {
      put(tid, { source: dbwatch.threadSource.get(tid) || '', title: dbwatch.threadTitle.get(tid) || '', lastActivity: Math.max(rows.get(tid)?.lastActivity || 0, ms || 0) });
    }
    for (const tid of Object.keys(state.data.threads)) put(tid);
    const threads = [...rows.values()].map(t => {
      const st = state.t(t.id);
      return { ...t, status: st.status, lastRule: st.lastRule, attempts: st.attempts,
               scheduledAt: st.scheduledAt, verifyUntil: st.verifyUntil || null };
    }).sort((a, b) => b.lastActivity - a.lastActivity);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ now: Date.now(), codexHome, dryRun: !!dryRun, pollMs, threads, events }));
  };
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/api/action') && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          const { thread, action } = JSON.parse(body);
          if (!/^\S+$/.test(thread || '') || thread.length > 64) throw new Error('bad thread');
          if (action === 'retry') { recover.retryNow(thread); log(`[action] manual retry ${thread.slice(0, 8)}`); }
          else if (action === 'ignore') { recover.setIgnored(thread, true); }
          else if (action === 'unignore') { recover.setIgnored(thread, false); }
          else throw new Error('bad action');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
        }
      });
      return;
    }
    if (req.url.startsWith('/api/status')) return api(res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  srv.on('error', e => {
    // A busy dashboard port must never kill the watchdog itself.
    log(`[serve] dashboard unavailable (${e.code || e.message}) — watchdog keeps running`);
  });
  srv.listen(port, '127.0.0.1', () => log(`[serve] dashboard http://127.0.0.1:${port}`));
  return srv;
}

module.exports = { serve };
