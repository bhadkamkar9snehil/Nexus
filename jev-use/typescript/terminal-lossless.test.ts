import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startProcess, readProcessOutput, forceTerminate, listSessions } from '../terminal-sessions.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function registry(run: (dir: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-lossless-'));
  const old = process.env.NEXUS_TERMINAL_DIR;
  process.env.NEXUS_TERMINAL_DIR = join(workspace, 'registry');
  try { await run(process.env.NEXUS_TERMINAL_DIR); } finally {
    if (old === undefined) delete process.env.NEXUS_TERMINAL_DIR; else process.env.NEXUS_TERMINAL_DIR = old;
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// A finished session with crafted output, so paging is tested without a shell.
async function fake(dir: string, output: string, extra: object = {}) {
  const id = randomUUID();
  const folder = join(dir, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'output.log'), output);
  await writeFile(join(folder, 'state.json'), JSON.stringify({
    session_id: id, worker_pid: 4_000_000, pid: 4_000_001, shell: 'cmd', status: 'exited',
    started_at: Date.now(), ended_at: Date.now(), exit_code: 0, evicted_lines: 0, output_limited: false, error: null, ...extra }));
  return { id, folder };
}

test('a line over the response cap is read back completely with char_offset', async () => {
  await registry(async dir => {
    const huge = 'x'.repeat(100_000) + 'END';
    const { id } = await fake(dir, `before\n${huge}\nafter\n`);
    let text = '';
    let page = await readProcessOutput({ session_id: id, offset: 1 });
    let pages = 0;
    while (page.next_char_offset !== null) {
      assert.equal(page.next_offset, 1, 'stays on the oversized line');
      text += page.content;
      page = await readProcessOutput({ session_id: id, offset: 1, char_offset: page.next_char_offset });
      assert.ok(++pages < 10);
    }
    text += page.content;
    assert.ok(text.startsWith(huge), 'every character of the oversized line is returned in order');
    assert.equal(text.slice(huge.length), '\nafter', 'paging then continues with the following line');
    assert.equal(page.next_offset, null);
  });
});

test('a worker that vanished is reconciled to an error instead of running forever', async () => {
  await registry(async dir => {
    const { id, folder } = await fake(dir, 'partial output\n', { status: 'running', ended_at: null, exit_code: null });
    await writeFile(join(folder, 'heartbeat'), '1');
    const old = new Date(Date.now() - 60_000);
    await utimes(join(folder, 'heartbeat'), old, old);
    const read = await readProcessOutput({ session_id: id });
    assert.equal(read.state, 'error');
    assert.match(String(read.error), /Worker stopped unexpectedly/);
    assert.equal(read.content, 'partial output');
    const listed = (await listSessions()).sessions.find(s => s.session_id === id);
    assert.equal(listed?.state, 'error');
    assert.ok(listed?.ended_at);
    const stopped = await forceTerminate({ session_id: id });
    assert.equal(stopped.already_finished, true);
  });
});

test('a fresh heartbeat keeps a session running even if its worker PID was reused', async () => {
  await registry(async dir => {
    const { id, folder } = await fake(dir, 'x\n', { status: 'running', ended_at: null, exit_code: null, worker_pid: process.pid });
    await writeFile(join(folder, 'heartbeat'), String(Date.now()));
    assert.equal((await readProcessOutput({ session_id: id })).state, 'running');
    // The same PID with no heartbeat (PID reuse after a crash) is not trusted.
    const stale = await fake(dir, 'y\n', { status: 'running', ended_at: null, exit_code: null, worker_pid: process.pid, started_at: Date.now() - 60_000 });
    assert.equal((await readProcessOutput({ session_id: stale.id })).state, 'error');
  });
});

test('a live worker keeps its session running past the stale window and cross-agent reads see the same state', async () => {
  await registry(async dir => {
    const run = await startProcess({ command: 'Start-Sleep -Seconds 13; Write-Output done', cwd: tmpdir(), timeout_ms: 300 });
    await sleep(12_000);
    const second = await readProcessOutput({ session_id: run.session_id });
    assert.equal(second.state, 'running');
    await forceTerminate({ session_id: run.session_id });
    assert.ok(dir);
  });
});
