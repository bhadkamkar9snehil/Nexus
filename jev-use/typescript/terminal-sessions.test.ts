import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startProcess, readProcessOutput, interactWithProcess, forceTerminate,
  listSessions, listProcesses, killProcess } from '../terminal-sessions.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function pollResult(id: string, phrase: string) {
  for (let i = 0; i < 40; i++) {
    const r = await readProcessOutput({ session_id: id });
    if (r.content.includes(phrase)) return r;
    await sleep(120);
  }
  throw new Error('Terminal did not return ' + phrase);
}

async function waitForExit(id: string, registry: string) {
  const deadline = Date.now() + 20000;
  let result = await readProcessOutput({ session_id: id, offset: -5 });
  while (['running', 'starting'].includes(result.state) && Date.now() < deadline) {
    await sleep(5);
    result = await readProcessOutput({ session_id: id, offset: -5 });
  }
  if (['running', 'starting'].includes(result.state)) {
    const state = JSON.parse(await readFile(join(registry, id, 'state.json'), 'utf8'));
    let workerPidPresent = true;
    try { process.kill(state.worker_pid, 0); } catch (error) {
      workerPidPresent = (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    throw new Error(`Session did not exit: worker_pid_present=${workerPidPresent}, state=${result.state}, error=${result.error}`);
  }
  return result;
}

test('paging retains a line completed after an earlier partial read', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-partial-'));
  const old = process.env.NEXUS_TERMINAL_DIR;
  process.env.NEXUS_TERMINAL_DIR = join(workspace, 'registry');
  let id: string | undefined;
  try {
    const script = join(workspace, 'partial.cjs');
    await writeFile(script, "process.stdout.write('part'); setTimeout(() => process.stdout.write('-complete\\n'), 1500);");
    const run = await startProcess({ command: '& "' + process.execPath + '" "' + script + '"', cwd: workspace, timeout_ms: 800 });
    id = run.session_id;
    const first = await pollResult(id, 'part');
    await sleep(1800);
    const next = await readProcessOutput({ session_id: id, offset: first.next_offset ?? first.total_lines });
    assert.match(next.content, /complete/);
  } finally {
    if (id) await forceTerminate({ session_id: id }).catch(() => {});
    if (old === undefined) delete process.env.NEXUS_TERMINAL_DIR; else process.env.NEXUS_TERMINAL_DIR = old;
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('a full registry archives the oldest completed record and preserves active output', async () => {
  const registry = await mkdtemp(join(tmpdir(), 'nexus-retention-'));
  const old = process.env.NEXUS_TERMINAL_DIR;
  process.env.NEXUS_TERMINAL_DIR = registry;
  try {
    const now = Date.now();
    const ids = Array.from({ length: 64 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await Promise.all(ids.map(async (session_id, index) => {
      const folder = join(registry, session_id);
      await mkdir(folder);
      const active = index === 0;
      await writeFile(join(folder, 'state.json'), JSON.stringify({
        session_id, shell: 'cmd', status: active ? 'running' : 'exited',
        started_at: now - 64 + index, ended_at: active ? null : now - 64 + index,
      }));
      if (active) {
        await writeFile(join(folder, 'heartbeat'), '');
        await writeFile(join(folder, 'output.log'), 'active output\n');
      }
      if (index === 1) await writeFile(join(folder, 'output.log'), 'archived output\n');
    }));
    const run = await startProcess({ command: 'echo retention-ok', shell: 'cmd', cwd: registry });
    assert.match((await waitForExit(run.session_id, registry)).content, /retention-ok/);
    const retained = await listSessions();
    assert.equal(retained.count, 64);
    assert.ok(retained.sessions.some(s => s.session_id === ids[2]));
    assert.ok(!retained.sessions.some(s => s.session_id === ids[1]));
    assert.equal(await readFile(join(registry, 'archive', ids[1], 'output.log'), 'utf8'), 'archived output\n');
    assert.equal((await readProcessOutput({ session_id: ids[0] })).content, 'active output');
  } finally {
    if (old === undefined) delete process.env.NEXUS_TERMINAL_DIR; else process.env.NEXUS_TERMINAL_DIR = old;
    await rm(registry, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('terminal tools keep paginated output after a command exits', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-terminal-'));
  const old = process.env.NEXUS_TERMINAL_DIR;
  process.env.NEXUS_TERMINAL_DIR = join(workspace, 'registry');
  try {
    const run = await startProcess({ command: '1..45 | ForEach-Object { Write-Output ("Line" + $_) }', cwd: workspace, timeout_ms: 700 });
    assert.equal(run.status, 'done');
    assert.ok(run.session_id);
    assert.ok(Number.isSafeInteger(run.pid));
    const first = await pollResult(run.session_id, 'Line45');
    assert.equal(first.total_lines, 45);
    const chunk = await readProcessOutput({ session_id: run.session_id, offset: 5, length: 3 });
    assert.equal(chunk.content, 'Line6\nLine7\nLine8');
    assert.equal(chunk.next_offset, 8);
    const tail = await readProcessOutput({ session_id: run.session_id, offset: -2 });
    assert.equal(tail.content, 'Line44\nLine45');
    const listed = await listSessions();
    assert.ok(listed.sessions.some(s => s.session_id === run.session_id));
    assert.equal((await waitForExit(run.session_id, join(workspace, 'registry'))).state, 'exited');
  } finally {
    if (old === undefined) delete process.env.NEXUS_TERMINAL_DIR;
    else process.env.NEXUS_TERMINAL_DIR = old;
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('interactive session accepts input, survives other callers and terminates its process tree', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-interact-'));
  const old = process.env.NEXUS_TERMINAL_DIR;
  process.env.NEXUS_TERMINAL_DIR = join(workspace, 'registry');
  try {
    const script = join(workspace, 'echo.cjs');
    await writeFile(script, [
      "process.stdin.setEncoding('utf8');",
      "process.stdout.write('READY:' + process.pid + '\\n');",
      "process.stdin.on('data', input => { process.stdout.write('ECHO:' + input); if (input.includes('exit')) process.exit(0); });",
    ].join('\n'));
    const command = '& "' + process.execPath + '" "' + script + '"';
    const started = await startProcess({ command, cwd: workspace, timeout_ms: 800 });
    const ready = await pollResult(started.session_id, 'READY:');
    const childPid = Number(ready.content.match(/READY:(\d+)/)?.[1]);
    assert.ok(childPid > 0);
    const reply = await interactWithProcess({ session_id: started.session_id, input: 'hello', timeout_ms: 1000 });
    if (!reply.content.includes('ECHO:hello')) await pollResult(started.session_id, 'ECHO:hello');
    const listing = await listSessions();
    assert.ok(listing.sessions.some(s => s.session_id === started.session_id && s.pid === started.pid));
    const stopped = await forceTerminate({ session_id: started.session_id });
    assert.equal(stopped.state, 'terminated');
    assert.equal((await listProcesses({ pid: childPid })).count, 0);
    assert.equal((await readProcessOutput({ session_id: started.session_id })).state, 'terminated');
    await assert.rejects(interactWithProcess({ session_id: started.session_id, input: 'after' }), /not running/);
  } finally {
    if (old === undefined) delete process.env.NEXUS_TERMINAL_DIR; else process.env.NEXUS_TERMINAL_DIR = old;
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('process listing and external PID termination require exact confirmation', async () => {
  if (process.platform !== 'win32') return;
  const observed = await listProcesses({ pid: process.pid });
  assert.equal(observed.processes[0]?.pid, process.pid);
  assert.ok(observed.processes[0].working_set_bytes !== null);
  await assert.rejects(killProcess({ pid: process.pid, expected_name: 'node', expected_start_time: '1', confirm: true }), /protected PID/);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  try {
    await sleep(350);
    const identity = (await listProcesses({ pid: child.pid! })).processes[0].start_identity!;
    assert.ok(identity);
    await assert.rejects(killProcess({ pid: child.pid!, expected_name: 'node', expected_start_time: identity, confirm: false }), /confirm/);
    await assert.rejects(killProcess({ pid: child.pid!, expected_name: 'not-node', expected_start_time: identity, confirm: true }), /mismatch/);
    const ended = await killProcess({ pid: child.pid!, expected_name: 'node', expected_start_time: identity, confirm: true });
    assert.equal(ended.state, 'terminated');
  } finally {
    if (child.exitCode === null && child.pid) child.kill();
  }
});

test('external termination rejects a stale process creation identity', async () => {
  if (process.platform !== 'win32') return;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  try {
    await sleep(350);
    await assert.rejects(killProcess({ pid: child.pid!, expected_name: 'node', expected_start_time: '1', confirm: true }), /identity|start.time/i);
    assert.equal(child.exitCode, null);
    const source = join(import.meta.dirname, '..', 'process-identity.cs').replace(/'/g, "''");
    const binary = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.throws(() => execFileSync(binary, ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; Add-Type -Path '${source}'; [NexusProcessIdentity]::Terminate(${child.pid}, 'node', '1')`], { stdio: 'ignore' }));
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test('MCP exposes all seven tools; sessions persist across client disconnects', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-mcp-terminal-'));
  const registry = join(workspace, 'registry');
  await mkdir(registry);
  const connect = async () => {
    const client = new Client({ name: 'terminal-test', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [join(import.meta.dirname, '..', 'start.mjs')],
      env: { ...process.env, NEXUS_TERMINAL_DIR: registry }, stderr: 'ignore',
    });
    await client.connect(transport);
    return { client, transport };
  };
  const one = await connect();
  let two: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const names = (await one.client.listTools()).tools.map(t => t.name);
    for (const name of ['start_process','read_process_output','interact_with_process',
      'list_sessions','force_terminate','list_processes','kill_process']) assert.ok(names.includes(name), name);
    const started = await one.client.callTool({ name: 'start_process', arguments: {
      command: 'Write-Output "CROSS-CLIENT-OK"; #' + 'x'.repeat(2500), cwd: workspace, timeout_ms: 800,
    } });
    assert.notEqual(started.isError, true);
    const id = JSON.parse((started.content as {text:string}[])[0].text).session_id;
    await one.transport.close();
    two = await connect();
    let matched = false;
    for (let i = 0; i < 25; i++) {
      const output = await two.client.callTool({ name: 'read_process_output', arguments: { session_id: id } });
      assert.notEqual(output.isError, true);
      if (JSON.parse((output.content as {text:string}[])[0].text).content.includes('CROSS-CLIENT-OK')) {
        matched = true; break;
      }
      await sleep(120);
    }
    assert.equal(matched, true);
  } finally {
    await one.transport.close().catch(() => {});
    if (two) await two.transport.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('CMD shell starts and validates arguments', async () => {
  if (process.platform !== 'win32') return;
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-cmd-'));
  const old = process.env.NEXUS_TERMINAL_DIR;
  process.env.NEXUS_TERMINAL_DIR = join(workspace, 'registry');
  try {
    await assert.rejects(startProcess({ command: '', cwd: workspace }), /command/);
    await assert.rejects(startProcess({ command: 'echo x', shell: 'invalid', cwd: workspace }), /shell/);
    const run = await startProcess({ command: 'echo CMD-OK', shell: 'cmd', cwd: workspace, timeout_ms: 900 });
    const page = await pollResult(run.session_id, 'CMD-OK');
    assert.ok(page.content.includes('CMD-OK'));
  } finally {
    if (old === undefined) delete process.env.NEXUS_TERMINAL_DIR; else process.env.NEXUS_TERMINAL_DIR = old;
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('terminal output evicts old data instead of growing indefinitely', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-outputcap-'));
  const old = process.env.NEXUS_TERMINAL_DIR;
  const oldLimit = process.env.NEXUS_TERMINAL_OUTPUT_LIMIT_BYTES;
  process.env.NEXUS_TERMINAL_DIR = join(workspace, 'registry');
  process.env.NEXUS_TERMINAL_OUTPUT_LIMIT_BYTES = String(128 * 1024);
  try {
    const script = join(workspace, 'large.cjs');
    await writeFile(script, "process.stdout.write(('x'.repeat(1024) + '\\n').repeat(400));");
    const run = await startProcess({
      command: '& "' + process.execPath + '" "' + script + '"',
      cwd: workspace, timeout_ms: 900,
    });
    const result = await waitForExit(run.session_id, join(workspace, 'registry'));
    assert.equal(result.state, 'exited');
    assert.ok(result.truncated, 'output cap must be reported; observed ' + JSON.stringify({ state: result.state, error: result.error, lines: result.total_lines, evicted: result.evicted_lines, chars: result.content.length }));
    assert.ok(result.evicted_lines > 0, 'old lines must be counted as evicted');
    const info = await stat(join(workspace, 'registry', run.session_id, 'output.log'));
    assert.ok(info.size <= 128 * 1024);
  } finally {
    if (oldLimit === undefined) delete process.env.NEXUS_TERMINAL_OUTPUT_LIMIT_BYTES;
    else process.env.NEXUS_TERMINAL_OUTPUT_LIMIT_BYTES = oldLimit;
    if (old === undefined) delete process.env.NEXUS_TERMINAL_DIR; else process.env.NEXUS_TERMINAL_DIR = old;
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('retrying an archived task key does not run the command again', async () => {
  const registry = await mkdtemp(join(tmpdir(), 'nexus-task-archive-'));
  const old = process.env.NEXUS_TERMINAL_DIR;
  process.env.NEXUS_TERMINAL_DIR = registry;
  try {
    const marker = join(registry, 'runs.txt');
    const args = { command: 'echo ran>>runs.txt', shell: 'cmd', cwd: registry, task: { key: 'archived-key-0000001', client: 'test' } };
    const first = await startProcess(args);
    await waitForExit(first.session_id, registry);
    await mkdir(join(registry, 'archive'));
    await rename(join(registry, first.session_id), join(registry, 'archive', first.session_id));
    await assert.rejects(startProcess(args), /archived task/);
    assert.equal((await readFile(marker, 'utf8')).trim(), 'ran');
  } finally {
    if (old === undefined) delete process.env.NEXUS_TERMINAL_DIR; else process.env.NEXUS_TERMINAL_DIR = old;
    await rm(registry, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
