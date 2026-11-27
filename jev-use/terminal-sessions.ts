import { spawn, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {principal,taskMeta} from './task-state.mjs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

type SessionState = {
  session_id: string; worker_pid: number; pid: number | null;
  shell: string; status: string; started_at: number; ended_at: number | null;
  exit_code: number | null; signal?: string | null;
  evicted_lines: number; output_limited: boolean; error: string | null;
};
type SessionSelector = { session_id?: string; pid?: number };
const MAX_SESSIONS = 64;
const MAX_LINE_COUNT = 200;
const MAX_RESPONSE_CHARS = 64 * 1024;
const WAIT_CAP = 3000;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const base = () => process.env.NEXUS_TERMINAL_DIR ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Nexus', 'terminal-sessions');
const workDir = (id: string) => join(base(), id);
const validId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const whole = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const live = (state: SessionState) => ['starting', 'running'].includes(state.status);

async function stateById(id: string): Promise<SessionState> {
  if (!validId(id)) throw new Error('Invalid session_id');
  const state = JSON.parse(await readFile(join(workDir(id), 'state.json'), 'utf8')) as SessionState;
  return live(state) ? reconcile(state) : state;
}
// A live worker touches its heartbeat file every ~2 s. A live-looking session whose heartbeat is stale was lost
// (crash, kill, PID reuse): record that instead of reporting it running forever. Output already written is kept.
const HEARTBEAT_STALE_MS = 10000;
async function reconcile(state: SessionState): Promise<SessionState> {
  const folder = workDir(state.session_id);
  const last = await stat(join(folder, 'heartbeat')).then(s => s.mtimeMs, () => state.started_at);
  if (Date.now() - last <= HEARTBEAT_STALE_MS) return state;
  const lost: SessionState = { ...state, status: 'error', ended_at: Date.now(),
    error: 'Worker stopped unexpectedly; output written so far is kept. The command process may still be running: check list_processes.' };
  const temp = join(folder, `state.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(lost)).then(() => rename(temp, join(folder, 'state.json'))).catch(() => rm(temp, { force: true }));
  return lost;
}
async function allStates(): Promise<SessionState[]> {
  try {
    const entries = await readdir(base(), { withFileTypes: true });
    const results = await Promise.all(entries.filter(e => e.isDirectory() && validId(e.name))
      .map(e => stateById(e.name).catch(() => null)));
    return results.filter((r): r is SessionState => r !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function resolveSession(selector: SessionSelector): Promise<SessionState> {
  if (selector.session_id !== undefined) {
    const result = await stateById(selector.session_id);
    if (selector.pid !== undefined && result.pid !== selector.pid) throw new Error('PID does not match session');
    return result;
  }
  if (!whole(selector.pid, 1, 2147483647)) throw new Error('Specify session_id or valid PID');
  const states = await allStates();
  const matches = states.filter(s => s.pid === selector.pid);
  const active = matches.filter(live);
  const selected = active.length === 1 ? active[0] : matches.length === 1 ? matches[0] : undefined;
  if (!selected) throw new Error('Session not found or PID reused; provide session_id');
  return selected;
}
async function prune() {
  const states = await allStates();
  const completed = states.filter(s => !live(s) && s.ended_at !== null)
    .sort((a, b) => a.ended_at! - b.ended_at! || a.session_id.localeCompare(b.session_id));
  const expiry = Date.now() - 7 * 86400000;
  const expiredCount = completed.filter(s => s.ended_at! < expiry).length;
  await Promise.all(completed.slice(0, expiredCount)
    .map(s => rm(workDir(s.session_id), { recursive: true, force: true })));
  const reclaimCount = states.length - expiredCount - MAX_SESSIONS + 1;
  if (reclaimCount <= 0) return;
  const archive = join(base(), 'archive');
  await mkdir(archive, { recursive: true });
  for (const session of completed.slice(expiredCount, expiredCount + reclaimCount)) {
    try {
      await rename(workDir(session.session_id), join(archive, session.session_id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if ((await allStates()).length >= MAX_SESSIONS)
    throw new Error('Session registry full; wait for an active session to finish');
}
async function snapshot(session: SessionState, offset: number, length: number, charOffset = 0) {
  const raw = await readFile(join(workDir(session.session_id), 'output.log'), 'utf8').catch(() => '');
  const lines = raw.length ? raw.split(/\r\n|\n|\r/) : [];
  if (lines.length > 0 && /[\r\n]$/.test(raw)) lines.pop();
  const baseLine = session.evicted_lines || 0;
  const total = baseLine + lines.length;
  const start = offset < 0 ? Math.max(baseLine, total + offset) : Math.max(baseLine, offset);
  let idx = Math.min(lines.length, Math.max(0, start - baseLine));
  const output: string[] = [];
  let chars = 0, lineTruncated = false, continueAt: number | null = null;
  const firstIdx = idx;
  while (idx < lines.length && output.length < length) {
    // char_offset resumes inside the first line when a previous page cut an oversized line.
    const skip = idx === firstIdx && offset >= baseLine ? charOffset : 0;
    const line = skip ? lines[idx].slice(skip) : lines[idx];
    const room = MAX_RESPONSE_CHARS - chars - (output.length ? 1 : 0);
    if (room < 1) break;
    if (line.length > room) {
      if (output.length) break;
      output.push(line.slice(0, room));
      lineTruncated = true;
      continueAt = skip + room;
      break;
    }
    output.push(line);
    chars += line.length + (output.length > 1 ? 1 : 0);
    idx++;
  }
  // Re-read an unfinished last line so a later continuation cannot be skipped.
  const partial = live(session) && raw.length > 0 && !/[\r\n]$/.test(raw) && idx === lines.length && output.length > 0;
  // An oversized line stays the current line: the next page continues it at next_char_offset, so nothing is lost.
  const next = continueAt !== null ? baseLine + idx : baseLine + idx - (partial ? 1 : 0);
  return {
    content: output.join('\n'), read_from: start, lines_read: output.length,
    total_lines: total, next_offset: continueAt !== null || next < total ? next : null,
    next_char_offset: continueAt,
    truncated: continueAt !== null || baseLine + idx < total || session.output_limited,
    line_truncated: lineTruncated, evicted_lines: baseLine,
  };
}
async function waitForUpdate(id: string, offset: number, timeout: number) {
  const deadline = Date.now() + timeout;
  let session = await stateById(id);
  while (Date.now() < deadline && live(session)) {
    const page = await snapshot(session, offset, 1);
    if (page.total_lines > offset) break;
    await delay(80);
    session = await stateById(id);
  }
  return session;
}
function validateSelector(args: SessionSelector) {
  if (args.session_id === undefined && args.pid === undefined) throw new Error('Provide session_id or pid');
  if (args.session_id !== undefined && !validId(args.session_id)) throw new Error('Invalid session_id');
  if (args.pid !== undefined && !whole(args.pid, 1, 2147483647)) throw new Error('Invalid PID');
}
export async function startProcess(args: {
  command: string; shell?: string; cwd?: string; timeout_ms?: number; task?: {key:string;client:string;traceId?:string};
}) {
  if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16384)
    throw new Error('command must contain 1–16384 characters');
  const shell = args.shell ?? 'powershell';
  if (!['powershell', 'cmd', 'pwsh'].includes(shell)) throw new Error('Unsupported shell');
  const wait = args.timeout_ms ?? 350;
  if (!whole(wait, 0, WAIT_CAP)) throw new Error('timeout_ms must be 0–3000');
  const cwd = args.cwd ?? homedir();
  if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error('cwd must be an existing absolute directory');
  await mkdir(base(), { recursive: true });
  const fingerprint=createHash('sha256').update(JSON.stringify([args.command,shell,cwd])).digest('hex');
  const hex=args.task?createHash('sha256').update(principal()+'\0'+args.task.key).digest('hex'):'';
  const id=args.task?hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32):randomUUID();
  const folder=workDir(id);
  const existing=async()=>{
   let meta;
   for(let i=0;i<20;i++){meta=await taskMeta(id).catch(()=>null);if(meta)break;await delay(50);}
   if(!meta||meta.fingerprint!==fingerprint)throw new Error('Task key already used or launch not confirmed; inspect before retry');
   const state=await stateById(id).catch(()=>null);
   return {status:'done',session_id:id,pid:state?.pid??null,shell,state:state?.status??'starting',exit_code:state?.exit_code??null,task_id:id,decisions:0};
  };
  if(args.task&&existsSync(folder))return existing();
  // Capacity reclaim moves finished records to archive/: their keys are still used, and a retry must not run the command again.
  if(args.task&&existsSync(join(base(),'archive',id)))throw new Error('Task key already used by an archived task; inspect archive/'+id+' before starting it again under a new key');
  await prune();
  try{await mkdir(folder);}catch(e){if(args.task&&(e as NodeJS.ErrnoException).code==='EEXIST')return existing();throw e;}
  if(args.task)await writeFile(join(folder,'task.json'),JSON.stringify({version:1,taskId:id,owner:principal(),client:args.task.client.slice(0,100),createdAt:Date.now(),traceId:args.task.traceId,fingerprint}),{flag:'wx'});
  await writeFile(join(folder, 'launch.json'), JSON.stringify({ command: args.command, shell, cwd }), { flag: 'wx' });
  const child = spawn(process.execPath, [join(import.meta.dirname, 'terminal-worker.mjs'), folder], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      !/(TOKEN|PASSWORD|API_KEY|SECRET|AUTHORIZATION|CREDENTIAL)/i.test(k))),
  });
  child.on('error',()=>{});
  if (!child.pid) throw new Error('Terminal worker failed to start');
  child.unref();
  let session: SessionState | undefined;
  const deadline = Date.now() + Math.max(wait, 1200);
  while (Date.now() < deadline) {
    session = await stateById(id).catch(() => undefined);
    if (session && session.status !== 'starting') break;
    await delay(60);
  }
  if (!session&&args.task)return {status:'done',session_id:id,pid:null,shell,state:'starting',exit_code:null,task_id:id,decisions:0};
  if (!session) throw new Error('Terminal worker did not publish a session');
  if (session.status === 'error'&&!args.task) throw new Error(session.error || 'Terminal worker failed');
  if (wait > 0 && live(session)) {
    const until = Date.now() + wait;
    while (Date.now() < until) {
      session = await stateById(id);
      const page = await snapshot(session, 0, 20);
      if (page.lines_read || !live(session)) break;
      await delay(70);
    }
  }
  session = await stateById(id);
  const page = await snapshot(session, 0, 40);
  return { status: 'done', session_id: id, pid: session.pid, shell, state: session.status,
    exit_code: session.exit_code, ...page, ...(args.task?{task_id:id}:{}), decisions: 0 };
}
export async function readProcessOutput(args: SessionSelector & {
  offset?: number; length?: number; timeout_ms?: number; char_offset?: number;
}) {
  validateSelector(args);
  const offset = args.offset ?? 0, length = args.length ?? 50, wait = args.timeout_ms ?? 0, charOffset = args.char_offset ?? 0;
  if (!whole(offset, -1000000000, 1000000000) || !whole(length, 1, MAX_LINE_COUNT) || !whole(wait, 0, WAIT_CAP) || !whole(charOffset, 0, 1000000000))
    throw new Error('Invalid offset, length, timeout_ms or char_offset');
  let session = await resolveSession(args);
  if (wait && offset >= 0) session = await waitForUpdate(session.session_id, offset, wait);
  else session = await stateById(session.session_id);
  return { status: 'done', session_id: session.session_id, pid: session.pid,
    state: session.status, exit_code: session.exit_code, error: session.error,
    ...await snapshot(session, offset, length, charOffset), decisions: 0 };
}
export async function interactWithProcess(args: SessionSelector & {
  input: string; timeout_ms?: number; append_newline?: boolean;
}) {
  validateSelector(args);
  if (typeof args.input !== 'string' || args.input.length < 1 || args.input.length > 8192)
    throw new Error('input must have 1–8192 characters');
  if (args.append_newline !== undefined && typeof args.append_newline !== 'boolean') throw new Error('Invalid append_newline');
  const wait = args.timeout_ms ?? 500;
  if (!whole(wait, 0, WAIT_CAP)) throw new Error('Invalid timeout_ms');
  const session = await resolveSession(args);
  if (!live(session) || !session.pid) throw new Error('Terminal session is not running');
  const previous = await snapshot(session, -1, 1);
  const inputDir = join(workDir(session.session_id), 'inbox');
  const name = String(Date.now()) + '-' + randomUUID();
  await mkdir(inputDir, { recursive: true });
  const temporary = join(inputDir, name + '.tmp');
  const payload = args.append_newline === false || args.input.endsWith('\n') ? args.input : args.input + '\n';
  await writeFile(temporary, payload, { flag: 'wx' });
  await rename(temporary, join(inputDir, name + '.txt'));
  return { ...await readProcessOutput({ session_id: session.session_id, offset: previous.total_lines,
    length: 50, timeout_ms: wait }), input_queued: true };
}
export async function listSessions() {
  const states = (await allStates()).sort((a, b) => b.started_at - a.started_at);
  return { status: 'done', count: states.length, sessions: states.map(s => ({
    session_id: s.session_id, pid: s.pid, shell: s.shell, state: s.status,
    started_at: s.started_at, ended_at: s.ended_at, exit_code: s.exit_code,
    error: s.error, output_limited: s.output_limited,
  })), decisions: 0 };
}
export async function terminalTaskState(id:string){return stateById(id);}
export async function requestSessionStop(id:string){
 const state=await stateById(id).catch(()=>null);
 if(!state||live(state))await writeFile(join(workDir(id),'stop'),'',{flag:'w'});
}
export async function forceTerminate(args: SessionSelector) {
  validateSelector(args);
  let session = await resolveSession(args);
  if (!live(session)) return { status: 'done', session_id: session.session_id,
    pid: session.pid, state: session.status, already_finished: true, decisions: 0 };
  await writeFile(join(workDir(session.session_id), 'stop'), '', { flag: 'w' });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await delay(100);
    session = await stateById(session.session_id);
    if (!live(session)) break;
  }
  if (live(session)) throw new Error('Termination not confirmed; inspect session before retry');
  if (session.error?.includes('termination failed')) throw new Error(session.error);
  return { status: 'done', session_id: session.session_id, pid: session.pid,
    state: session.status, exit_code: session.exit_code, decisions: 0 };
}
function execPowerShell(script: string) {
  return new Promise<string>((resolve, reject) => {
    const binary = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(binary, ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout));
  });
}
export async function listProcesses(args: { name?: string; pid?: number; limit?: number } = {}) {
  const limit = args.limit ?? 100;
  if (!whole(limit, 1, 200)) throw new Error('Invalid limit');
  if (args.pid !== undefined && !whole(args.pid, 1, 2147483647)) throw new Error('Invalid PID');
  if (args.name !== undefined && (typeof args.name !== 'string' || !/^[\w .-]{1,100}$/.test(args.name)))
    throw new Error('Invalid name');
  const script = "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,@{Name='StartIdentity';Expression={try { $_.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } catch { $null }}} | ConvertTo-Json -Compress -Depth 3";
  const raw = (await execPowerShell(script)).trim();
  const parsed = raw ? JSON.parse(raw) : [];
  const list = (Array.isArray(parsed) ? parsed : [parsed]).map((p: any) => ({
    pid: p.Id as number, name: p.ProcessName as string,
    start_identity: typeof p.StartIdentity === 'string' ? p.StartIdentity : null,
    cpu_seconds: typeof p.CPU === 'number' ? p.CPU : null,
    working_set_bytes: typeof p.WorkingSet64 === 'number' ? p.WorkingSet64 : null,
  }));
  const matches = list.filter(p => (args.pid === undefined || p.pid === args.pid) &&
    (args.name === undefined || p.name.toLowerCase() === args.name.toLowerCase()));
  matches.sort((a, b) => (b.working_set_bytes ?? 0) - (a.working_set_bytes ?? 0));
  return { status: 'done', count: matches.length, processes: matches.slice(0, limit),
    truncated: matches.length > limit, cpu_unit: 'cumulative process CPU seconds, not instantaneous percent', decisions: 0 };
}
const protectedNames = new Set(['system', 'idle', 'registry', 'smss', 'csrss', 'wininit',
  'services', 'lsass', 'winlogon', 'svchost', 'dwm', 'fontdrvhost', 'secure system']);
export async function killProcess(args: { pid: number; expected_name: string; expected_start_time: string; confirm: boolean }) {
  if (!whole(args.pid, 1, 2147483647) || args.pid === process.pid || args.pid === process.ppid)
    throw new Error('Invalid or protected PID');
  if (args.confirm !== true) throw new Error('Explicit confirm=true required for kill_process');
  if (typeof args.expected_name !== 'string' || !/^[\w .-]{1,100}$/.test(args.expected_name))
    throw new Error('expected_name must be the exact process name');
  if (typeof args.expected_start_time !== 'string' || !/^\d{1,20}$/.test(args.expected_start_time))
    throw new Error('expected_start_time must be the observed start identity');
  const observed = (await listProcesses({ pid: args.pid, limit: 1 })).processes[0];
  if (!observed) throw new Error('PID not found');
  if (protectedNames.has(observed.name.toLowerCase())) throw new Error('Protected system process');
  if (observed.name.toLowerCase() !== args.expected_name.toLowerCase())
    throw new Error('Process name mismatch; PID may have been reused');
  if (observed.start_identity !== args.expected_start_time) throw new Error('Process identity mismatch; refresh the process list');
  const managed = (await allStates()).find(s => live(s) && (s.pid === args.pid || s.worker_pid === args.pid));
  if (managed) throw new Error('Managed Nexus session; use force_terminate to stop its process tree');
  const source = join(import.meta.dirname, 'process-identity.cs').replace(/'/g, "''");
  await execPowerShell(`$ErrorActionPreference='Stop'; [Environment]::CurrentDirectory=$env:TEMP; Add-Type -Path '${source}'; [NexusProcessIdentity]::Terminate(${args.pid}, '${args.expected_name}', '${args.expected_start_time}')`);
  return { status: 'done', pid: args.pid, process_name: observed.name, state: 'terminated', decisions: 0 };
}
