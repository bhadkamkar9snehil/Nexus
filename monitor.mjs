import { createServer } from 'node:http';
import { readFile, open, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { runtimeStatus } from './runtime-status.mjs';
import { events, startWebhook, webhookPort } from './webhook.mjs';

const execute = promisify(execFile);
const node = process.execPath;
const port = Number(process.env.NEXUS_MONITOR_PORT || 8769);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid monitor port');
const origin = `http://127.0.0.1:${port}`;
async function inspect(tool) {
  const { stdout } = await execute(node, [join(import.meta.dirname, 'jev-use/cli.mjs'), tool], {
    windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024, env:{...process.env,HARNESS_MONITOR_OBSERVATION:'1'},
  }).catch(error => {
    // CLI exit 2 is a valid blocked result.
    if (error.code !== 2 || JSON.parse(error.stdout || 'null')?.status !== 'blocked') throw error;
    return { stdout: error.stdout };
  });
  return JSON.parse(stdout);
}
let catalog;
let healthCheck;
let runtimeCheck;
let runtimeAt=0;
const assets = Object.fromEntries(['app.js','app.css','geist.woff2','geist-mono.woff2'].map(name => ['/assets/' + name, new URL('./monitor-ui/dist/' + name, import.meta.url)]));

const html = await readFile(new URL('./monitor.html', import.meta.url));
const log = new URL('./runs.jsonl', import.meta.url);

async function recentRuns() {
  let file;
  try { file = await open(log); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const { size } = await file.stat();
    const offset = Math.max(0, size - 256 * 1024);
    const bytes = Buffer.alloc(size - offset);
    await file.read(bytes, 0, bytes.length, offset);
    const rows = new Map();
    for (const line of bytes.toString('utf8').split('\n').slice(offset ? 1 : 0)) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        const first = rows.get(row.id);
        rows.set(row.id, { ...row, started: first?.started ?? row.at - (row.ms ?? 0) });
      } catch { /* An incomplete last line will appear on the next refresh. */ }
    }
    return [...rows.values()].sort((a, b) => b.started - a.started).slice(0, 500);
  } finally {
    await file.close();
  }
}

createServer(async (req, res) => {
  const send = (status, type, body) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  if (req.headers.host !== `127.0.0.1:${port}` || req.method !== 'GET') return send(403, 'text/plain', 'Forbidden');
  if (req.url === '/monitor-status') return send(200, 'application/json', JSON.stringify({ application: 'shared-computer-use-monitor', root: import.meta.dirname, pid: process.pid,managed:process.env.HARNESS_MONITOR_MANAGED==='1' }));
  if (req.url === '/runtime') {
    try {
      if (!runtimeCheck || Date.now()-runtimeAt>30000) {
        runtimeAt=Date.now();
        runtimeCheck=runtimeStatus(inspect).catch(error=>{runtimeCheck=undefined;throw error;});
      }
      return send(200,'application/json',JSON.stringify(await runtimeCheck));
    } catch {return send(503,'text/plain','Runtime observations unavailable. The monitor remains online.');}
  }
  if (req.url === '/webhook-events') return send(200, 'application/json', JSON.stringify({ port: webhookPort, events }));
  if (req.url === '/sessions') {
    try {
      const result = await inspect('list_sessions');
      return send(200, 'application/json', JSON.stringify({sessions: result.sessions.map(s => ({
        session_id: s.session_id, pid: s.pid, shell: s.shell, state: s.state,
        started_at: s.started_at, ended_at: s.ended_at, exit_code: s.exit_code,
      }))}));
    } catch { return send(503, 'text/plain', 'Terminal sessions unavailable.'); }
  }
  if (new URL(req.url, origin).pathname === '/') return send(200, 'text/html; charset=utf-8', html);
  if (req.url === '/favicon.ico') return send(204, 'image/x-icon', '');
  if (Object.hasOwn(assets, req.url)) {
    const type = req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'font/woff2';
    try { return send(200, type, await readFile(assets[req.url])); }
    catch { return send(503, 'text/plain', 'Monitor assets missing. Run node monitor-ui/build.mjs.'); }
  }
  if (req.url === '/docs/USAGE.md' || req.url === '/docs/AGENTS.md') {
    try { return send(200, 'text/plain; charset=utf-8', await readFile(new URL('./' + req.url.slice(6), import.meta.url))); }
    catch { return send(404, 'text/plain', 'Guide unavailable'); }
  }
  if (req.url === '/tools' || req.url === '/health') {
    try {
      if (req.url === '/tools') {
        catalog ??= inspect('tools').catch(error => { catalog = undefined; throw error; });
        return send(200, 'application/json', JSON.stringify(await catalog));
      }
      healthCheck ??= inspect('search_status').finally(() => { healthCheck = undefined; });
      return send(200, 'application/json', JSON.stringify(await healthCheck));
    } catch { return send(503, 'text/plain', 'Harness inspection failed. Check launcher and runtime dependencies.'); }
  }
  if (req.url !== '/runs') return send(404, 'text/plain', 'Not found');
  try { send(200, 'application/json', JSON.stringify(await recentRuns())); }
  catch { send(500, 'text/plain', 'Could not read the run log'); }
}).listen(port, '127.0.0.1', async () => {
  console.log('Computer & Browser Use Monitor: ' + origin);
  startWebhook(import.meta.dirname).catch(e => console.error('Webhook receiver not started: ' + e.message));
  const session=process.env.HARNESS_MONITOR_SESSION;
  if(session){
    const marker=new URL('./.monitor-session',import.meta.url);
    let previous='';try{previous=await readFile(marker,'utf8');}catch{}
    if(previous!==session){
      const child=spawn('explorer.exe',[origin],{windowsHide:true,detached:true,stdio:'ignore'});
      child.on('error',()=>console.error('Could not open the monitor browser. Open the local monitor URL.'));
      child.unref();
      await writeFile(marker,session).catch(()=>console.error('Could not record the monitor sign-in browser launch.'));
    }
  }
});
