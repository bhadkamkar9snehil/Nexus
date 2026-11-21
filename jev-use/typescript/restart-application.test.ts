import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartApplication, restartStatus } from '../restart-application.js';
import { listProcesses } from '../terminal-sessions.js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('restart requires an explicitly confirmed, observed process identity', async () => {
  await assert.rejects(restartApplication({ pid: 1, expected_name: 'x', expected_start_time: '1', confirm: false }), /confirm=true/);
  await assert.rejects(restartApplication({ pid: 1, expected_name: 'x', expected_start_time: '1', confirm: true, quit_via_ctrl_q: 'yes' as unknown as boolean }), /quit_via_ctrl_q/);
  await assert.rejects(restartStatus('../other'), /Invalid restart id/);
});

test('stale supervisor state is reported as unknown', async () => {
  const old = process.env.LOCALAPPDATA;
  const root = await mkdtemp(join(tmpdir(), 'nexus-restart-status-'));
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  try {
    process.env.LOCALAPPDATA = root;
    await mkdir(join(root, 'Nexus', 'restarts'), { recursive: true });
    await writeFile(join(root, 'Nexus', 'restarts', id + '.json'), JSON.stringify({ state: 'ready', updated_at: Date.now() - 121000 }));
    assert.equal((await restartStatus(id)).state, 'unknown');
  } finally {
    if (old === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = old;
    await rm(join(root, 'Nexus', 'restarts', id + '.json'), { force: true });
    await rmdir(join(root, 'Nexus', 'restarts'));
    await rmdir(join(root, 'Nexus'));
    await rmdir(root);
  }
});

test('independent supervisor closes and restarts an exact interactive process', { timeout: 80000, skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nexus-restart-target-'));
  const picture = join(folder, 'restart-me.png');
  await writeFile(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const target = spawn('mspaint.exe', [picture], { detached: true, stdio: 'ignore' });
  target.unref();
  assert.ok(target.pid);
  let restarted = 0;
  try {
    await new Promise(r => setTimeout(r, 4000));
    const original = (await listProcesses({ pid: target.pid })).processes[0];
    assert.ok(original?.start_identity);
    const client = await promisify(execFile)(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures/restart-client.ts'), String(original.pid), original.name, original.start_identity]);
    const ready = JSON.parse(client.stdout);
    assert.equal(ready.state, 'ready');
    let status = ready;
    for (let i = 0; i < 60 && !['restarted', 'failed'].includes(String(status.state)); i++) {
      await new Promise(r => setTimeout(r, 1000));
      status = await restartStatus(String(ready.id));
    }
    assert.equal(status.state, 'restarted', JSON.stringify(status));
    restarted = Number(status.new_pid);
    assert.ok(restarted > 0 && restarted !== target.pid);
    assert.equal(status.arguments_restored, true);
    const line = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${restarted}").CommandLine`]);
    assert.match(line.stdout, /restart-me\.png/); // the relaunch carries the original argument
  } finally {
    for (const pid of [target.pid, restarted]) if (pid) { try { process.kill(pid); } catch {} }
    await rm(folder, { recursive: true, force: true });
  }
});

test('quit shortcut restarts an app that refuses window close and preserves arguments', { timeout: 80000, skip: process.platform !== 'win32' }, async () => {
  const fixture = join(import.meta.dirname, 'fixtures/restart-shortcut.ps1');
  const target = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Marker', 'nexus-restart-check']);
  let errors = '';
  target.stderr?.on('data', chunk => { errors += chunk; });
  target.stdout?.on('data', chunk => { errors += chunk; });
  target.unref();
  let restarted = 0;
  try {
    await new Promise(r => setTimeout(r, 4000));
    const original = (await listProcesses({ pid: target.pid! })).processes[0];
    assert.ok(original?.start_identity, `pid=${target.pid} exit=${target.exitCode}: ${errors}`);
    const client = await promisify(execFile)(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures/restart-client.ts'), String(original.pid), original.name, original.start_identity, 'ctrl-q']);
    let status = JSON.parse(client.stdout);
    for (let i = 0; i < 60 && !['restarted', 'failed'].includes(String(status.state)); i++) {
      await new Promise(r => setTimeout(r, 1000));
      status = await restartStatus(String(status.id));
    }
    assert.equal(status.state, 'restarted', JSON.stringify(status));
    restarted = Number(status.new_pid);
    assert.ok(restarted > 0 && restarted !== target.pid);
    const line = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${restarted}").CommandLine`]);
    assert.match(line.stdout, /nexus-restart-check/);
  } finally {
    for (const pid of [target.pid, restarted]) if (pid) { try { process.kill(pid); } catch {} }
  }
});
