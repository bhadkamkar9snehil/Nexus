import { createServer } from 'node:http';
import { readFile, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { runtimeStatus } from './runtime-status.mjs';
import { events, startWebhook, webhookPort } from './webhook.mjs';
import { startEventDelivery } from './events-webhooks.mjs';
import { startPeerDiscovery } from './peers-auto.mjs';
import { startAutoUpdate } from './auto-update.mjs';
import { startVisualWatches } from './visual-watch.mjs';
import { respondTo } from './agent-responder.mjs';
import { firewall } from './firewall.mjs';
import { handleApi } from './peers-api.mjs';
import { versionInfo } from './version.mjs';
import {listTaskViews,requestTaskStop} from './jev-use/task-state.mjs';

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
let runCache;
let runPending;
const assets = Object.fromEntries(['app.js','app.css','geist.woff2','geist-mono.woff2'].map(name => ['/assets/' + name, new URL('./monitor-ui/dist/' + name, import.meta.url)]));

const html = await readFile(new URL('./desktop.html', import.meta.url));
const managed = process.env.HARNESS_MONITOR_MANAGED === '1';
const log = new URL('./runs.jsonl', import.meta.url);

async function readRuns() {
  let file;
  try { file = await open(log); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const { size, mtimeMs } = await file.stat();
    const key=size+':'+mtimeMs;
    if(runCache?.key===key)return runCache.rows;
    const offset = Math.max(0, size - 2 * 1024 * 1024);
    const bytes = Buffer.alloc(size - offset);
    await file.read(bytes, 0, bytes.length, offset);
    const rows = new Map();
    for (const line of bytes.toString('utf8').split('\n').slice(offset ? 1 : 0)) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        const first = rows.get(row.id);
        rows.set(row.id, { ...first, ...row, started: first?.started ?? row.at - (row.ms ?? 0) });
      } catch { /* An incomplete last line will appear on the next refresh. */ }
    }
    const result=[...rows.values()].sort((a,b)=>b.started-a.started).slice(0,500);
    runCache={key,rows:result,json:JSON.stringify(result)};
    return result;
  } finally {
    await file.close();
  }
}

async function recentRuns(){
  runPending??=readRuns().finally(()=>{runPending=undefined;});
  return runPending;
}

createServer(async (req, res) => {
  const appOrigin = req.headers.origin === 'https://app.nexus.local' ? 'https://app.nexus.local' : null;
  const cors = appOrigin ? {
    'Access-Control-Allow-Origin': appOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Nexus, If-None-Match',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'ETag',
    'Vary': 'Origin',
  } : {};
  const send = (status, type, body) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...cors });
    res.end(body);
  };
  if (req.headers.host !== `127.0.0.1:${port}`) return send(403, 'text/plain', 'Forbidden');
  if (req.method === 'OPTIONS' && appOrigin) { res.writeHead(204, cors); return res.end(); }
  // The Peers page API: POST needs a same-origin (or app.nexus.local) request carrying X-Nexus.
  if (req.url.startsWith('/api/')) {
    if (req.method === 'POST' && (req.headers['x-nexus'] !== '1' || (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== 'https://app.nexus.local'))) return send(403, 'text/plain', 'Forbidden');
    if (req.method !== 'GET' && req.method !== 'POST') return send(405, 'text/plain', 'Method not allowed');
    let body = {};
    if (req.method === 'POST') {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 128 * 1024) return send(413, 'text/plain', 'Too large'); chunks.push(c); }
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(400, 'text/plain', 'Bad JSON'); }
    }
    if(req.url==='/api/tasks/cancel'&&req.method==='POST'){
      if(req.headers['user-agent']?.trim().split(' ').at(-1)!=='NexusDesktop/1.0')return send(403,'text/plain','Forbidden');
      try{await requestTaskStop(body.taskId);return send(202,'application/json',JSON.stringify({status:'requested'}));}catch{return send(404,'text/plain','Task not found or unavailable');}
    }
    const result = await handleApi(import.meta.dirname, req.method, new URL(req.url, origin), body);
    return send(result.status, 'application/json', JSON.stringify(result.json));
  }
  if (req.method !== 'GET') return send(403, 'text/plain', 'Forbidden');
  if (req.url === '/version') return send(200, 'application/json', JSON.stringify(await versionInfo(import.meta.dirname)));
  if (req.url === '/monitor-status') return send(200, 'application/json', JSON.stringify({ application: 'shared-computer-use-monitor', root: import.meta.dirname, pid: process.pid, managed }));
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
  if(req.url==='/tasks'){
    if(req.headers['user-agent']?.trim().split(' ').at(-1)!=='NexusDesktop/1.0')return send(404,'text/plain','Open Nexus Desktop');
    try{return send(200,'application/json',JSON.stringify({tasks:await listTaskViews()}));}catch{return send(503,'text/plain','Task registry unavailable');}
  }
  if (req.url === '/sessions') {
    try {
      const result = await inspect('list_sessions');
      return send(200, 'application/json', JSON.stringify({sessions: result.sessions.map(s => ({
        session_id: s.session_id, pid: s.pid, shell: s.shell, state: s.state,
        started_at: s.started_at, ended_at: s.ended_at, exit_code: s.exit_code,
      }))}));
    } catch { return send(503, 'text/plain', 'Terminal sessions unavailable.'); }
  }
  if (new URL(req.url, origin).pathname === '/') {
    if (req.headers['user-agent']?.trim().split(' ').at(-1) !== 'NexusDesktop/1.0') {
      return send(404, 'text/plain; charset=utf-8', 'Open Nexus from the Windows Start menu.');
    }
    return send(200, 'text/html; charset=utf-8', html);
  }
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
  try { const rows=await recentRuns(); const etag=runCache?.rows===rows?'"'+runCache.key+'"':'"empty"'; if(req.headers['if-none-match']===etag){res.writeHead(304,{'ETag':etag,'Cache-Control':'no-store'});return res.end();} res.setHeader('ETag',etag);send(200,'application/json',runCache?.rows===rows?runCache.json:JSON.stringify(rows)); }
  catch { send(500, 'text/plain', 'Could not read the run log'); }
}).listen(port, '127.0.0.1', async () => {
  console.log('Computer & Browser Use Monitor: ' + origin);
  // Admin: the peer port is opened automatically. Peers: pair with the owner's own Tailscale devices, answer chat with the owner's agent.
  firewall({ create: true }).then(f => { if (f.created) console.log('Opened inbound port ' + f.port + ' for peers.'); else if (!f.open) console.error('Peer port ' + f.port + ' is closed in Windows Firewall; run Nexus as administrator once, or use Open port on the Peers page.'); });
  startWebhook(import.meta.dirname, { onMessage: m => respondTo(import.meta.dirname, m, { log: console.error }) }).catch(e => console.error('Webhook receiver not started: ' + e.message));
  startEventDelivery(import.meta.dirname, { log: console.error });
  if(managed) startVisualWatches(import.meta.dirname,{log:console.error});
  startPeerDiscovery(import.meta.dirname, { log: console.log });
  startAutoUpdate(import.meta.dirname, { log: console.error });
});
