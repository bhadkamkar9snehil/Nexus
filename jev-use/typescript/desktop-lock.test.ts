import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDesktopLock } from '../desktop-lock.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('desktop lock admits one task, names the holder, and releases afterwards', async () => {
  process.env.NEXUS_LOCK_DIR = await mkdtemp(join(tmpdir(), 'nexus-lock-'));
  let release!: () => void;
  const first = withDesktopLock('jev_desktop Notepad', () => new Promise<string>(resolve => { release = () => resolve('first'); }));
  await sleep(100);
  await assert.rejects(withDesktopLock('jev_desktop Calc', async () => 'second'), /in use by another agent \(jev_desktop Notepad/);
  release();
  assert.equal(await first, 'first');
  assert.equal(await withDesktopLock('jev_desktop Calc', async () => 'third'), 'third');
  await assert.rejects(access(join(process.env.NEXUS_LOCK_DIR, 'desktop.lock')), 'lock file removed after release');
});

test('a lock left by a crashed holder is taken over, and a failing task still releases', async () => {
  process.env.NEXUS_LOCK_DIR = await mkdtemp(join(tmpdir(), 'nexus-lock-'));
  const file = join(process.env.NEXUS_LOCK_DIR, 'desktop.lock');
  await writeFile(file, JSON.stringify({ owner: 'dead', pid: 1, since: 1 }));
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
  assert.equal(await withDesktopLock('jev_desktop A', async () => 'ok'), 'ok');
  await assert.rejects(withDesktopLock('jev_desktop B', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withDesktopLock('jev_desktop C', async () => 'again'), 'again');
});
