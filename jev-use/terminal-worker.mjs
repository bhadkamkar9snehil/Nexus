// One detached worker per active terminal session; no TCP port or global daemon.
// Adapted from Desktop Commander's session buffering, paginated output and tree-kill design.
// A session survives the initiating MCP adapter and is discoverable by other Nexus agents.
import { spawn, execFile } from 'node:child_process';
import { existsSync, appendFileSync, readFileSync, renameSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

const folder = process.argv[2];
if (!folder) process.exit(2);
const launchFile = join(folder, 'launch.json');
const stateFile = join(folder, 'state.json');
const outputFile = join(folder, 'output.log');
const inbox = join(folder, 'inbox');
const configuredLimit = Number(process.env.NEXUS_TERMINAL_OUTPUT_LIMIT_BYTES);
const LOG_MAX = Number.isSafeInteger(configuredLimit) && configuredLimit >= 64 * 1024 && configuredLimit <= 4 * 1024 * 1024
  ? configuredLimit : 4 * 1024 * 1024;
const LOG_KEEP = Math.floor(LOG_MAX / 2);
let state = {
  status: 'starting', session_id: folder.split(/[\\/]/).at(-1),
  worker_pid: process.pid, pid: null, shell: null,
  started_at: Date.now(), ended_at: null, exit_code: null,
  evicted_lines: 0, output_limited: false, error: null,
};
function replaceFile(temp, target) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { renameSync(temp, target); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
function save() {
  const temp = stateFile + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(state));
  replaceFile(temp, stateFile);
}
function appendOutput(text) {
  if (!text) return;
  appendFileSync(outputFile, text, 'utf8');
  if (statSync(outputFile).size <= LOG_MAX) return;
  const raw = readFileSync(outputFile);
  let start = raw.length - LOG_KEEP;
  const nextLine = raw.indexOf(10, start);
  if (nextLine >= 0) start = nextLine + 1;
  const lost = raw.subarray(0, start);
  let count = 0;
  for (const b of lost) if (b === 10) count++;
  state.evicted_lines += count || 1;
  state.output_limited = true;
  const temp = outputFile + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, raw.subarray(start));
  replaceFile(temp, outputFile);
  save();
}
// Heartbeat: readers treat a live-looking session with a stale heartbeat as a lost worker.
let pulse;
const beat = () => { try { writeFileSync(join(folder, 'heartbeat'), String(Date.now())); } catch { /* next beat */ } };
function fail(error) {
  clearInterval(pulse);
  state.status = 'error';
  state.error = error instanceof Error ? error.message : String(error);
  state.ended_at = Date.now();
  save();
  process.exitCode = 1;
}
function killTree(pid) {
  return new Promise((resolve, reject) => {
    const binary = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(binary, ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 8000 }, (error) => error ? reject(error) : resolve());
  });
}
try {
  const launch = JSON.parse(readFileSync(launchFile, 'utf8'));
  rmSync(launchFile, { force: true });
  mkdirSync(inbox, { recursive: true });
  writeFileSync(outputFile, '');
  beat();
  pulse = setInterval(beat, 2000);
  const binaries = {
    powershell: [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-Command', launch.command]],
    cmd: [join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), ['/D', '/S', '/C', launch.command]],
    pwsh: ['pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', launch.command]],
  };
  const selected = binaries[launch.shell];
  if (!selected) throw new Error('Unsupported shell');
  state.shell = launch.shell;
  const child = spawn(selected[0], selected[1], {
    cwd: launch.cwd,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      !/(TOKEN|PASSWORD|API_KEY|SECRET|AUTHORIZATION|CREDENTIAL)/i.test(k))),
    windowsHide: true,
    windowsVerbatimArguments: launch.shell === 'cmd',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', fail);
  child.stdin.on('error', () => {});
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  child.stdout.on('data', b => appendOutput(decoders[0].write(b)));
  child.stderr.on('data', b => appendOutput(decoders[1].write(b)));
  state.pid = child.pid ?? null;
  state.status = child.pid ? 'running' : 'error';
  save();
  let stopping = false;
  const poll = setInterval(async () => {
    if (state.status !== 'running') return;
    const stopFile = join(folder, 'stop');
    if (existsSync(stopFile) && !stopping) {
      stopping = true;
      try {
        await killTree(child.pid);
      } catch (error) {
        state.error = 'Process-tree termination failed: ' + String(error);
        save();
        stopping = false;
        rmSync(stopFile, { force: true });
      }
    }
    const entries = (await import('node:fs/promises')).readdir(inbox).then(x => x.sort());
    for (const name of await entries) {
      if (!name.endsWith('.txt')) continue;
      const file = join(inbox, name);
      try {
        const input = readFileSync(file, 'utf8');
        if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write(input);
        rmSync(file, { force: true });
      } catch { /* retry unreadable in-flight input on next poll */ }
    }
  }, 100);
  child.once('close', (code, signal) => {
    clearInterval(poll);
    clearInterval(pulse);
    if (state.status === 'error') return;
    appendOutput(decoders[0].end() + decoders[1].end());
    state.status = stopping ? 'terminated' : 'exited';
    state.exit_code = code;
    state.signal = signal;
    state.ended_at = Date.now();
    save();
  });
} catch (error) {
  fail(error);
}
